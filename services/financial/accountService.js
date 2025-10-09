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

  static PAYMENT_VOUCHER_STATUS = {
    SETTLED: "settled",
    PENDING: "pending",
    DRAFT: "draft",
    APPROVED: "approved",
    REJECTED: "rejected",
    CANCELLED: "cancelled",
  };

  static generateVoucherNo(type) {
    const prefixes = { purchase: "PURV", sale: "SALV", receipt: "RECV", payment: "PAYV", journal: "JRNL", contra: "CNTR", expense: "EXPV" };
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
    return `${prefixes[type] || "VOU"}-${dateStr}-${sequence}`;
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
        paymentMode = null,
        referenceType = "manual",
        referenceNo = null,
        onAccountAmount = 0,
      } = data;

      // Validation
      if (!["purchase", "sale", "receipt", "payment"].includes(voucherType)) {
        throw new AppError("Invalid voucher type", 400);
      }
      if (["purchase", "sale", "receipt", "payment"].includes(voucherType) && !partyId) {
        throw new AppError(`${voucherType === "purchase" || voucherType === "payment" ? "Vendor" : "Customer"} is required`, 400);
      }

      const isPurchaseOrPayment = ["purchase", "payment"].includes(voucherType);
      const PartyModel = isPurchaseOrPayment ? Vendor : Customer;
      let party = null;
      if (partyId) {
        party = await PartyModel.findById(partyId).session(session);
        if (!party) {
          throw new AppError(`${isPurchaseOrPayment ? "Vendor" : "Customer"} not found`, 404);
        }
      }

      // Step 1: Update old vouchers based on new payment
      const refreshedOldVouchers = await this.refreshVoucherStatusAndInvoices(
        voucherIds,
        invoiceBalances,
        partyId,
        isPurchaseOrPayment ? "Vendor" : "Customer",
        session
      );

      // Step 2: Validate and allocate invoices, update transaction status
      const { validatedInvoices, totalAllocated } = await this.validateAndAllocateInvoices(
        invoiceBalances,
        partyId,
        isPurchaseOrPayment ? "Vendor" : "Customer",
        paidAmount,
        session
      );

      // Check if this is an on-account payment (no invoice allocation)
      const isOnAccountPayment = !invoiceBalances || invoiceBalances.length === 0 ||
        invoiceBalances.every(inv => parseFloat(inv.balanceAmount) === 0);

      const effectivePaidAmount = isOnAccountPayment ? (paidAmount || onAccountAmount) : totalAllocated;

      // Step 3: Generate accounting entries (Debit/Credit)
      const entries = await this.generateAccountingEntries(
        isPurchaseOrPayment,
        effectivePaidAmount,
        party,
        partyId,
        validatedInvoices,
        session
      );

      // Step 4: Determine new voucher status
      const newVoucherStatus = requiresApproval
        ? this.PAYMENT_VOUCHER_STATUS.PENDING
        : this.PAYMENT_VOUCHER_STATUS.SETTLED;

      // Get payment mode from old vouchers if not provided
      let effectivePaymentMode = paymentMode;
      if (!effectivePaymentMode && voucherIds && voucherIds.length > 0) {
        const oldVoucher = await Voucher.findById(voucherIds[0]).session(session);
        if (oldVoucher && oldVoucher.paymentMode) {
          effectivePaymentMode = oldVoucher.paymentMode;
        }
      }

      // Collect attachments from old vouchers if any
      let allAttachments = [...attachments];
      if (voucherIds && voucherIds.length > 0) {
        for (const voucherId of voucherIds) {
          const oldVoucher = await Voucher.findById(voucherId).session(session);
          if (oldVoucher && oldVoucher.attachments && oldVoucher.attachments.length > 0) {
            allAttachments = [...allAttachments, ...oldVoucher.attachments];
          }
        }
      }

      // Remove duplicate attachments
      allAttachments = Array.from(new Set(allAttachments.map(JSON.stringify))).map(JSON.parse);

      // Step 5: Create new voucher document
      const voucherDoc = {
        voucherNo: this.generateVoucherNo(voucherType),
        voucherType,
        date,
        partyId,
        partyType: isPurchaseOrPayment ? "Vendor" : "Customer",
        partyName: party ? (isPurchaseOrPayment ? party.vendorName : party.customerName) : null,
        linkedInvoices: validatedInvoices.length > 0 ? validatedInvoices : [],
        onAccountAmount: isOnAccountPayment ? effectivePaidAmount : 0,
        totalAmount: effectivePaidAmount,
        narration: narration || `Payment ${isPurchaseOrPayment ? 'to' : 'from'} ${party ? (isPurchaseOrPayment ? party.vendorName : party.customerName) : 'party'}`,
        entries,
        status: newVoucherStatus,
        approvalStatus: requiresApproval ? "pending" : "approved",
        paymentMode: effectivePaymentMode,
        referenceType: referenceType || "manual",
        referenceNo,
        createdBy,
        attachments: allAttachments,
        month: new Date(date).getMonth() + 1,
        year: new Date(date).getFullYear(),
        financialYear: this.getFinancialYear(new Date(date)),
      };

      const [newVoucher] = await Voucher.create([voucherDoc], { session });

      // Step 6: Create ledger entries if voucher is settled/approved
      if (newVoucher.status === this.PAYMENT_VOUCHER_STATUS.SETTLED ||
          newVoucher.status === this.PAYMENT_VOUCHER_STATUS.APPROVED) {
        await this.createLedgerEntries(newVoucher, createdBy, session);
      }

      await session.commitTransaction();

      return {
        voucher: this.formatVoucherResponse(newVoucher),
        paymentSummary: {
          totalPaid: effectivePaidAmount,
          totalAllocated: totalAllocated,
          onAccountAmount: isOnAccountPayment ? effectivePaidAmount : 0,
          invoicesUpdated: validatedInvoices.length,
          oldVouchersRefreshed: refreshedOldVouchers.length,
          refreshedVouchers: refreshedOldVouchers,
          isOnAccountPayment,
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
    if (!invoices || invoices.length === 0) {
      return this.STATUS_RULES[0]; // pending
    }

    const totalInvoices = invoices.length;
    const fullyPaidCount = invoices.filter((inv) => inv.newBalance === 0).length;

    if (fullyPaidCount === 0) {
      return this.STATUS_RULES[0]; // pending
    } else if (fullyPaidCount === totalInvoices) {
      return this.STATUS_RULES[1]; // paid
    } else {
      return this.STATUS_RULES[0.01]; // partial
    }
  }

  static async refreshVoucherStatusAndInvoices(oldVoucherIds, newPayments, partyId, partyType, session) {
    if (!oldVoucherIds?.length) return [];

    const refreshed = [];
    const invoiceUpdateMap = new Map();

    for (const pay of newPayments) {
      const allocatedNow = parseFloat(pay.balanceAmount);
      if (isNaN(allocatedNow) || allocatedNow < 0) {
        throw new AppError(`Invalid allocation amount for ${pay.transactionNo}: ${pay.balanceAmount}`, 400);
      }
      if (allocatedNow === 0) continue;

      const invoice = await Transaction.findById(pay.invoiceId).session(session);
      if (!invoice) {
        console.warn(`Invoice ${pay.transactionNo} not found during voucher refresh`);
        continue;
      }

      const curOutstanding = invoice.outstandingAmount ?? (invoice.totalAmount - (invoice.paidAmount || 0));
      const newBalance = Math.max(0, curOutstanding - allocatedNow);

      invoiceUpdateMap.set(pay.invoiceId.toString(), {
        allocatedNow,
        newBalance,
        transactionNo: pay.transactionNo,
      });
    }

    for (const oldId of oldVoucherIds) {
      const oldVoucher = await Voucher.findById(oldId).session(session);
      if (!oldVoucher) {
        console.warn(`Voucher ${oldId} not found during refresh`);
        continue;
      }

      let anyFieldChanged = false;
      let fullyPaidCount = 0;
      const totalInvoices = oldVoucher.linkedInvoices?.length ?? 0;

      for (const linked of oldVoucher.linkedInvoices || []) {
        const upd = invoiceUpdateMap.get(linked.invoiceId.toString());
        if (!upd) {
          if (linked.newBalance === 0) {
            fullyPaidCount++;
          }
          continue;
        }

        const oldBalance = linked.newBalance;
        linked.newBalance = upd.newBalance;

        if (oldBalance !== linked.newBalance) {
          anyFieldChanged = true;
        }

        if (linked.newBalance === 0) {
          fullyPaidCount++;
        }
      }

      const paidRatio = totalInvoices === 0 ? 0 : fullyPaidCount / totalInvoices;
      let newStatus;

      if (paidRatio === 0) {
        newStatus = this.STATUS_RULES[0]; // "pending"
      } else if (paidRatio === 1) {
        newStatus = this.STATUS_RULES[1]; // "paid"
      } else {
        newStatus = this.STATUS_RULES[0.01]; // "partial"
      }

      const statusChanged = newStatus !== oldVoucher.status;

      if (statusChanged || anyFieldChanged) {
        const oldStatus = oldVoucher.status;
        if (statusChanged) {
          oldVoucher.status = newStatus;
        }
        oldVoucher.updatedAt = new Date();
        await oldVoucher.save({ session });

        refreshed.push({
          voucherId: oldVoucher._id,
          voucherNo: oldVoucher.voucherNo,
          referenceNo: oldVoucher.referenceNo,
          oldStatus,
          newStatus,
          statusChanged,
          fieldsChanged: anyFieldChanged,
          fullyPaidInvoices: fullyPaidCount,
          totalInvoices,
        });
      }
    }

    return refreshed;
  }

  static async validateAndAllocateInvoices(invoiceBalances, partyId, partyType, paidAmount, session) {
    const validatedInvoices = [];
    let totalAllocated = 0;
    const errors = [];

    if (!invoiceBalances || invoiceBalances.length === 0) {
      return { validatedInvoices: [], totalAllocated: 0 };
    }

    for (const inv of invoiceBalances) {
      const { invoiceId, balanceAmount, transactionNo } = inv;
      const allocated = parseFloat(balanceAmount);

      if (allocated === 0 || isNaN(allocated)) continue;

      if (allocated < 0) {
        errors.push(`Invalid allocation amount for ${transactionNo}: ${balanceAmount}`);
        continue;
      }

      const invoice = await Transaction.findById(invoiceId).session(session);
      if (!invoice) {
        errors.push(`Invoice ${transactionNo} not found`);
        continue;
      }

      if (invoice.partyId.toString() !== partyId.toString() || invoice.partyType !== partyType) {
        errors.push(`Invoice ${transactionNo} does not belong to this ${partyType}`);
        continue;
      }

      let curOut = invoice.outstandingAmount ?? (invoice.totalAmount - (invoice.paidAmount || 0));

      if (allocated > curOut) {
        errors.push(`Allocation for ${transactionNo} (${allocated}) exceeds outstanding (${curOut})`);
        continue;
      }

      const newBal = curOut - allocated;
      invoice.paidAmount = (invoice.paidAmount || 0) + allocated;
      invoice.outstandingAmount = newBal;

      if (newBal === 0) {
        invoice.status = "PAID";
      } else if (invoice.paidAmount > 0) {
        invoice.status = "PARTIAL";
      } else {
        invoice.status = "UNPAID";
      }

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

    if (validatedInvoices.length > 0 && Math.abs(totalAllocated - paidAmount) > 0.01) {
      console.warn(
        `Paid amount (${paidAmount}) does not match total allocated (${totalAllocated}). ` +
        `Details: ${JSON.stringify(validatedInvoices.map(inv => ({
          transactionNo: inv.transactionNo,
          allocated: inv.allocatedAmount
        })))}`
      );
    }

    return { validatedInvoices, totalAllocated };
  }

  static async generateAccountingEntries(isPurchaseOrPayment, paidAmount, party, partyId, linkedInvoices, session) {
    const entries = [];
    const invoiceNos = linkedInvoices.map(inv => inv.transactionNo).join(", ");

    if (isPurchaseOrPayment) {
      const vendorAccount = await this.getOrCreateVendorAccount(partyId, party?.vendorName || "Vendor", session);
      entries.push({
        accountId: vendorAccount._id,
        accountName: vendorAccount.accountName,
        debitAmount: paidAmount,
        creditAmount: 0,
        description: `Payment to ${party?.vendorName || "Vendor"} for invoices: ${invoiceNos}`,
      });

      const cashAccount = await this.getDefaultCashAccount(session);
      entries.push({
        accountId: cashAccount._id,
        accountName: cashAccount.accountName,
        debitAmount: 0,
        creditAmount: paidAmount,
        description: `Payment made to ${party?.vendorName || "Vendor"} for invoices: ${invoiceNos}`,
      });
    } else {
      const cashAccount = await this.getDefaultCashAccount(session);
      entries.push({
        accountId: cashAccount._id,
        accountName: cashAccount.accountName,
        debitAmount: paidAmount,
        creditAmount: 0,
        description: `Payment received from ${party?.customerName || "Customer"} for invoices: ${invoiceNos}`,
      });

      const customerAccount = await this.getOrCreateCustomerAccount(partyId, party?.customerName || "Customer", session);
      entries.push({
        accountId: customerAccount._id,
        accountName: customerAccount.accountName,
        debitAmount: 0,
        creditAmount: paidAmount,
        description: `Payment from ${party?.customerName || "Customer"} for invoices: ${invoiceNos}`,
      });
    }

    return entries;
  }

  static async getDefaultCashAccount(session) {
    let account = await LedgerAccount.findOne({
      $or: [{ accountCode: "CASH001" }, { accountName: "Cash" }],
      isActive: true
    }).session(session);

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
    let account = await LedgerAccount.findOne({
      $or: [{ accountCode }, { accountName, accountType: "liability" }]
    }).session(session);

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
    let account = await LedgerAccount.findOne({
      $or: [{ accountCode }, { accountName, accountType: "asset" }]
    }).session(session);

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
    const ledgerEntries = await Promise.all(voucher.entries.map(async (entry) => {
      const account = await LedgerAccount.findById(entry.accountId).session(session);
      return {
        voucherId: voucher._id,
        voucherNo: voucher.voucherNo,
        voucherType: voucher.voucherType,
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountCode: account?.accountCode || null,
        date: voucher.date,
        debitAmount: entry.debitAmount,
        creditAmount: entry.creditAmount,
        narration: entry.description || voucher.narration,
        partyId: voucher.partyId,
        partyType: voucher.partyType,
        referenceType: voucher.referenceType,
        referenceNo: voucher.referenceNo,
        createdBy,
      };
    }));

    const createdEntries = await LedgerEntry.insertMany(ledgerEntries, { session });

    for (const entry of createdEntries) {
      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance += ["asset", "expense"].includes(account.accountType)
          ? netChange
          : -netChange;
        await account.save({ session });

        // Update running balance in ledger entry
        entry.runningBalance = account.currentBalance;
        await entry.save({ session });
      }
    }
  }

  static async getAllAccountVouchers(filters = {}) {
    const query = { voucherType: { $in: ["purchase", "sale", "receipt", "payment"] } };
    if (filters.voucherType) query.voucherType = filters.voucherType;
    if (filters.status) query.status = filters.status;
    if (filters.partyId) query.partyId = new mongoose.Types.ObjectId(filters.partyId);
    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) query.date.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.date.$lte = new Date(filters.dateTo);
    }
    if (filters.referenceNo) query.referenceNo = filters.referenceNo;

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

    if (!voucher || !["purchase", "sale", "receipt", "payment"].includes(voucher.voucherType)) {
      throw new AppError("Account voucher not found", 404);
    }

    const ledgerEntries = await LedgerEntry.find({ voucherId: id })
      .populate("accountId", "accountName accountCode")
      .sort({ createdAt: 1 });

    let remainingInvoices = [];
    if (voucher.status === this.PAYMENT_VOUCHER_STATUS.APPROVED && voucher.linkedInvoices?.length > 0) {
      remainingInvoices = await Promise.all(
        voucher.linkedInvoices.map(async (inv) => {
          const invoice = await Transaction.findById(inv.invoiceId).lean();
          if (!invoice) {
            return {
              invoiceId: inv.invoiceId,
              transactionNo: inv.transactionNo || "Unknown",
              status: "NOT_FOUND",
              outstandingAmount: 0,
              allocatedAmount: inv.allocatedAmount,
              previousBalance: inv.previousBalance,
              newBalance: inv.newBalance,
            };
          }
          return {
            invoiceId: inv.invoiceId,
            transactionNo: inv.transactionNo,
            status: invoice.status || (inv.newBalance === 0 ? "PAID" : "PARTIAL"),
            outstandingAmount: invoice.outstandingAmount || (invoice.totalAmount - (invoice.paidAmount || 0)),
            allocatedAmount: inv.allocatedAmount,
            previousBalance: inv.previousBalance,
            newBalance: inv.newBalance,
          };
        })
      );
    }

    return {
      voucher: this.formatVoucherResponse(voucher),
      ledgerEntries,
      remainingInvoices,
    };
  }

  static async getApprovedVouchersWithRemainingInvoices(partyId, partyType, filters = {}) {
    const query = {
      voucherType: { $in: ["purchase", "sale", "receipt", "payment"] },
      status: this.PAYMENT_VOUCHER_STATUS.APPROVED,
      partyId: new mongoose.Types.ObjectId(partyId),
      partyType,
    };

    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) query.date.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.date.$lte = new Date(filters.dateTo);
    }
    if (filters.referenceNo) query.referenceNo = filters.referenceNo;

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

    const formattedVouchers = await Promise.all(
      vouchers.map(async (voucher) => {
        const remainingInvoices = await Promise.all(
          (voucher.linkedInvoices || []).map(async (inv) => {
            const invoice = await Transaction.findById(inv.invoiceId).lean();
            if (!invoice) {
              return {
                invoiceId: inv.invoiceId,
                transactionNo: inv.transactionNo || "Unknown",
                status: "NOT_FOUND",
                outstandingAmount: 0,
                allocatedAmount: inv.allocatedAmount,
                previousBalance: inv.previousBalance,
                newBalance: inv.newBalance,
              };
            }
            return {
              invoiceId: inv.invoiceId,
              transactionNo: inv.transactionNo,
              status: invoice.status || (inv.newBalance === 0 ? "PAID" : "PARTIAL"),
              outstandingAmount: invoice.outstandingAmount || (invoice.totalAmount - (invoice.paidAmount || 0)),
              allocatedAmount: inv.allocatedAmount,
              previousBalance: inv.previousBalance,
              newBalance: inv.newBalance,
            };
          })
        );

        return {
          voucher: this.formatVoucherResponse(voucher),
          remainingInvoices: remainingInvoices.filter(inv => inv.outstandingAmount > 0 || inv.status === "PARTIAL"),
        };
      })
    );

    return {
      vouchers: formattedVouchers,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  }

  static async updateAccountVoucher(id, data, updatedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher || !["purchase", "sale", "receipt", "payment"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (voucher.status === this.PAYMENT_VOUCHER_STATUS.APPROVED && !data.forceUpdate) {
        throw new AppError("Cannot update approved voucher without forceUpdate flag", 400);
      }

      if (data.invoiceBalances || data.paidAmount) {
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);

        const isPurchaseOrPayment = ["purchase", "payment"].includes(voucher.voucherType);
        const PartyModel = isPurchaseOrPayment ? Vendor : Customer;
        const party = await PartyModel.findById(data.partyId || voucher.partyId).session(session);

        const { validatedInvoices, totalAllocated } = await this.validateAndAllocateInvoices(
          data.invoiceBalances || voucher.linkedInvoices.map(inv => ({
            invoiceId: inv.invoiceId,
            balanceAmount: inv.previousBalance - inv.allocatedAmount,
            transactionNo: inv.transactionNo || 'Unknown'
          })),
          data.partyId || voucher.partyId,
          isPurchaseOrPayment ? "Vendor" : "Customer",
          data.paidAmount || voucher.totalAmount,
          session
        );

        const entries = await this.generateAccountingEntries(
          isPurchaseOrPayment,
          totalAllocated,
          party,
          data.partyId || voucher.partyId,
          validatedInvoices,
          session
        );

        voucher.linkedInvoices = validatedInvoices;
        voucher.entries = entries;
        voucher.totalAmount = totalAllocated;
        voucher.status = this.PAYMENT_VOUCHER_STATUS.SETTLED;
      }

      if (data.date) voucher.date = data.date;
      if (data.narration) voucher.narration = data.narration;
      if (data.attachments) voucher.attachments.push(...data.attachments);
      if (data.referenceNo) voucher.referenceNo = data.referenceNo;
      if (data.paymentMode) voucher.paymentMode = data.paymentMode;

      voucher.updatedBy = updatedBy;
      await voucher.save({ session });

      if (voucher.status === this.PAYMENT_VOUCHER_STATUS.SETTLED ||
          voucher.status === this.PAYMENT_VOUCHER_STATUS.APPROVED) {
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
      if (!voucher || !["purchase", "sale", "receipt", "payment"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (voucher.status === this.PAYMENT_VOUCHER_STATUS.SETTLED ||
          voucher.status === this.PAYMENT_VOUCHER_STATUS.APPROVED) {
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);
      }

      voucher.status = this.PAYMENT_VOUCHER_STATUS.CANCELLED;
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
      if (!voucher || !["purchase", "sale", "receipt", "payment"].includes(voucher.voucherType)) {
        throw new AppError("Account voucher not found", 404);
      }

      if (!["pending", "draft"].includes(voucher.status)) {
        throw new AppError("Voucher cannot be approved/rejected in current state", 400);
      }

      voucher.status = action === "approve"
        ? this.PAYMENT_VOUCHER_STATUS.APPROVED
        : this.PAYMENT_VOUCHER_STATUS.REJECTED;
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
        runningBalance: 0, // Will be updated after account balance adjustment
      }], { session });

      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (account) {
        const originalNetChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance += ["asset", "expense"].includes(account.accountType)
          ? -originalNetChange
          : originalNetChange;
        await account.save({ session });

        // Update running balance for the reversal entry
        const reversalEntry = await LedgerEntry.findOne({
          voucherId,
          accountId: entry.accountId,
          createdAt: { $gte: new Date(Date.now() - 1000) }
        }).session(session);
        if (reversalEntry) {
          reversalEntry.runningBalance = account.currentBalance;
          await reversalEntry.save({ session });
        }
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

        if (invoice.outstandingAmount === invoice.totalAmount) {
          invoice.status = "UNPAID";
        } else if (invoice.outstandingAmount === 0) {
          invoice.status = "PAID";
        } else {
          invoice.status = "PARTIAL";
        }

        await invoice.save({ session });
      }
    }
  }

  static formatVoucherResponse(voucher) {
    return {
      ...voucher.toObject(),
      linkedInvoices: voucher.linkedInvoices && voucher.linkedInvoices.length > 0
        ? voucher.linkedInvoices.map(inv => ({
            invoiceId: inv.invoiceId,
            allocatedAmount: inv.allocatedAmount,
            previousBalance: inv.previousBalance,
            newBalance: inv.newBalance,
            transactionNo: inv.transactionNo,
            status: inv.newBalance === 0 ? 'PAID' : 'PARTIAL'
          }))
        : [],
    };
  }

  static getFinancialYear(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return month >= 4 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
  }
}

module.exports = AccountService;