// services/financial/financialService.js
const {
  Voucher,
  LedgerAccount,
  ExpenseCategory,
  LedgerEntry,
} = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class FinancialService {
  // Generate voucher number based on type
  static generateVoucherNo(type) {
    const prefixes = {
      receipt: "RV",
      payment: "PV",
      journal: "JV",
      contra: "CV",
      expense: "EV",
    };

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(
      3,
      "0"
    );
    return `${prefixes[type]}-${dateStr}-${sequence}`;
  }

  // Create any type of voucher
  static async createVoucher(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { voucherType, attachments = [], ...voucherData } = data;

      if (!voucherType) {
        throw new AppError("Voucher type is required", 400);
      }

      const voucherNo = this.generateVoucherNo(voucherType);

      // Validate and process based on voucher type
      let processedData;
      switch (voucherType) {
        case "receipt":
          processedData = await this.processReceiptVoucher(
            voucherData,
            session
          );
          break;
        case "payment":
          processedData = await this.processPaymentVoucher(
            voucherData,
            session
          );
          break;
        case "journal":
          processedData = await this.processJournalVoucher(
            voucherData,
            session
          );
          break;
        case "contra":
          processedData = await this.processContraVoucher(voucherData, session);
          break;
        case "expense":
          processedData = await this.processExpenseVoucher(
            voucherData,
            session
          );
          break;
        default:
          throw new AppError("Invalid voucher type", 400);
      }

      const voucherDoc = {
        voucherNo,
        voucherType,
        createdBy,
        attachments: attachments,
        ...processedData,
      };

      const voucher = await Voucher.create([voucherDoc], { session });
      const newVoucher = voucher[0];

      // Create ledger entries
      await this.createLedgerEntries(newVoucher, createdBy, session);

      await session.commitTransaction();
      return newVoucher;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Process Receipt Voucher
  static async processReceiptVoucher(data, session) {
    const {
      customerId,
      linkedInvoices,
      paymentMode,
      totalAmount,
      narration,
      chequeNo,
      chequeDate,
      bankName,
    } = data;

    if (!customerId) {
      throw new AppError("Customer is required for receipt voucher", 400);
    }

    // Validate customer exists
    const customer = await Customer.findById(customerId).session(session);
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // Validate linked invoices if provided
    let validatedInvoices = [];
    if (linkedInvoices && linkedInvoices.length > 0) {
      // Here you would validate against actual sales invoices
      validatedInvoices = linkedInvoices;
    }

    // Create entries for double-entry accounting
    const entries = [];

    // Debit: Cash/Bank Account (based on payment mode)
    const cashBankAccount = await this.getCashBankAccount(paymentMode, session);
    entries.push({
      accountId: cashBankAccount._id,
      accountName: cashBankAccount.accountName,
      debitAmount: totalAmount,
      creditAmount: 0,
      description: `Receipt from ${customer.customerName}`,
    });

    // Credit: Customer Account (Accounts Receivable)
    const customerAccount = await this.getOrCreateCustomerAccount(
      customerId,
      customer.customerName,
      session
    );
    entries.push({
      accountId: customerAccount._id,
      accountName: customerAccount.accountName,
      debitAmount: 0,
      creditAmount: totalAmount,
      description: `Payment received from ${customer.customerName}`,
    });

    return {
      partyId: customerId,
      partyType: "Customer",
      partyName: customer.customerName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      chequeNo,
      chequeDate,
      bankName,
      totalAmount,
      narration,
      entries,
      status: "approved", // Receipts are typically approved immediately
    };
  }

  // Process Payment Voucher
  static async processPaymentVoucher(data, session) {
    const {
      vendorId,
      linkedInvoices,
      paymentMode,
      totalAmount,
      notes,
      chequeNo,
      chequeDate,
      bankName,
    } = data;

    if (!vendorId) {
      throw new AppError("Vendor is required for payment voucher", 400);
    }

    // Validate vendor exists
    const vendor = await Vendor.findById(vendorId).session(session);
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }

    // Validate linked invoices if provided
    let validatedInvoices = [];
    if (linkedInvoices && linkedInvoices.length > 0) {
      // Here you would validate against actual purchase invoices
      validatedInvoices = linkedInvoices;
    }

    // Create entries for double-entry accounting
    const entries = [];

    // Credit: Cash/Bank Account (based on payment mode)
    const cashBankAccount = await this.getCashBankAccount(paymentMode, session);
    entries.push({
      accountId: cashBankAccount._id,
      accountName: cashBankAccount.accountName,
      debitAmount: 0,
      creditAmount: totalAmount,
      description: `Payment to ${vendor.vendorName}`,
    });

    // Debit: Vendor Account (Accounts Payable)
    const vendorAccount = await this.getOrCreateVendorAccount(
      vendorId,
      vendor.vendorName,
      session
    );
    entries.push({
      accountId: vendorAccount._id,
      accountName: vendorAccount.accountName,
      debitAmount: totalAmount,
      creditAmount: 0,
      description: `Payment made to ${vendor.vendorName}`,
    });

    return {
      partyId: vendorId,
      partyType: "Vendor",
      partyName: vendor.vendorName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      chequeNo,
      chequeDate,
      bankName,
      totalAmount,
      notes,
      entries,
      status: "approved",
    };
  }

  // Process Journal Voucher
  static async processJournalVoucher(data, session) {
    const { entries, narration, totalAmount, date } = data;

    if (!entries || entries.length < 2) {
      throw new AppError("Journal voucher must have at least 2 entries", 400);
    }

    // Validate entries and accounts
    let validatedEntries = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const entry of entries) {
      const account = await LedgerAccount.findById(entry.accountId).session(
        session
      );
      if (!account) {
        throw new AppError(`Account not found: ${entry.accountId}`, 404);
      }

      if (!account.allowDirectPosting) {
        throw new AppError(
          `Direct posting not allowed for account: ${account.accountName}`,
          400
        );
      }

      const validatedEntry = {
        accountId: entry.accountId,
        accountName: account.accountName,
        debitAmount: entry.debitAmount || 0,
        creditAmount: entry.creditAmount || 0,
        description: entry.description || "",
      };

      totalDebits += validatedEntry.debitAmount;
      totalCredits += validatedEntry.creditAmount;
      validatedEntries.push(validatedEntry);
    }

    // Validate balancing
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      throw new AppError("Total debits must equal total credits", 400);
    }

    return {
      totalAmount: totalDebits, // or totalCredits, they should be equal
      narration,
      entries: validatedEntries,
      date,
      status: "draft", // Journal vouchers typically need approval
    };
  }

  // Process Contra Voucher
  static async processContraVoucher(data, session) {
    const { fromAccountId, toAccountId, totalAmount, notes, date } = data;

    if (!fromAccountId || !toAccountId) {
      throw new AppError(
        "From and To accounts are required for contra voucher",
        400
      );
    }

    if (fromAccountId.toString() === toAccountId.toString()) {
      throw new AppError("From and To accounts cannot be the same", 400);
    }

    // Validate accounts exist and are cash/bank accounts
    const fromAccount = await LedgerAccount.findById(fromAccountId).session(
      session
    );
    const toAccount = await LedgerAccount.findById(toAccountId).session(
      session
    );

    if (!fromAccount || !toAccount) {
      throw new AppError("One or both accounts not found", 404);
    }

    // Check if accounts are cash/bank type
    if (
      !this.isCashBankAccount(fromAccount) ||
      !this.isCashBankAccount(toAccount)
    ) {
      throw new AppError(
        "Contra vouchers can only be used between cash/bank accounts",
        400
      );
    }

    // Create entries
    const entries = [
      {
        accountId: toAccountId,
        accountName: toAccount.accountName,
        debitAmount: totalAmount,
        creditAmount: 0,
        description: `Transfer from ${fromAccount.accountName}`,
      },
      {
        accountId: fromAccountId,
        accountName: fromAccount.accountName,
        debitAmount: 0,
        creditAmount: totalAmount,
        description: `Transfer to ${toAccount.accountName}`,
      },
    ];

    return {
      fromAccountId,
      toAccountId,
      totalAmount,
      notes,
      entries,
      date,
      status: "approved", // Contra vouchers are typically approved immediately
    };
  }

  // Process Expense Voucher
  static async processExpenseVoucher(data, session) {
    const { expenseCategoryId, totalAmount, description, submittedBy, date } =
      data;

    if (!expenseCategoryId) {
      throw new AppError("Expense category is required", 400);
    }

    // Validate expense category
    const category = await ExpenseCategory.findById(expenseCategoryId).session(
      session
    );
    if (!category) {
      throw new AppError("Expense category not found", 404);
    }

    // Check budget limits if applicable
    if (category.monthlyBudget > 0) {
      // Here you would check monthly spending against budget
      // This is a simplified version
    }

    // Get default expense account
    let expenseAccount;
    if (category.defaultAccountId) {
      expenseAccount = await LedgerAccount.findById(
        category.defaultAccountId
      ).session(session);
    } else {
      // Find a default expense account
      expenseAccount = await LedgerAccount.findOne({
        accountType: "expense",
        isActive: true,
      }).session(session);
    }

    if (!expenseAccount) {
      throw new AppError("No expense account found for this category", 400);
    }

    // Get cash account (assuming cash expense)
    const cashAccount = await this.getCashBankAccount("cash", session);

    // Create entries
    const entries = [
      {
        accountId: expenseAccount._id,
        accountName: expenseAccount.accountName,
        debitAmount: totalAmount,
        creditAmount: 0,
        description: description,
      },
      {
        accountId: cashAccount._id,
        accountName: cashAccount.accountName,
        debitAmount: 0,
        creditAmount: totalAmount,
        description: `Expense payment - ${category.categoryName}`,
      },
    ];

    // Determine approval status
    const requiresApproval =
      category.requiresApproval &&
      (category.approvalLimit === 0 || totalAmount > category.approvalLimit);

    return {
      expenseCategoryId,
      expenseType: category.categoryName,
      submittedBy,
      totalAmount,
      description,
      entries,
      date,
      status: requiresApproval ? "pending" : "approved",
      approvalStatus: requiresApproval ? "pending" : "approved",
    };
  }

  // Create ledger entries for double-entry accounting
  static async createLedgerEntries(voucher, createdBy, session) {
    const ledgerEntries = [];

    for (const entry of voucher.entries) {
      const ledgerEntry = {
        voucherId: voucher._id,
        voucherNo: voucher.voucherNo,
        voucherType: voucher.voucherType,
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountCode: "", // You might want to populate this from the account
        date: voucher.date,
        debitAmount: entry.debitAmount,
        creditAmount: entry.creditAmount,
        narration: entry.description || voucher.narration,
        partyId: voucher.partyId,
        partyType: voucher.partyType,
        createdBy,
      };

      ledgerEntries.push(ledgerEntry);
    }

    await LedgerEntry.insertMany(ledgerEntries, { session });

    // Update account balances
    await this.updateAccountBalances(voucher.entries, session);
  }

  // Update account balances after posting
  static async updateAccountBalances(entries, session) {
    for (const entry of entries) {
      const account = await LedgerAccount.findById(entry.accountId).session(
        session
      );
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;

        // For asset and expense accounts, debit increases balance
        // For liability, equity, and income accounts, credit increases balance
        if (["asset", "expense"].includes(account.accountType)) {
          account.currentBalance += netChange;
        } else {
          account.currentBalance -= netChange;
        }

        await account.save({ session });
      }
    }
  }

  // Helper method to get cash/bank account based on payment mode
  static async getCashBankAccount(paymentMode, session) {
    let accountName;
    switch (paymentMode) {
      case "cash":
        accountName = "Cash in Hand";
        break;
      case "bank":
      case "cheque":
      case "online":
        accountName = "Bank Account";
        break;
      default:
        accountName = "Cash in Hand";
    }

    let account = await LedgerAccount.findOne({
      accountName,
      isActive: true,
    }).session(session);

    if (!account) {
      // Create default cash account if not exists
      account = await LedgerAccount.create(
        [
          {
            accountCode: paymentMode === "cash" ? "CASH001" : "BANK001",
            accountName,
            accountType: "asset",
            subType: "current_asset",
            allowDirectPosting: true,
            isSystemAccount: true,
            createdBy: new mongoose.Types.ObjectId(), // System user
          },
        ],
        { session }
      );
      account = account[0];
    }

    return account;
  }

  // Helper method to get or create customer account
  static async getOrCreateCustomerAccount(customerId, customerName, session) {
    const accountName = `Customer - ${customerName}`;

    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "asset",
      subType: "current_asset",
    }).session(session);

    if (!account) {
      account = await LedgerAccount.create(
        [
          {
            accountCode: `CUST${customerId.toString().slice(-6)}`,
            accountName,
            accountType: "asset",
            subType: "current_asset",
            allowDirectPosting: true,
            description: `Receivables from ${customerName}`,
            createdBy: new mongoose.Types.ObjectId(),
          },
        ],
        { session }
      );
      account = account[0];
    }

    return account;
  }

  // Helper method to get or create vendor account
  static async getOrCreateVendorAccount(vendorId, vendorName, session) {
    const accountName = `Vendor - ${vendorName}`;

    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "liability",
      subType: "current_liability",
    }).session(session);

    if (!account) {
      account = await LedgerAccount.create(
        [
          {
            accountCode: `VEND${vendorId.toString().slice(-6)}`,
            accountName,
            accountType: "liability",
            subType: "current_liability",
            allowDirectPosting: true,
            description: `Payables to ${vendorName}`,
            createdBy: new mongoose.Types.ObjectId(),
          },
        ],
        { session }
      );
      account = account[0];
    }

    return account;
  }

  // Helper method to check if account is cash/bank type
  static isCashBankAccount(account) {
    const cashBankNames = [
      "Cash in Hand",
      "Bank Account",
      "Petty Cash",
      "Cash at Bank",
    ];
    return (
      cashBankNames.some((name) =>
        account.accountName.toLowerCase().includes(name.toLowerCase())
      ) ||
      (account.accountType === "asset" &&
        account.subType === "current_asset" &&
        (account.accountCode.startsWith("CASH") ||
          account.accountCode.startsWith("BANK")))
    );
  }

  // Get all vouchers with filters and pagination
static async getAllVouchers(filters = {}) {
  const query = {};

  // Apply filters
  if (filters.voucherType) query.voucherType = filters.voucherType;
  if (filters.status) query.status = filters.status;
  if (filters.partyId) query.partyId = filters.partyId;
  if (filters.approvalStatus) query.approvalStatus = filters.approvalStatus;

  // Date filters
  if (filters.dateFrom || filters.dateTo) {
    query.date = {};
    if (filters.dateFrom) query.date.$gte = new Date(filters.dateFrom);
    if (filters.dateTo) query.date.$lte = new Date(filters.dateTo);
  }

  // Search functionality
  if (filters.search) {
    query.$or = [
      { voucherNo: new RegExp(filters.search, "i") },
      { narration: new RegExp(filters.search, "i") },
      { notes: new RegExp(filters.search, "i") },
      { partyName: new RegExp(filters.search, "i") },
    ];
  }

  // Pagination
  const page = parseInt(filters.page) || 1;
  const limit = parseInt(filters.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    console.log("Query:", query);
    const vouchers = await Voucher.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "name username")
      .populate("partyId", "customerName vendorName name")
      .populate("linkedInvoices"); // Simplified for testing

    console.log("Vouchers:", JSON.stringify(vouchers, null, 2));
    const total = await Voucher.countDocuments(query);

    return {
      vouchers,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  } catch (error) {
    console.error("Error in getAllVouchers:", error);
    throw error;
  }
}

  // Get voucher by ID with details
  static async getVoucherById(id) {
    const voucher = await Voucher.findById(id)
      .populate("createdBy", "name username")
      .populate("partyId", "customerName vendorName name email phone")
      .populate("expenseCategoryId", "categoryName description")
      .populate("entries.accountId", "accountName accountCode accountType");

    if (!voucher) {
      throw new AppError("Voucher not found", 404);
    }

    // Get related ledger entries
    const ledgerEntries = await LedgerEntry.find({ voucherId: id })
      .populate("accountId", "accountName accountCode")
      .sort({ createdAt: 1 });

    return {
      voucher,
      ledgerEntries,
    };
  }

  // Update voucher
  static async updateVoucher(id, data, updatedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher) {
        throw new AppError("Voucher not found", 404);
      }

      // Check if voucher can be updated
      if (voucher.status === "approved" && !data.forceUpdate) {
        throw new AppError("Cannot update approved voucher", 400);
      }

      // Handle attachments: merge old + new
      if (data.attachments && data.attachments.length > 0) {
        voucher.attachments = [...voucher.attachments, ...data.attachments];
      }

      // If updating amounts or entries, reverse previous ledger entries
      if (data.totalAmount || data.entries) {
        await this.reverseLedgerEntries(id, session);
      }

      // Update voucher fields (excluding attachments since handled above)
      Object.assign(voucher, { ...data, attachments: voucher.attachments });
      voucher.updatedBy = updatedBy;
      await voucher.save({ session });

      // Recreate ledger entries if needed
      if (data.totalAmount || data.entries) {
        await this.createLedgerEntries(voucher, updatedBy, session);
      }

      await session.commitTransaction();
      return voucher;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Approve/Reject voucher
  static async processVoucherApproval(id, action, approvedBy, comments) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher) {
        throw new AppError("Voucher not found", 404);
      }

      if (!["approve", "reject"].includes(action)) {
        throw new AppError("Invalid action. Use approve or reject", 400);
      }

      if (voucher.status !== "pending" && voucher.status !== "draft") {
        throw new AppError(
          "Voucher is not in a state that can be approved/rejected",
          400
        );
      }

      // Update voucher status
      voucher.status = action === "approve" ? "approved" : "rejected";
      voucher.approvalStatus = action === "approve" ? "approved" : "rejected";
      voucher.approvedBy = approvedBy;
      voucher.approvedAt = new Date();

      if (comments) {
        voucher.notes = `${
          voucher.notes || ""
        }\nApproval Comments: ${comments}`;
      }

      await voucher.save({ session });

      // If approved and no ledger entries exist, create them
      if (action === "approve") {
        const existingEntries = await LedgerEntry.findOne({
          voucherId: id,
        }).session(session);
        if (!existingEntries) {
          await this.createLedgerEntries(voucher, approvedBy, session);
        }
      }

      await session.commitTransaction();
      return voucher;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Delete voucher (reverse entries and mark as cancelled)
  static async deleteVoucher(id, deletedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const voucher = await Voucher.findById(id).session(session);
      if (!voucher) {
        throw new AppError("Voucher not found", 404);
      }

      if (voucher.status === "approved") {
        // Reverse ledger entries
        await this.reverseLedgerEntries(id, session);
      }

      // Mark as cancelled instead of hard delete
      voucher.status = "cancelled";
      voucher.updatedBy = deletedBy;
      await voucher.save({ session });

      await session.commitTransaction();
      return { message: "Voucher cancelled successfully" };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Reverse ledger entries
  static async reverseLedgerEntries(voucherId, session) {
    const entries = await LedgerEntry.find({ voucherId }).session(session);

    for (const entry of entries) {
      // Create reversal entry
      const reversalEntry = {
        ...entry.toObject(),
        _id: undefined,
        debitAmount: entry.creditAmount, // Swap debit and credit
        creditAmount: entry.debitAmount,
        narration: `Reversal: ${entry.narration}`,
        createdAt: new Date(),
      };

      await LedgerEntry.create([reversalEntry], { session });

      // Update account balance
      const account = await LedgerAccount.findById(entry.accountId).session(
        session
      );
      if (account) {
        const originalNetChange = entry.debitAmount - entry.creditAmount;

        if (["asset", "expense"].includes(account.accountType)) {
          account.currentBalance -= originalNetChange;
        } else {
          account.currentBalance += originalNetChange;
        }

        await account.save({ session });
      }
    }

    // Mark original entries as reversed (add a field to track this)
    await LedgerEntry.updateMany(
      { voucherId },
      { $set: { isReversed: true, reversedAt: new Date() } },
      { session }
    );
  }

  // Get financial reports
  static async getFinancialReports(filters = {}) {
    const { reportType, dateFrom, dateTo, accountType } = filters;

    switch (reportType) {
      case "trial_balance":
        return this.getTrialBalance(dateFrom, dateTo);
      case "cash_flow":
        return this.getCashFlowReport(dateFrom, dateTo);
      case "expense_summary":
        return this.getExpenseSummary(dateFrom, dateTo);
      case "party_statement":
        return this.getPartyStatement(
          filters.partyId,
          filters.partyType,
          dateFrom,
          dateTo
        );
      default:
        throw new AppError("Invalid report type", 400);
    }
  }

  // Trial Balance Report
  static async getTrialBalance(dateFrom, dateTo) {
    const matchConditions = {};
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo)
      matchConditions.date = {
        ...matchConditions.date,
        $lte: new Date(dateTo),
      };

    const trialBalance = await LedgerEntry.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: "$accountId",
          accountName: { $first: "$accountName" },
          accountCode: { $first: "$accountCode" },
          totalDebits: { $sum: "$debitAmount" },
          totalCredits: { $sum: "$creditAmount" },
        },
      },
      {
        $lookup: {
          from: "ledgeraccounts",
          localField: "_id",
          foreignField: "_id",
          as: "accountInfo",
        },
      },
      {
        $project: {
          accountName: 1,
          accountCode: 1,
          accountType: { $arrayElemAt: ["$accountInfo.accountType", 0] },
          totalDebits: 1,
          totalCredits: 1,
          balance: { $subtract: ["$totalDebits", "$totalCredits"] },
        },
      },
      { $sort: { accountCode: 1 } },
    ]);

    const summary = {
      totalDebits: trialBalance.reduce((sum, acc) => sum + acc.totalDebits, 0),
      totalCredits: trialBalance.reduce(
        (sum, acc) => sum + acc.totalCredits,
        0
      ),
    };

    return { trialBalance, summary };
  }

  // Cash Flow Report
  static async getCashFlowReport(dateFrom, dateTo) {
    const matchConditions = {
      voucherType: { $in: ["receipt", "payment", "contra"] },
    };
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo)
      matchConditions.date = {
        ...matchConditions.date,
        $lte: new Date(dateTo),
      };

    const cashFlow = await Voucher.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: "$voucherType",
          totalAmount: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    const receipts =
      cashFlow.find((cf) => cf._id === "receipt")?.totalAmount || 0;
    const payments =
      cashFlow.find((cf) => cf._id === "payment")?.totalAmount || 0;
    const transfers =
      cashFlow.find((cf) => cf._id === "contra")?.totalAmount || 0;

    return {
      cashFlow,
      summary: {
        totalReceipts: receipts,
        totalPayments: payments,
        totalTransfers: transfers,
        netCashFlow: receipts - payments,
      },
    };
  }

  // Expense Summary Report
  static async getExpenseSummary(dateFrom, dateTo) {
    const matchConditions = { voucherType: "expense" };
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo)
      matchConditions.date = {
        ...matchConditions.date,
        $lte: new Date(dateTo),
      };

    const expenseSummary = await Voucher.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: "expensecategories",
          localField: "expenseCategoryId",
          foreignField: "_id",
          as: "category",
        },
      },
      {
        $group: {
          _id: "$expenseCategoryId",
          categoryName: {
            $first: { $arrayElemAt: ["$category.categoryName", 0] },
          },
          totalAmount: { $sum: "$totalAmount" },
          count: { $sum: 1 },
          avgAmount: { $avg: "$totalAmount" },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    const totalExpenses = expenseSummary.reduce(
      (sum, exp) => sum + exp.totalAmount,
      0
    );

    return { expenseSummary, totalExpenses };
  }

  // Party Statement (Customer/Vendor)
  static async getPartyStatement(partyId, partyType, dateFrom, dateTo) {
    if (!partyId || !partyType) {
      throw new AppError("Party ID and type are required for statement", 400);
    }

    const matchConditions = {
      partyId: new mongoose.Types.ObjectId(partyId),
      partyType,
    };

    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo)
      matchConditions.date = {
        ...matchConditions.date,
        $lte: new Date(dateTo),
      };

    const statement = await Voucher.find(matchConditions)
      .sort({ date: 1 })
      .populate("partyId", "customerName vendorName name")
      .lean();

    let runningBalance = 0;
    const processedStatement = statement.map((voucher) => {
      let amount = voucher.totalAmount;

      // For customers: receipts reduce balance, sales increase balance
      // For vendors: payments reduce balance, purchases increase balance
      if (partyType === "Customer") {
        runningBalance += voucher.voucherType === "receipt" ? -amount : amount;
      } else {
        runningBalance += voucher.voucherType === "payment" ? -amount : amount;
      }

      return {
        ...voucher,
        runningBalance,
      };
    });

    return {
      statement: processedStatement,
      summary: {
        totalTransactions: statement.length,
        finalBalance: runningBalance,
      },
    };
  }

  // Get dashboard statistics
  static async getDashboardStats(filters = {}) {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const matchConditions = {
      date: { $gte: startOfMonth, $lte: today },
      status: "approved",
    };

    const stats = await Voucher.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: "$voucherType",
          totalAmount: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Pending approvals
    const pendingApprovals = await Voucher.countDocuments({
      status: "pending",
    });

    // Recent transactions
    const recentTransactions = await Voucher.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("createdBy", "name")
      .populate("partyId", "customerName vendorName name");

    return {
      monthlyStats: stats,
      pendingApprovals,
      recentTransactions,
    };
  }
}

module.exports = FinancialService;
