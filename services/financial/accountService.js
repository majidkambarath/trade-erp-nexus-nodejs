const { Voucher, LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Transaction = require("../../models/modules/transactionModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class AccountService {
  static STATUS_RULES = {
    0: "pending",
    0.01: "partial",
    1: "paid",
  };

  static generateVoucherNo(type) {
    const prefixes = { purchase: "PURV", sale: "SALV" };
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
    return `${prefixes[type]}-${dateStr}-${sequence}`;
  }

  static async createAccountVoucher(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const {
        voucherType,
        date = new Date(),
        partyId,
        narration,
        invoiceBalances = [],
        paidAmount = 0,
        requiresApproval = false,
        attachments = [],
        voucherIds = [],
      } = data;

      if (!["purchase", "sale"].includes(voucherType)) {
        throw new AppError("Voucher type must be 'purchase' or 'sale'", 400);
      }
      if (!partyId) {
        throw new AppError(`${voucherType === "purchase" ? "Vendor" : "Customer"} is required`, 400);
      }
      if (invoiceBalances.length === 0) {
        throw new AppError("Invoice allocations are required", 400);
      }

      const isPurchase = voucherType === "purchase";
      const PartyModel = isPurchase ? Vendor : Customer;
      const party = await PartyModel.findById(partyId).session(session);
      if (!party) {
        throw new AppError(`${isPurchase ? "Vendor" : "Customer"} not found`, 404);
      }

      const refreshedOldVouchers = await this.refreshVoucherStatusAndInvoices(
        voucherIds,
        invoiceBalances,
        partyId,
        isPurchase ? "Vendor" : "Customer",
        session
      );

      const { validatedInvoices, totalAllocated } = await this.validateAndAllocateInvoices(
        invoiceBalances,
        partyId,
        isPurchase ? "Vendor" : "Customer",
        paidAmount,
        session
      );

      const entries = await this.generateAccountingEntries(
        isPurchase,
        totalAllocated,
        party,
        partyId,
        validatedInvoices,
        session
      );

      const voucherDoc = {
        voucherNo: this.generateVoucherNo(voucherType),
        voucherType,
        date,
        partyId,
        partyType: isPurchase ? "Vendor" : "Customer",
        partyName: isPurchase ? party.vendorName : party.customerName,
        linkedInvoices: validatedInvoices,
        totalAmount: totalAllocated,
        narration,
        entries,
        status: requiresApproval ? "pending" : this.determineVoucherStatus(validatedInvoices),
        createdBy,
        attachments,
      };

      const [newVoucher] = await Voucher.create([voucherDoc], { session });

      if (newVoucher.status === "approved") {
        await this.createLedgerEntries(newVoucher, createdBy, session);
      }

      await session.commitTransaction();

      return {
        voucher: this.formatVoucherResponse(newVoucher),
        paymentSummary: {
          totalPaid: totalAllocated,
          totalAllocated,
          invoicesUpdated: validatedInvoices.length,
          oldVouchersRefreshed: refreshedOldVouchers.length,
          refreshedVouchers: refreshedOldVouchers,
          breakdown: validatedInvoices.map((inv) => ({
            transactionNo: inv.transactionNo,
            previousBalance: inv.previousBalance,
            amountPaid: inv.allocatedAmount,
            newBalance: inv.newBalance,
            status: inv.newBalance === 0 ? "PAID" : "PARTIAL",
          })),
        },
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static determineVoucherStatus(invoices) {
    const totalInvoices = invoices.length;
    const fullyPaidCount = invoices.filter((inv) => inv.newBalance === 0).length;
    const paidRatio = totalInvoices === 0 ? 0 : fullyPaidCount / totalInvoices;
    return paidRatio === 0 ? this.STATUS_RULES[0] : paidRatio === 1 ? this.STATUS_RULES[1] : this.STATUS_RULES[0.01];
  }

  static async refreshVoucherStatusAndInvoices(oldVoucherIds, newPayments, partyId, partyType, session) {
    if (!oldVoucherIds?.length) return [];

    const refreshed = [];
    const invoiceUpdateMap = {};

    for (const pay of newPayments) {
      const allocatedNow = parseFloat(pay.balanceAmount);
      if (isNaN(allocatedNow) || allocatedNow < 0) {
        throw new AppError(`Invalid allocation amount for ${pay.transactionNo}: ${pay.balanceAmount}`, 400);
      }
      if (allocatedNow === 0) continue;

      const invoice = await Transaction.findById(pay.invoiceId).session(session);
      if (!invoice) {
        console.warn(`Invoice ${pay.transactionNo} not found`);
        continue;
      }

      const curOutstanding = invoice.outstandingAmount ?? invoice.totalAmount - (invoice.paidAmount || 0);
      const newBalance = Math.max(0, curOutstanding - allocatedNow);

      invoiceUpdateMap[pay.invoiceId] = {
        allocatedNow,
        newBalance,
        transactionNo: pay.transactionNo,
      };
    }

    for (const oldId of oldVoucherIds) {
      const oldVoucher = await Voucher.findById(oldId).session(session);
      if (!oldVoucher) {
        console.warn(`Voucher ${oldId} not found`);
        continue;
      }

      let anyFieldChanged = false;
      let fullyPaidCount = 0;
      const totalInvoices = oldVoucher.linkedInvoices?.length ?? 0;

      for (const linked of oldVoucher.linkedInvoices || []) {
        const upd = invoiceUpdateMap[linked.invoiceId.toString()];
        if (!upd) continue;

        if (linked.newBalance !== upd.newBalance) {
          linked.newBalance = upd.newBalance;
          anyFieldChanged = true;
        }
        linked.allocatedAmount = (linked.allocatedAmount || 0) + upd.allocatedNow;
        anyFieldChanged = true;

        if (upd.newBalance === 0) fullyPaidCount++;
      }

      const paidRatio = totalInvoices === 0 ? 0 : fullyPaidCount / totalInvoices;
      const newStatus = paidRatio === 0 ? this.STATUS_RULES[0] : paidRatio === 1 ? this.STATUS_RULES[1] : this.STATUS_RULES[0.01];
      const statusChanged = newStatus !== oldVoucher.status;

      if (statusChanged || anyFieldChanged) {
        if (statusChanged) oldVoucher.status = newStatus;
        oldVoucher.updatedAt = new Date();
        await oldVoucher.save({ session });
        refreshed.push({
          voucherId: oldVoucher._id,
          voucherNo: oldVoucher.voucherNo,
          oldStatus: oldVoucher.status,
          newStatus,
          fieldsChanged: anyFieldChanged,
        });
      }
    }

    return refreshed;
  }

  static async validateAndAllocateInvoices(invoiceBalances, partyId, partyType, paidAmount, session) {
    const validatedInvoices = [];
    let totalAllocated = 0;
    const errors = [];

    for (const inv of invoiceBalances) {
      const { invoiceId, balanceAmount, transactionNo } = inv;
      const allocated = parseFloat(balanceAmount);

      if (isNaN(allocated) || allocated < 0) {
        errors.push(`Invalid allocation amount for ${transactionNo}: ${balanceAmount}`);
        continue;
      }
      if (allocated === 0) continue;

      const invoice = await Transaction.findById(invoiceId).session(session);
      if (!invoice) {
        errors.push(`Invoice ${transactionNo} not found`);
        continue;
      }
      if (invoice.partyId.toString() !== partyId.toString() || invoice.partyType !== partyType) {
        errors.push(`Invoice ${transactionNo} does not belong to this ${partyType}`);
        continue;
      }

      let curOut = invoice.outstandingAmount ?? invoice.totalAmount - (invoice.paidAmount || 0);
      if (allocated > curOut) {
        errors.push(`Allocation for ${transactionNo} (${allocated}) exceeds outstanding (${curOut})`);
        continue;
      }

      const newBal = curOut - allocated;
      invoice.paidAmount = (invoice.paidAmount || 0) + allocated;
      invoice.outstandingAmount = newBal;
      invoice.status = newBal === 0 ? "PAID" : invoice.paidAmount > 0 ? "PARTIAL" : "UNPAID";
      await invoice.save({ session });

      validatedInvoices.push({
        invoiceId: invoice._id,
        allocatedAmount: allocated,
        previousBalance: curOut,
        newBalance: newBal,
        transactionNo,
      });
      totalAllocated += allocated;
    }

    if (errors.length > 0) {
      throw new AppError(`Validation errors: ${errors.join("; ")}`, 400);
    }
    if (!validatedInvoices.length) {
      throw new AppError("No valid invoice allocations found", 400);
    }
    if (Math.abs(totalAllocated - paidAmount) > 0.01) {
      console.warn(`Paid amount (${paidAmount}) does not match total allocated (${totalAllocated}). Details: ${JSON.stringify(validatedInvoices.map(inv => ({ transactionNo: inv.transactionNo, allocated: inv.allocatedAmount })))}`);
    }

    return { validatedInvoices, totalAllocated };
  }

  static async generateAccountingEntries(isPurchase, paidAmount, party, partyId, linkedInvoices, session) {
    const entries = [];
    const invoiceNos = linkedInvoices.map(inv => inv.transactionNo).join(", ");

    if (isPurchase) {
      const vendorAccount = await this.getOrCreateVendorAccount(partyId, party.vendorName, session);
      entries.push({
        accountId: vendorAccount._id,
        accountName: vendorAccount.accountName,
        debitAmount: paidAmount,
        creditAmount: 0,
        description: `Payment to ${party.vendorName} for ${invoiceNos}`,
      });

      const cashAccount = await this.getDefaultCashAccount(session);
      entries.push({
        accountId: cashAccount._id,
        accountName: cashAccount.accountName,
        debitAmount: 0,
        creditAmount: paidAmount,
        description: `Payment made for ${invoiceNos}`,
      });
    } else {
      const cashAccount = await this.getDefaultCashAccount(session);
      entries.push({
        accountId: cashAccount._id,
        accountName: cashAccount.accountName,
        debitAmount: paidAmount,
        creditAmount: 0,
        description: `Payment received for ${invoiceNos}`,
      });

      const customerAccount = await this.getOrCreateCustomerAccount(partyId, party.customerName, session);
      entries.push({
        accountId: customerAccount._id,
        accountName: customerAccount.accountName,
        debitAmount: 0,
        creditAmount: paidAmount,
        description: `Payment from ${party.customerName} for ${invoiceNos}`,
      });
    }

    return entries;
  }

  static async getDefaultCashAccount(session) {
    let account = await LedgerAccount.findOne({ $or: [{ accountCode: "CASH001" }, { accountName: "Cash" }], isActive: true }).session(session);
    if (!account) {
      try {
        [account] = await LedgerAccount.create([{
          accountCode: "CASH001",
          accountName: "Cash",
          accountType: "asset",
          subType: "current_asset",
          allowDirectPosting: true,
          isSystemAccount: true,
          createdBy: new mongoose.Types.ObjectId(),
        }], { session });
      } catch (error) {
        if (error.code === 11000) {
          account = await LedgerAccount.findOne({ accountCode: "CASH001" }).session(session);
          if (!account) throw error;
        } else throw error;
      }
    }
    return account;
  }

  static async getOrCreateVendorAccount(vendorId, vendorName, session) {
    const accountName = `Vendor - ${vendorName}`;
    const accountCode = `VEND${vendorId.toString().slice(-6)}`;
    let account = await LedgerAccount.findOne({ $or: [{ accountCode }, { accountName, accountType: "liability" }] }).session(session);

    if (!account) {
      try {
        [account] = await LedgerAccount.create([{
          accountCode,
          accountName,
          accountType: "liability",
          subType: "current_liability",
          allowDirectPosting: true,
          description: `Payables to ${vendorName}`,
          createdBy: new mongoose.Types.ObjectId(),
        }], { session });
      } catch (error) {
        if (error.code === 11000) {
          account = await LedgerAccount.findOne({ $or: [{ accountCode }, { accountName }] }).session(session);
          if (!account) throw error;
        } else throw error;
      }
    }
    return account;
  }

  static async getOrCreateCustomerAccount(customerId, customerName, session) {
    const accountName = `Customer - ${customerName}`;
    const accountCode = `CUST${customerId.toString().slice(-6)}`;
    let account = await LedgerAccount.findOne({ $or: [{ accountCode }, { accountName, accountType: "asset" }] }).session(session);

    if (!account) {
      try {
        [account] = await LedgerAccount.create([{
          accountCode,
          accountName,
          accountType: "asset",
          subType: "current_asset",
          allowDirectPosting: true,
          description: `Receivables from ${customerName}`,
          createdBy: new mongoose.Types.ObjectId(),
        }], { session });
      } catch (error) {
        if (error.code === 11000) {
          account = await LedgerAccount.findOne({ $or: [{ accountCode }, { accountName }] }).session(session);
          if (!account) throw error;
        } else throw error;
      }
    }
    return account;
  }

  static async createLedgerEntries(voucher, createdBy, session) {
    const ledgerEntries = voucher.entries.map((entry) => ({
      voucherId: voucher._id,
      voucherNo: voucher.voucherNo,
      voucherType: voucher.voucherType,
      accountId: entry.accountId,
      accountName: entry.accountName,
      date: voucher.date,
      debitAmount: entry.debitAmount,
      creditAmount: entry.creditAmount,
      narration: entry.description || voucher.narration,
      partyId: voucher.partyId,
      partyType: voucher.partyType,
      createdBy,
    }));

    await LedgerEntry.insertMany(ledgerEntries, { session });

    for (const entry of voucher.entries) {
      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance += ["asset", "expense"].includes(account.accountType) ? netChange : -netChange;
        await account.save({ session });
      }
    }
  }

  static async getAllAccountVouchers(filters = {}) {
    const query = { voucherType: { $in: ["purchase", "sale"] } };
    if (filters.voucherType) query.voucherType = filters.voucherType;
    if (filters.status) query.status = filters.status;
    if (filters.partyId) query.partyId = filters.partyId;
    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) query.date.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.date.$lte = new Date(filters.dateTo);
    }

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const vouchers = await Voucher.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "name username")
      .populate("partyId", "vendorName customerName")
      .populate("linkedInvoices.invoiceId");

    const total = await Voucher.countDocuments(query);

    return {
      vouchers: vouchers.map(v => this.formatVoucherResponse(v)),
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  }

  static async getAccountVoucherById(id) {
    const voucher = await Voucher.findById(id)
      .populate("createdBy", "name username")
      .populate("partyId", "vendorName customerName")
      .populate("linkedInvoices.invoiceId")
      .populate("entries.accountId", "accountName accountCode accountType");

    if (!voucher || !["purchase", "sale"].includes(voucher.voucherType)) {
      throw new AppError("Account voucher not found", 404);
    }

    const ledgerEntries = await LedgerEntry.find({ voucherId: id })
      .populate("accountId", "accountName accountCode")
      .sort({ createdAt: 1 });

    return {
      voucher: this.formatVoucherResponse(voucher),
      ledgerEntries,
    };
  }

  static async updateAccountVoucher(id, data, updatedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher || !["purchase", "sale"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (voucher.status === "approved" && !data.forceUpdate) {
        throw new AppError("Cannot update approved voucher without forceUpdate flag", 400);
      }

      if (data.invoiceBalances || data.paidAmount) {
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);

        const isPurchase = voucher.voucherType === "purchase";
        const PartyModel = isPurchase ? Vendor : Customer;
        const party = await PartyModel.findById(data.partyId || voucher.partyId).session(session);

        const { validatedInvoices, totalAllocated } = await this.validateAndAllocateInvoices(
          data.invoiceBalances || voucher.linkedInvoices.map(inv => ({
            invoiceId: inv.invoiceId,
            balanceAmount: inv.previousBalance - inv.allocatedAmount,
            transactionNo: inv.transactionNo || 'Unknown'
          })),
          data.partyId || voucher.partyId,
          isPurchase ? "Vendor" : "Customer",
          data.paidAmount || voucher.totalAmount,
          session
        );

        const entries = await this.generateAccountingEntries(
          isPurchase,
          totalAllocated,
          party,
          data.partyId || voucher.partyId,
          validatedInvoices,
          session
        );

        voucher.linkedInvoices = validatedInvoices;
        voucher.entries = entries;
        voucher.totalAmount = totalAllocated;
        voucher.status = this.determineVoucherStatus(validatedInvoices);
      }

      if (data.date) voucher.date = data.date;
      if (data.narration) voucher.narration = data.narration;
      if (data.attachments) voucher.attachments.push(...data.attachments);
      
      voucher.updatedBy = updatedBy;
      await voucher.save({ session });

      if (voucher.status === "approved") {
        await this.createLedgerEntries(voucher, updatedBy, session);
      }

      await session.commitTransaction();
      
      return {
        voucher: this.formatVoucherResponse(voucher),
        message: "Voucher updated successfully"
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deleteAccountVoucher(id, deletedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher || !["purchase", "sale"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (voucher.status === "approved") {
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);
      }

      voucher.status = "cancelled";
      voucher.updatedBy = deletedBy;
      await voucher.save({ session });

      await session.commitTransaction();
      return { message: "Account voucher cancelled successfully" };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async processAccountVoucherApproval(id, action, approvedBy, comments) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher || !["purchase", "sale"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (!["pending", "draft"].includes(voucher.status)) {
        throw new AppError("Voucher cannot be approved/rejected in current state", 400);
      }

      voucher.status = action === "approve" ? "approved" : "rejected";
      voucher.approvalStatus = action === "approve" ? "approved" : "rejected";
      voucher.approvedBy = approvedBy;
      voucher.approvedAt = new Date();

      if (comments) {
        voucher.notes = `${voucher.notes || ""}\nApproval Comments: ${comments}`;
      }

      await voucher.save({ session });

      if (action === "approve") {
        const existing = await LedgerEntry.findOne({ voucherId: id }).session(session);
        if (!existing) {
          await this.createLedgerEntries(voucher, approvedBy, session);
        }
      }

      await session.commitTransaction();
      
      return {
        voucher: this.formatVoucherResponse(voucher),
        message: `Voucher ${action}d successfully`
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async reverseLedgerEntries(voucherId, session) {
    const entries = await LedgerEntry.find({ voucherId }).session(session);

    for (const entry of entries) {
      await LedgerEntry.create([{
        ...entry.toObject(),
        _id: undefined,
        debitAmount: entry.creditAmount,
        creditAmount: entry.debitAmount,
        narration: `Reversal: ${entry.narration}`,
        createdAt: new Date(),
      }], { session });

      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (account) {
        const originalNetChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance += ["asset", "expense"].includes(account.accountType) 
          ? -originalNetChange 
          : originalNetChange;
        await account.save({ session });
      }
    }

    await LedgerEntry.updateMany(
      { voucherId },
      { $set: { isReversed: true, reversedAt: new Date() } },
      { session }
    );
  }

  static async reverseAllocations(voucher, session) {
    for (const linked of voucher.linkedInvoices || []) {
      const invoice = await Transaction.findById(linked.invoiceId).session(session);
      if (invoice) {
        invoice.paidAmount = Math.max(0, (invoice.paidAmount || 0) - linked.allocatedAmount);
        invoice.outstandingAmount = Math.min(
          invoice.totalAmount,
          (invoice.outstandingAmount || 0) + linked.allocatedAmount
        );
        invoice.status = (invoice.outstandingAmount || 0) === invoice.totalAmount ? "UNPAID"
          : (invoice.outstandingAmount || 0) === 0 ? "PAID" : "PARTIAL";
        await invoice.save({ session });
      }
    }
  }

  static formatVoucherResponse(voucher) {
    return {
      ...voucher.toObject(),
      linkedInvoices: voucher.linkedInvoices.map(inv => ({
        invoiceId: inv.invoiceId,
        allocatedAmount: inv.allocatedAmount,
        previousBalance: inv.previousBalance,
        newBalance: inv.newBalance,
        transactionNo: inv.transactionNo,
        status: inv.newBalance === 0 ? 'PAID' : 'PARTIAL'
      })),
    };
  }
}

module.exports = AccountService;