// services/financial/financialService.js
const {
  Voucher,
  LedgerAccount,
  ExpenseCategory,
  LedgerEntry,
} = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Transaction = require("../../models/modules/transactionModel");
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
    const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
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
          processedData = await this.processReceiptVoucher(voucherData, session);
          break;
        case "payment":
          processedData = await this.processPaymentVoucher(voucherData, session);
          break;
        case "journal":
          processedData = await this.processJournalVoucher(voucherData, session);
          break;
        case "contra":
          processedData = await this.processContraVoucher(voucherData, session);
          break;
        case "expense":
          processedData = await this.processExpenseVoucher(voucherData, session);
          break;
        default:
          throw new AppError("Invalid voucher type", 400);
      }

      const voucherDoc = {
        voucherNo,
        voucherType,
        createdBy,
        attachments,
        ...processedData,
      };

      const voucher = await Voucher.create([voucherDoc], { session });
      const newVoucher = voucher[0];

      // Create ledger entries only if approved
      if (newVoucher.status === "approved") {
        await this.createLedgerEntries(newVoucher, createdBy, session);
      }

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
      date = new Date(),
      customerId,
      customerName,
      linkedInvoices = [],
      paymentMode,
      totalAmount,
      narration,
      paymentDetails = { bankDetails: null, chequeDetails: null, onlineDetails: null },
    } = data;

    if (!customerId) {
      throw new AppError("Customer is required for receipt voucher", 400);
    }

    // Validate customer exists
    const customer = await Customer.findById(customerId).session(session);
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // Validate payment mode
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }

    // Validate payment details based on payment mode
    if (paymentMode === "cheque" && (!paymentDetails.chequeDetails || !paymentDetails.chequeDetails.chequeNumber)) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }
    if (paymentMode === "online" && (!paymentDetails.onlineDetails || !paymentDetails.onlineDetails.transactionId)) {
      throw new AppError("Online transaction details required for online payment", 400);
    }
    if (paymentMode === "bank" && (!paymentDetails.bankDetails || !paymentDetails.bankDetails.accountNumber)) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Validate and allocate linked invoices
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      for (const linked of linkedInvoices) {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0) {
          throw new AppError(`Invalid allocation amount for invoice ${invoiceId}`, 400);
        }

        const invoice = await Transaction.findById(invoiceId).session(session);
        if (!invoice) {
          throw new AppError(`Invoice not found: ${invoiceId}`, 404);
        }
        if (invoice.partyId.toString() !== customerId.toString() || invoice.partyType !== "Customer") {
          throw new AppError(`Invoice ${invoiceId} does not belong to this customer`, 400);
        }

        const current = invoice.outstandingAmount;
        if (Math.abs(current - (allocated + expectedNew)) > 0.01) {
          throw new AppError(
            `Invoice balance mismatch for ${invoiceId}. Expected outstanding: ${current}, Provided: ${allocated + expectedNew}`,
            409
          );
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        invoice.status = expectedNew === 0 ? "paid" : (invoice.paidAmount > 0 ? "partial" : "unpaid");
        await invoice.save({ session });

        validatedInvoices.push({
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        });

        totalAllocated += allocated;
      }

      if (Math.abs(totalAllocated - totalAmount) > 0.01) {
        throw new AppError("Total allocated amounts must equal total amount", 400);
      }
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
      date,
      partyId: customerId,
      partyType: "Customer",
      partyName: customer.customerName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      paymentDetails,
      totalAmount,
      narration,
      entries,
      status: "approved", // Receipts are typically approved immediately
    };
  }

  // Process Payment Voucher
  static async processPaymentVoucher(data, session) {
    const {
      date = new Date(),
      vendorId,
      linkedInvoices = [],
      paymentMode,
      totalAmount,
      narration,
      paymentDetails = { bankDetails: null, chequeDetails: null, onlineDetails: null },
    } = data;

    if (!vendorId) {
      throw new AppError("Vendor is required for payment voucher", 400);
    }

    // Validate vendor exists
    const vendor = await Vendor.findById(vendorId).session(session);
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }

    // Validate payment mode
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }

    // Validate payment details based on payment mode
    if (paymentMode === "cheque" && (!paymentDetails.chequeDetails || !paymentDetails.chequeDetails.chequeNumber)) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }
    if (paymentMode === "online" && (!paymentDetails.onlineDetails || !paymentDetails.onlineDetails.transactionId)) {
      throw new AppError("Online transaction details required for online payment", 400);
    }
    if (paymentMode === "bank" && (!paymentDetails.bankDetails || !paymentDetails.bankDetails.accountNumber)) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Validate and allocate linked invoices
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      for (const linked of linkedInvoices) {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0) {
          throw new AppError(`Invalid allocation amount for invoice ${invoiceId}`, 400);
        }

        const invoice = await Transaction.findById(invoiceId).session(session);
        if (!invoice) {
          throw new AppError(`Invoice not found: ${invoiceId}`, 404);
        }
        if (invoice.partyId.toString() !== vendorId.toString() || invoice.partyType !== "Vendor") {
          throw new AppError(`Invoice ${invoiceId} does not belong to this vendor`, 400);
        }

        const current = invoice.outstandingAmount;
        if (Math.abs(current - (allocated + expectedNew)) > 0.01) {
          throw new AppError(
            `Invoice balance mismatch for ${invoiceId}. Expected outstanding: ${current}, Provided: ${allocated + expectedNew}`,
            409
          );
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        invoice.status = expectedNew === 0 ? "paid" : (invoice.paidAmount > 0 ? "partial" : "unpaid");
        await invoice.save({ session });

        validatedInvoices.push({
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        });

        totalAllocated += allocated;
      }

      if (Math.abs(totalAllocated - totalAmount) > 0.01) {
        throw new AppError("Total allocated amounts must equal total amount", 400);
      }
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
      date,
      partyId: vendorId,
      partyType: "Vendor",
      partyName: vendor.vendorName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      paymentDetails,
      totalAmount,
      narration,
      entries,
      status: "approved",
    };
  }

  // Process Journal Voucher
  static async processJournalVoucher(data, session) {
    const { date = new Date(), entries, narration, totalAmount } = data;

    if (!entries || entries.length < 2) {
      throw new AppError("Journal voucher must have at least 2 entries", 400);
    }

    // Validate entries and accounts
    let validatedEntries = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const entry of entries) {
      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (!account) {
        throw new AppError(`Account not found: ${entry.accountId}`, 404);
      }

      if (!account.allowDirectPosting) {
        throw new AppError(`Direct posting not allowed for account: ${account.accountName}`, 400);
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
      date,
      totalAmount: totalDebits,
      narration,
      entries: validatedEntries,
      status: "draft",
    };
  }

  // Process Contra Voucher
  static async processContraVoucher(data, session) {
    const { date = new Date(), fromAccountId, toAccountId, totalAmount, notes } = data;

    if (!fromAccountId || !toAccountId) {
      throw new AppError("From and To accounts are required for contra voucher", 400);
    }

    if (fromAccountId.toString() === toAccountId.toString()) {
      throw new AppError("From and To accounts cannot be the same", 400);
    }

    // Validate accounts exist and are cash/bank accounts
    const fromAccount = await LedgerAccount.findById(fromAccountId).session(session);
    const toAccount = await LedgerAccount.findById(toAccountId).session(session);

    if (!fromAccount || !toAccount) {
      throw new AppError("One or both accounts not found", 404);
    }

    if (!this.isCashBankAccount(fromAccount) || !this.isCashBankAccount(toAccount)) {
      throw new AppError("Contra vouchers can only be used between cash/bank accounts", 400);
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
      date,
      fromAccountId,
      toAccountId,
      totalAmount,
      notes,
      entries,
      status: "approved",
    };
  }

  // Process Expense Voucher
  static async processExpenseVoucher(data, session) {
    const {
      date = new Date(),
      expenseCategoryId,
      totalAmount,
      description,
      submittedBy,
      paymentMode = "cash",
      paymentDetails = { bankDetails: null, chequeDetails: null, onlineDetails: null },
    } = data;

    if (!expenseCategoryId) {
      throw new AppError("Expense category is required", 400);
    }

    // Validate expense category
    const category = await ExpenseCategory.findById(expenseCategoryId).session(session);
    if (!category) {
      throw new AppError("Expense category not found", 404);
    }

    // Validate payment mode
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }

    // Validate payment details based on payment mode
    if (paymentMode === "cheque" && (!paymentDetails.chequeDetails || !paymentDetails.chequeDetails.chequeNumber)) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }
    if (paymentMode === "online" && (!paymentDetails.onlineDetails || !paymentDetails.onlineDetails.transactionId)) {
      throw new AppError("Online transaction details required for online payment", 400);
    }
    if (paymentMode === "bank" && (!paymentDetails.bankDetails || !paymentDetails.bankDetails.accountNumber)) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Get default expense account
    let expenseAccount;
    if (category.defaultAccountId) {
      expenseAccount = await LedgerAccount.findById(category.defaultAccountId).session(session);
    } else {
      expenseAccount = await LedgerAccount.findOne({
        accountType: "expense",
        isActive: true,
      }).session(session);
    }

    if (!expenseAccount) {
      throw new AppError("No expense account found for this category", 400);
    }

    // Get cash/bank account
    const cashBankAccount = await this.getCashBankAccount(paymentMode, session);

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
        accountId: cashBankAccount._id,
        accountName: cashBankAccount.accountName,
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
      date,
      expenseCategoryId,
      expenseType: category.categoryName,
      submittedBy,
      totalAmount,
      description,
      paymentMode,
      paymentDetails,
      entries,
      status: requiresApproval ? "pending" : "approved",
      approvalStatus: requiresApproval ? "pending" : "approved",
    };
  }

  // Create ledger entries for double-entry accounting
  static async createLedgerEntries(voucher, createdBy, session) {
    const ledgerEntries = voucher.entries.map((entry) => ({
      voucherId: voucher._id,
      voucherNo: voucher.voucherNo,
      voucherType: voucher.voucherType,
      accountId: entry.accountId,
      accountName: entry.accountName,
      accountCode: "", // Populate from account if needed
      date: voucher.date,
      debitAmount: entry.debitAmount,
      creditAmount: entry.creditAmount,
      narration: entry.description || voucher.narration,
      partyId: voucher.partyId,
      partyType: voucher.partyType,
      createdBy,
    }));

    await LedgerEntry.insertMany(ledgerEntries, { session });

    // Update account balances
    await this.updateAccountBalances(voucher.entries, session);
  }

  // Update account balances after posting
  static async updateAccountBalances(entries, session) {
    for (const entry of entries) {
      const account = await LedgerAccount.findById(entry.accountId).session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
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

    let account = await LedgerAccount.findOne({ accountName, isActive: true }).session(session);

    if (!account) {
      account = await LedgerAccount.create(
        [
          {
            accountCode: paymentMode === "cash" ? "CASH001" : "BANK001",
            accountName,
            accountType: "asset",
            subType: "current_asset",
            allowDirectPosting: true,
            isSystemAccount: true,
            createdBy: new mongoose.Types.ObjectId(),
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
    const cashBankNames = ["Cash in Hand", "Bank Account", "Petty Cash", "Cash at Bank"];
    return (
      cashBankNames.some((name) => account.accountName.toLowerCase().includes(name.toLowerCase())) ||
      (account.accountType === "asset" &&
        account.subType === "current_asset" &&
        (account.accountCode.startsWith("CASH") || account.accountCode.startsWith("BANK")))
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

    const vouchers = await Voucher.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "name username")
      .populate("partyId", "customerName vendorName name")
      .populate("linkedInvoices.invoiceId");

    const total = await Voucher.countDocuments(query);

    return {
      vouchers: vouchers.map((voucher) => ({
        ...voucher.toObject(),
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
      })),
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  }

  // Get voucher by ID with details
  static async getVoucherById(id) {
    const voucher = await Voucher.findById(id)
      .populate("createdBy", "name username")
      .populate("partyId", "customerName vendorName name email phone")
      .populate("expenseCategoryId", "categoryName description")
      .populate("linkedInvoices.invoiceId")
      .populate("entries.accountId", "accountName accountCode accountType");

    if (!voucher) {
      throw new AppError("Voucher not found", 404);
    }

    // Get related ledger entries
    const ledgerEntries = await LedgerEntry.find({ voucherId: id })
      .populate("accountId", "accountName accountCode")
      .sort({ createdAt: 1 });

    return {
      voucher: {
        ...voucher.toObject(),
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
      },
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

      if (voucher.status === "approved" && !data.forceUpdate) {
        throw new AppError("Cannot update approved voucher", 400);
      }

      let needReprocess = false;
      if (
        data.totalAmount ||
        data.entries ||
        data.linkedInvoices ||
        data.paymentMode ||
        data.paymentDetails
      ) {
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);
        needReprocess = true;
      }

      // Handle attachments: merge old + new
      if (data.attachments && data.attachments.length > 0) {
        voucher.attachments = [...voucher.attachments, ...data.attachments];
      }

      if (needReprocess) {
        const processData = { ...voucher.toObject(), ...data };
        let processedData;
        switch (voucher.voucherType) {
          case "receipt":
            processedData = await this.processReceiptVoucher(processData, session);
            break;
          case "payment":
            processedData = await this.processPaymentVoucher(processData, session);
            break;
          case "journal":
            processedData = await this.processJournalVoucher(processData, session);
            break;
          case "contra":
            processedData = await this.processContraVoucher(processData, session);
            break;
          case "expense":
            processedData = await this.processExpenseVoucher(processData, session);
            break;
          default:
            throw new AppError("Invalid voucher type", 400);
        }
        Object.assign(voucher, processedData);
      } else {
        Object.assign(voucher, data);
      }

      voucher.updatedBy = updatedBy;
      await voucher.save({ session });

      if (needReprocess && voucher.status === "approved") {
        await this.createLedgerEntries(voucher, updatedBy, session);
      }

      await session.commitTransaction();
      return {
        ...voucher.toObject(),
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
      };
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
        throw new AppError("Voucher is not in a state that can be approved/rejected", 400);
      }

      // Update voucher status
      voucher.status = action === "approve" ? "approved" : "rejected";
      voucher.approvalStatus = action === "approve" ? "approved" : "rejected";
      voucher.approvedBy = approvedBy;
      voucher.approvedAt = new Date();

      if (comments) {
        voucher.notes = `${voucher.notes || ""}\nApproval Comments: ${comments}`;
      }

      await voucher.save({ session });

      // If approved and no ledger entries exist, create them
      if (action === "approve") {
        const existingEntries = await LedgerEntry.findOne({ voucherId: id }).session(session);
        if (!existingEntries) {
          await this.createLedgerEntries(voucher, approvedBy, session);
        }
      }

      await session.commitTransaction();
      return {
        ...voucher.toObject(),
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
      };
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
        await this.reverseLedgerEntries(id, session);
        await this.reverseAllocations(voucher, session);
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
      const reversalEntry = {
        ...entry.toObject(),
        _id: undefined,
        debitAmount: entry.creditAmount,
        creditAmount: entry.debitAmount,
        narration: `Reversal: ${entry.narration}`,
        createdAt: new Date(),
      };

      await LedgerEntry.create([reversalEntry], { session });

      const account = await LedgerAccount.findById(entry.accountId).session(session);
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

    await LedgerEntry.updateMany(
      { voucherId },
      { $set: { isReversed: true, reversedAt: new Date() } },
      { session }
    );
  }

  // Reverse allocations on linked invoices
  static async reverseAllocations(voucher, session) {
    if (voucher.linkedInvoices && voucher.linkedInvoices.length > 0) {
      for (const linked of voucher.linkedInvoices) {
        const invoice = await Transaction.findById(linked.invoiceId).session(session);
        if (invoice) {
          invoice.paidAmount -= linked.allocatedAmount;
          invoice.outstandingAmount += linked.allocatedAmount;
          if (invoice.paidAmount < 0) invoice.paidAmount = 0;
          if (invoice.outstandingAmount > invoice.totalAmount) invoice.outstandingAmount = invoice.totalAmount;
          invoice.status =
            invoice.outstandingAmount === invoice.totalAmount
              ? "unpaid"
              : invoice.outstandingAmount === 0
              ? "paid"
              : "partial";
          await invoice.save({ session });
        }
      }
    }
  }

  // Get financial reports
  static async getFinancialReports(filters = {}) {
    const { reportType, dateFrom, dateTo } = filters;

    switch (reportType) {
      case "trial_balance":
        return this.getTrialBalance(dateFrom, dateTo);
      case "cash_flow":
        return this.getCashFlowReport(dateFrom, dateTo);
      case "expense_summary":
        return this.getExpenseSummary(dateFrom, dateTo);
      case "party_statement":
        return this.getPartyStatement(filters.partyId, filters.partyType, dateFrom, dateTo);
      default:
        throw new AppError("Invalid report type", 400);
    }
  }

  // Trial Balance Report
  static async getTrialBalance(dateFrom, dateTo) {
    const matchConditions = {};
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo) matchConditions.date = { ...matchConditions.date, $lte: new Date(dateTo) };

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
      totalCredits: trialBalance.reduce((sum, acc) => sum + acc.totalCredits, 0),
    };

    return { trialBalance, summary };
  }

  // Cash Flow Report
  static async getCashFlowReport(dateFrom, dateTo) {
    const matchConditions = { voucherType: { $in: ["receipt", "payment", "contra"] } };
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo) matchConditions.date = { ...matchConditions.date, $lte: new Date(dateTo) };

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

    const receipts = cashFlow.find((cf) => cf._id === "receipt")?.totalAmount || 0;
    const payments = cashFlow.find((cf) => cf._id === "payment")?.totalAmount || 0;
    const transfers = cashFlow.find((cf) => cf._id === "contra")?.totalAmount || 0;

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
    if (dateTo) matchConditions.date = { ...matchConditions.date, $lte: new Date(dateTo) };

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
          categoryName: { $first: { $arrayElemAt: ["$category.categoryName", 0] } },
          totalAmount: { $sum: "$totalAmount" },
          count: { $sum: 1 },
          avgAmount: { $avg: "$totalAmount" },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    const totalExpenses = expenseSummary.reduce((sum, exp) => sum + exp.totalAmount, 0);

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
    if (dateTo) matchConditions.date = { ...matchConditions.date, $lte: new Date(dateTo) };

    const statement = await Voucher.find(matchConditions)
      .sort({ date: 1 })
      .populate("partyId", "customerName vendorName name")
      .populate("linkedInvoices.invoiceId")
      .lean();

    let runningBalance = 0;
    const processedStatement = statement.map((voucher) => {
      let amount = voucher.totalAmount;
      if (partyType === "Customer") {
        runningBalance += voucher.voucherType === "receipt" ? -amount : amount;
      } else {
        runningBalance += voucher.voucherType === "payment" ? -amount : amount;
      }
      return {
        ...voucher,
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
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

    const pendingApprovals = await Voucher.countDocuments({ status: "pending" });

    const recentTransactions = await Voucher.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("createdBy", "name")
      .populate("partyId", "customerName vendorName name")
      .populate("linkedInvoices.invoiceId");

    return {
      monthlyStats: stats,
      pendingApprovals,
      recentTransactions: recentTransactions.map((voucher) => ({
        ...voucher.toObject(),
        linkedInvoices: voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })),
      })),
    };
  }
}

module.exports = FinancialService;