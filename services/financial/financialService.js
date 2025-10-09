const {
  Voucher,
  LedgerAccount,
  ExpenseCategory,
  LedgerEntry,
} = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Transaction = require("../../models/modules/transactionModel");
const Transactor = require("../../models/modules/financial/transactorModel");
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

  // Helper: Centralized cash balance adjustment (for Customer/Vendor)
  static async adjustPartyCashBalance(partyId, partyType, amount, session, operation = "add") {
    if (!partyId || amount <= 0 || !mongoose.Types.ObjectId.isValid(partyId)) return; // Early exit

    const PartyModel = partyType === "Customer" ? Customer : Vendor;
    const party = await PartyModel.findById(partyId).select('cashBalance').session(session);
    if (!party) {
      throw new AppError(`${partyType} not found`, 404);
    }

    const delta = operation === "add" ? amount : -amount;
    party.cashBalance = Math.max(0, (party.cashBalance || 0) + delta);
    await party.save({ session });
    console.log(`[CashBalance] ${partyType} ${partyId}: Adjusted by ${delta} (new: ${party.cashBalance})`);
  }

  // Retry wrapper for transactions to handle TransientTransactionError
  static async withTransactionRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error.name === 'MongoServerError' && error.code === 251 && attempt < maxRetries) {
          console.log(`[Retry] Transaction attempt ${attempt} failed: ${error.message}. Retrying...`);
          await new Promise(resolve => setTimeout(resolve, 100 * attempt)); // Exponential backoff
          continue;
        }
        throw error;
      }
    }
  }

  // Create any type of voucher (with retry and optimized session)
  static async createVoucher(data, createdBy) {
    return this.withTransactionRetry(async () => {
      const session = await mongoose.startSession({
        defaultTransactionOptions: { maxTimeMS: 120000 }, // 120s timeout
      });
      session.startTransaction();

      try {
        const { voucherType, attachments = [], ...voucherData } = data;

        if (!voucherType) {
          throw new AppError("Voucher type is required", 400);
        }

        const voucherNo = this.generateVoucherNo(voucherType);
        console.log(`[Transaction] Started for voucher ${voucherNo} with session ${session.id}`);

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
        console.log(`[Transaction] Committed for voucher ${voucherNo}`);
        return newVoucher;
      } catch (error) {
        await session.abortTransaction();
        console.error(`[Transaction] Aborted for voucher: ${error.message}`);
        throw error;
      } finally {
        session.endSession();
      }
    });
  }

  // Process Receipt Voucher (money received from customer) - Optimized with projections and validation
  static async processReceiptVoucher(data, session) {
    const {
      date = new Date(),
      customerId,
      customerName,
      linkedInvoices = [],
      paymentMode,
      totalAmount,
      narration,
      paymentDetails = {
        bankDetails: null,
        chequeDetails: null,
        onlineDetails: null,
      },
    } = data;

    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      throw new AppError("Valid Customer ID is required for receipt voucher", 400);
    }

    // Validate customer exists (with projection)
    const customer = await Customer.findById(customerId).select('customerName').session(session);
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

    // Validate and allocate linked invoices (parallel fetch for optimization)
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      const invoicePromises = linkedInvoices.map(async (linked) => {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0 || !mongoose.Types.ObjectId.isValid(invoiceId)) {
          throw new AppError(`Invalid allocation for invoice ${invoiceId}`, 400);
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
          throw new AppError(`Invoice balance mismatch for ${invoiceId}. Expected: ${current}, Provided: ${allocated + expectedNew}`, 409);
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        invoice.status = expectedNew === 0 ? "paid" : invoice.paidAmount > 0 ? "partial" : "unpaid";
        await invoice.save({ session });

        return {
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        };
      });

      validatedInvoices = await Promise.all(invoicePromises); // Parallel processing
      totalAllocated = validatedInvoices.reduce((sum, inv) => sum + inv.allocatedAmount, 0);
    }

    const onAccountAmount = totalAmount - totalAllocated;
    if (onAccountAmount < 0) {
      throw new AppError("Allocated amount cannot exceed total amount", 400);
    }

    // Update customer cashBalance for on-account
    await this.adjustPartyCashBalance(customerId, "Customer", onAccountAmount, session, "add");

    // Create entries for double-entry accounting (parallel fetch)
    const [cashBankAccount, customerAccount] = await Promise.all([
      this.getCashBankAccount(paymentMode, session),
      totalAllocated > 0 ? this.getOrCreateCustomerAccount(customerId, customer.customerName, session) : null,
    ]);

    const entries = [];

    // Debit: Cash/Bank Account
    entries.push({
      accountId: cashBankAccount._id,
      accountName: cashBankAccount.accountName,
      debitAmount: totalAmount,
      creditAmount: 0,
      description: `Receipt from ${customer.customerName}`,
    });

    // Credit: Customer Receivable Account (for allocated part)
    if (totalAllocated > 0 && customerAccount) {
      entries.push({
        accountId: customerAccount._id,
        accountName: customerAccount.accountName,
        debitAmount: 0,
        creditAmount: totalAllocated,
        description: `Payment received from ${customer.customerName} (allocated)`,
      });
    }

    // Credit: Customer Advance Liability Account (for on-account part)
    if (onAccountAmount > 0) {
      const advanceAccount = await this.getOrCreateCustomerAdvanceAccount(customerId, customer.customerName, session);
      entries.push({
        accountId: advanceAccount._id,
        accountName: advanceAccount.accountName,
        debitAmount: 0,
        creditAmount: onAccountAmount,
        description: `Advance received from ${customer.customerName}`,
      });
    }

    return {
      date,
      partyId: customerId,
      partyType: "Customer",
      partyName: customer.customerName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      paymentDetails,
      totalAmount,
      onAccountAmount,
      narration,
      entries,
      status: "approved", // Receipts are typically approved immediately
    };
  }

  // Process Payment Voucher (money paid to vendor) - Similar optimizations as receipt
  static async processPaymentVoucher(data, session) {
    const {
      date = new Date(),
      vendorId,
      linkedInvoices = [],
      paymentMode,
      totalAmount,
      narration,
      paymentDetails = {
        bankDetails: null,
        chequeDetails: null,
        onlineDetails: null,
      },
    } = data;

    if (!vendorId || !mongoose.Types.ObjectId.isValid(vendorId)) {
      throw new AppError("Valid Vendor ID is required for payment voucher", 400);
    }

    // Validate vendor exists
    const vendor = await Vendor.findById(vendorId).select('vendorName').session(session);
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }

    // Validate payment mode and details (same as receipt)
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }
    if (paymentMode === "cheque" && (!paymentDetails.chequeDetails || !paymentDetails.chequeDetails.chequeNumber)) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }
    if (paymentMode === "online" && (!paymentDetails.onlineDetails || !paymentDetails.onlineDetails.transactionId)) {
      throw new AppError("Online transaction details required for online payment", 400);
    }
    if (paymentMode === "bank" && (!paymentDetails.bankDetails || !paymentDetails.bankDetails.accountNumber)) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Validate and allocate linked invoices (parallel)
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      const invoicePromises = linkedInvoices.map(async (linked) => {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0 || !mongoose.Types.ObjectId.isValid(invoiceId)) {
          throw new AppError(`Invalid allocation for invoice ${invoiceId}`, 400);
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
          throw new AppError(`Invoice balance mismatch for ${invoiceId}. Expected: ${current}, Provided: ${allocated + expectedNew}`, 409);
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        invoice.status = expectedNew === 0 ? "paid" : invoice.paidAmount > 0 ? "partial" : "unpaid";
        await invoice.save({ session });

        return {
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        };
      });

      validatedInvoices = await Promise.all(invoicePromises);
      totalAllocated = validatedInvoices.reduce((sum, inv) => sum + inv.allocatedAmount, 0);
    }

    const onAccountAmount = totalAmount - totalAllocated;
    if (onAccountAmount < 0) {
      throw new AppError("Allocated amount cannot exceed total amount", 400);
    }

    // Update vendor cashBalance for on-account
    await this.adjustPartyCashBalance(vendorId, "Vendor", onAccountAmount, session, "add");

    // Create entries (parallel fetch)
    const [cashBankAccount, vendorAccount] = await Promise.all([
      this.getCashBankAccount(paymentMode, session),
      totalAllocated > 0 ? this.getOrCreateVendorAccount(vendorId, vendor.vendorName, session) : null,
    ]);

    const entries = [];

    // Credit: Cash/Bank Account (outflow)
    entries.push({
      accountId: cashBankAccount._id,
      accountName: cashBankAccount.accountName,
      debitAmount: 0,
      creditAmount: totalAmount,
      description: `Payment to ${vendor.vendorName}`,
    });

    // Debit: Vendor Payable Account (for allocated part)
    if (totalAllocated > 0 && vendorAccount) {
      entries.push({
        accountId: vendorAccount._id,
        accountName: vendorAccount.accountName,
        debitAmount: totalAllocated,
        creditAmount: 0,
        description: `Payment to ${vendor.vendorName} (allocated)`,
      });
    }

    // Debit: Vendor Advance Asset Account (for on-account part)
    if (onAccountAmount > 0) {
      const advanceAccount = await this.getOrCreateVendorAdvanceAccount(vendorId, vendor.vendorName, session);
      entries.push({
        accountId: advanceAccount._id,
        accountName: advanceAccount.accountName,
        debitAmount: onAccountAmount,
        creditAmount: 0,
        description: `Advance payment to ${vendor.vendorName}`,
      });
    }

    return {
      date,
      partyId: vendorId,
      partyType: "Vendor",
      partyName: vendor.vendorName,
      linkedInvoices: validatedInvoices,
      paymentMode,
      paymentDetails,
      totalAmount,
      onAccountAmount,
      narration,
      entries,
      status: "approved",
    };
  }

  // Process Journal Voucher - Updated to handle debitAccount and creditAccount from Transactor
  static async processJournalVoucher(data, session) {
    const {
      date = new Date(),
      debitAccount,
      creditAccount,
      totalAmount,
      narration,
    } = data;

    // Validate required fields
    if (!debitAccount || !creditAccount || !totalAmount || totalAmount <= 0) {
      throw new AppError("Debit account, credit account, and valid total amount are required", 400);
    }

    if (debitAccount === creditAccount) {
      throw new AppError("Debit and credit accounts cannot be the same", 400);
    }

    // Fetch accounts from Transactor collection by accountCode (parallel)
    const [debitAccountDoc, creditAccountDoc] = await Promise.all([
      Transactor.findOne({ accountCode: debitAccount, isActive: true, deletedAt: null })
        .select('accountCode accountName accountType allowDirectPosting currentBalance')
        .session(session),
      Transactor.findOne({ accountCode: creditAccount, isActive: true, deletedAt: null })
        .select('accountCode accountName accountType allowDirectPosting currentBalance')
        .session(session),
    ]);

    // Validate accounts exist
    if (!debitAccountDoc) {
      throw new AppError(`Debit account not found or inactive: ${debitAccount}`, 404);
    }
    if (!creditAccountDoc) {
      throw new AppError(`Credit account not found or inactive: ${creditAccount}`, 404);
    }

    // Validate direct posting
    if (!debitAccountDoc.allowDirectPosting) {
      throw new AppError(`Direct posting not allowed for account: ${debitAccountDoc.accountName} (${debitAccountDoc.accountCode})`, 400);
    }
    if (!creditAccountDoc.allowDirectPosting) {
      throw new AppError(`Direct posting not allowed for account: ${creditAccountDoc.accountName} (${creditAccountDoc.accountCode})`, 400);
    }

    // Update account balances in Transactor collection
    debitAccountDoc.currentBalance += totalAmount;
    debitAccountDoc.updatedAt = new Date();
    creditAccountDoc.currentBalance -= totalAmount;
    creditAccountDoc.updatedAt = new Date();

    // Save both accounts (parallel)
    await Promise.all([
      debitAccountDoc.save({ session }),
      creditAccountDoc.save({ session }),
    ]);

    console.log(`[Journal] Debit ${totalAmount} to ${debitAccountDoc.accountName} (${debitAccountDoc.accountCode}), Credit ${totalAmount} from ${creditAccountDoc.accountName} (${creditAccountDoc.accountCode})`);

    // Create entries for double-entry accounting
    const entries = [
      {
        accountId: debitAccountDoc._id,
        accountName: debitAccountDoc.accountName,
        accountCode: debitAccountDoc.accountCode,
        debitAmount: totalAmount,
        creditAmount: 0,
        description: narration || `Journal entry debiting ${debitAccountDoc.accountName}`,
      },
      {
        accountId: creditAccountDoc._id,
        accountName: creditAccountDoc.accountName,
        accountCode: creditAccountDoc.accountCode,
        debitAmount: 0,
        creditAmount: totalAmount,
        description: narration || `Journal entry crediting ${creditAccountDoc.accountName}`,
      },
    ];

    return {
      date,
      totalAmount,
      narration,
      entries,
      status: "draft",
    };
  }

  // Process Contra Voucher - Optimized with parallel fetches and balance checks
  static async processContraVoucher(data, session) {
    const {
      date = new Date(),
      fromAccount, // accountCode from Transactor
      toAccount, // accountCode from Transactor
      totalAmount,
      narration,
    } = data;

    // Validate required fields
    if (!fromAccount || !toAccount) {
      throw new AppError("From and To account codes are required for contra voucher", 400);
    }

    if (!totalAmount || totalAmount <= 0) {
      throw new AppError("Valid amount is required for contra voucher", 400);
    }

    if (fromAccount === toAccount) {
      throw new AppError("From and To accounts cannot be the same", 400);
    }

    // Fetch accounts by accountCode (parallel)
    const [fromAccountDoc, toAccountDoc] = await Promise.all([
      Transactor.findOne({ accountCode: fromAccount, isActive: true, deletedAt: null })
        .select('accountCode accountName accountType allowDirectPosting currentBalance')
        .session(session),
      Transactor.findOne({ accountCode: toAccount, isActive: true, deletedAt: null })
        .select('accountCode accountName accountType allowDirectPosting currentBalance')
        .session(session),
    ]);

    // Validate accounts exist
    if (!fromAccountDoc) {
      throw new AppError(`From account not found or inactive: ${fromAccount}`, 404);
    }
    if (!toAccountDoc) {
      throw new AppError(`To account not found or inactive: ${toAccount}`, 404);
    }

    // Validate both accounts allow direct posting
    if (!fromAccountDoc.allowDirectPosting) {
      throw new AppError(`Direct posting not allowed for account: ${fromAccountDoc.accountName} (${fromAccountDoc.accountCode})`, 400);
    }
    if (!toAccountDoc.allowDirectPosting) {
      throw new AppError(`Direct posting not allowed for account: ${toAccountDoc.accountName} (${toAccountDoc.accountCode})`, 400);
    }

    // Validate sufficient balance in fromAccount
    if (fromAccountDoc.currentBalance < totalAmount) {
      throw new AppError(`Insufficient balance in ${fromAccountDoc.accountName}. Available: ${fromAccountDoc.currentBalance}, Required: ${totalAmount}`, 400);
    }

    // Update account balances in Transactor collection
    fromAccountDoc.currentBalance -= totalAmount;
    fromAccountDoc.updatedAt = new Date();

    toAccountDoc.currentBalance += totalAmount;
    toAccountDoc.updatedAt = new Date();

    // Save both accounts (parallel)
    await Promise.all([
      fromAccountDoc.save({ session }),
      toAccountDoc.save({ session }),
    ]);

    console.log(`[Contra] Transfer ${totalAmount} from ${fromAccountDoc.accountName} (${fromAccountDoc.accountCode}) to ${toAccountDoc.accountName} (${toAccountDoc.accountCode})`);

    // Create entries for double-entry accounting
    const entries = [
      {
        accountId: toAccountDoc._id,
        accountName: toAccountDoc.accountName,
        accountCode: toAccountDoc.accountCode,
        debitAmount: totalAmount,
        creditAmount: 0,
        description: `Transfer from ${fromAccountDoc.accountName} (${fromAccountDoc.accountCode})`,
      },
      {
        accountId: fromAccountDoc._id,
        accountName: fromAccountDoc.accountName,
        accountCode: fromAccountDoc.accountCode,
        debitAmount: 0,
        creditAmount: totalAmount,
        description: `Transfer to ${toAccountDoc.accountName} (${toAccountDoc.accountCode})`,
      },
    ];

    return {
      date,
      fromAccountId: fromAccountDoc._id,
      toAccountId: toAccountDoc._id,
      totalAmount,
      narration: narration || `Fund transfer from ${fromAccountDoc.accountName} to ${toAccountDoc.accountName}`,
      notes: `From: ${fromAccountDoc.accountCode} | To: ${toAccountDoc.accountCode}`,
      entries,
      status: "approved",
    };
  }

  // Process Expense Voucher - Optimized with projections
  static async processExpenseVoucher(data, session) {
    const {
      date = new Date(),
      expenseCategoryId,
      totalAmount,
      description,
      submittedBy,
      paymentMode = "cash",
      paymentDetails = {
        bankDetails: null,
        chequeDetails: null,
        onlineDetails: null,
      },
    } = data;

    if (!expenseCategoryId || !mongoose.Types.ObjectId.isValid(expenseCategoryId)) {
      throw new AppError("Valid Expense category ID is required", 400);
    }

    // Validate expense category
    const category = await ExpenseCategory.findById(expenseCategoryId).select('categoryName defaultAccountId requiresApproval approvalLimit').session(session);
    if (!category) {
      throw new AppError("Expense category not found", 404);
    }

    // Validate payment mode and details (same as above)
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }
    if (paymentMode === "cheque" && (!paymentDetails.chequeDetails || !paymentDetails.chequeDetails.chequeNumber)) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }
    if (paymentMode === "online" && (!paymentDetails.onlineDetails || !paymentDetails.onlineDetails.transactionId)) {
      throw new AppError("Online transaction details required for online payment", 400);
    }
    if (paymentMode === "bank" && (!paymentDetails.bankDetails || !paymentDetails.bankDetails.accountNumber)) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Get default expense account (with fallback)
    let expenseAccount;
    try {
      if (category.defaultAccountId) {
        expenseAccount = await LedgerAccount.findById(category.defaultAccountId).select('accountName').session(session);
      } else {
        expenseAccount = await LedgerAccount.findOne({ accountType: "expense", isActive: true }).select('accountName').session(session);
      }

      if (!expenseAccount) {
        throw new AppError("No expense account found for this category", 400);
      }
    } catch (err) {
      throw new AppError("Failed to fetch expense account", 500);
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
    const requiresApproval = category.requiresApproval && (category.approvalLimit === 0 || totalAmount > category.approvalLimit);

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

  // Helper: Get or create customer receivable account (asset) - Parallel if needed, but single here
  static async getOrCreateCustomerAccount(customerId, customerName, session) {
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      throw new AppError("Invalid customer ID", 400);
    }
    const accountName = `Customer - ${customerName}`;
    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "asset",
      subType: "current_asset",
    }).select('accountCode accountName').session(session);

    if (!account) {
      account = await LedgerAccount.create([
        {
          accountCode: `CUST${customerId.toString().slice(-6)}`,
          accountName,
          accountType: "asset",
          subType: "current_asset",
          allowDirectPosting: true,
          description: `Receivables from ${customerName}`,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ], { session });
      account = account[0];
      console.log(`[Account] Created customer account: ${accountName}`);
    }

    return account;
  }

  // Helper: Get or create customer advance account (liability)
  static async getOrCreateCustomerAdvanceAccount(customerId, customerName, session) {
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      throw new AppError("Invalid customer ID", 400);
    }
    const accountName = `Customer Advance - ${customerName}`;
    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "liability",
      subType: "current_liability",
    }).select('accountCode accountName').session(session);

    if (!account) {
      account = await LedgerAccount.create([
        {
          accountCode: `CADV${customerId.toString().slice(-6)}`,
          accountName,
          accountType: "liability",
          subType: "current_liability",
          allowDirectPosting: true,
          description: `Advances from ${customerName}`,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ], { session });
      account = account[0];
      console.log(`[Account] Created customer advance account: ${accountName}`);
    }

    return account;
  }

  // Helper: Get or create vendor payable account (liability)
  static async getOrCreateVendorAccount(vendorId, vendorName, session) {
    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      throw new AppError("Invalid vendor ID", 400);
    }
    const accountName = `Vendor - ${vendorName}`;
    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "liability",
      subType: "current_liability",
    }).select('accountCode accountName').session(session);

    if (!account) {
      account = await LedgerAccount.create([
        {
          accountCode: `VEND${vendorId.toString().slice(-6)}`,
          accountName,
          accountType: "liability",
          subType: "current_liability",
          allowDirectPosting: true,
          description: `Payables to ${vendorName}`,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ], { session });
      account = account[0];
      console.log(`[Account] Created vendor account: ${accountName}`);
    }

    return account;
  }

  // Helper: Get or create vendor advance account (asset)
  static async getOrCreateVendorAdvanceAccount(vendorId, vendorName, session) {
    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      throw new AppError("Invalid vendor ID", 400);
    }
    const accountName = `Advance to Vendor - ${vendorName}`;
    let account = await LedgerAccount.findOne({
      accountName,
      accountType: "asset",
      subType: "current_asset",
    }).select('accountCode accountName').session(session);

    if (!account) {
      account = await LedgerAccount.create([
        {
          accountCode: `VADV${vendorId.toString().slice(-6)}`,
          accountName,
          accountType: "asset",
          subType: "current_asset",
          allowDirectPosting: true,
          description: `Advances to ${vendorName}`,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ], { session });
      account = account[0];
      console.log(`[Account] Created vendor advance account: ${accountName}`);
    }

    return account;
  }

  // Create ledger entries for double-entry accounting - Batched insert
  static async createLedgerEntries(voucher, createdBy, session) {
    if (!voucher.entries || voucher.entries.length === 0) return;

    const ledgerEntries = voucher.entries.map((entry) => ({
      voucherId: voucher._id,
      voucherNo: voucher.voucherNo,
      voucherType: voucher.voucherType,
      accountId: entry.accountId,
      accountName: entry.accountName,
      accountCode: entry.accountCode || "",
      date: voucher.date,
      debitAmount: entry.debitAmount,
      creditAmount: entry.creditAmount,
      narration: entry.description || voucher.narration,
      partyId: voucher.partyId,
      partyType: voucher.partyType,
      createdBy,
    }));

    await LedgerEntry.insertMany(ledgerEntries, { session });

    // Update account balances - Skip for Transactor accounts (handled in processJournalVoucher and processContraVoucher)
    if (voucher.voucherType !== "contra" && voucher.voucherType !== "journal") {
      await this.updateAccountBalances(voucher.entries, session);
    }
  }

  // Update account balances after posting - Parallel updates
  static async updateAccountBalances(entries, session) {
    const updatePromises = entries.map(async (entry) => {
      if (!mongoose.Types.ObjectId.isValid(entry.accountId)) return;
      const account = await LedgerAccount.findById(entry.accountId).select('accountType currentBalance').session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
        if (["asset", "expense"].includes(account.accountType)) {
          account.currentBalance += netChange;
        } else {
          account.currentBalance -= netChange;
        }
        await account.save({ session });
      }
    });

    await Promise.all(updatePromises);
  }

  // Helper method to get cash/bank account based on payment mode - With caching option
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
    }).select('accountCode accountName').session(session);

    if (!account) {
      account = await LedgerAccount.create([
        {
          accountCode: paymentMode === "cash" ? "CASH001" : "BANK001",
          accountName,
          accountType: "asset",
          subType: "current_asset",
          allowDirectPosting: true,
          isSystemAccount: true,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ], { session });
      account = account[0];
      console.log(`[Account] Created system account: ${accountName}`);
    }

    // Optional: In-memory cache for high-frequency access (implement with Redis for prod)
    // if (!global.cashBankCache) global.cashBankCache = new Map();
    // if (!global.cashBankCache.has(accountName)) global.cashBankCache.set(accountName, account);

    return account;
  }

  // Helper method to check if account is cash/bank type (for LedgerAccount)
  static isCashBankAccount(account) {
    const cashBankNames = ["Cash in Hand", "Bank Account", "Petty Cash", "Cash at Bank"];
    return cashBankNames.some((name) => account.accountName.toLowerCase().includes(name.toLowerCase())) ||
           (account.accountType === "asset" && account.subType === "current_asset" &&
            (account.accountCode.startsWith("CASH") || account.accountCode.startsWith("BANK")));
  }

  // Helper method to check if Transactor account is cash/bank type
  static isCashBankAccountTransactor(transactor) {
    const cashBankPrefixes = ["CAS", "BAN", "PET"];
    const cashBankKeywords = ["cash", "bank", "petty"];

    const hasValidPrefix = cashBankPrefixes.some((prefix) => transactor.accountCode.startsWith(prefix));
    const hasValidKeyword = cashBankKeywords.some((keyword) => transactor.accountName.toLowerCase().includes(keyword));

    return transactor.accountType === "asset" && (hasValidPrefix || hasValidKeyword);
  }

  // Get all vouchers with filters and pagination - Optimized query with lean()
  static async getAllVouchers(filters = {}) {
    const query = {};

    if (filters.voucherType) query.voucherType = filters.voucherType;
    if (filters.status) query.status = filters.status;
    if (filters.partyId && mongoose.Types.ObjectId.isValid(filters.partyId)) query.partyId = filters.partyId;
    if (filters.approvalStatus) query.approvalStatus = filters.approvalStatus;

    // Date filters
    if (filters.dateFrom || filters.dateTo) {
      query.date = {};
      if (filters.dateFrom) {
        const fromDate = new Date(filters.dateFrom);
        if (!isNaN(fromDate)) query.date.$gte = fromDate;
      }
      if (filters.dateTo) {
        const toDate = new Date(filters.dateTo);
        if (!isNaN(toDate)) query.date.$lte = toDate;
      }
    }

    // Search functionality
    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [
        { voucherNo: regex },
        { narration: regex },
        { notes: regex },
        { partyName: regex },
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
      .populate("linkedInvoices.invoiceId")
      .lean(); // Faster for read-only

    const total = await Voucher.countDocuments(query);

    const formattedVouchers = vouchers.map((voucher) => ({
      ...voucher,
      linkedInvoices: voucher.linkedInvoices ? voucher.linkedInvoices.map((inv) => ({
        invoiceId: inv.invoiceId,
        amount: inv.allocatedAmount,
        balance: inv.newBalance,
      })) : [],
    }));

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

  // Get voucher by ID with details - With lean() for speed
  static async getVoucherById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid voucher ID", 400);
    }

    const voucher = await Voucher.findById(id)
      .populate("createdBy", "name username")
      .populate("partyId", "customerName vendorName name email phone")
      .populate("expenseCategoryId", "categoryName description")
      .populate("linkedInvoices.invoiceId")
      .populate("entries.accountId", "accountName accountCode accountType")
      .lean();

    if (!voucher) {
      throw new AppError("Voucher not found", 404);
    }

    // Get related ledger entries (lean)
    const ledgerEntries = await LedgerEntry.find({ voucherId: id })
      .populate("accountId", "accountName accountCode")
      .sort({ createdAt: 1 })
      .lean();

    return {
      voucher: {
        ...voucher,
        linkedInvoices: voucher.linkedInvoices ? voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })) : [],
      },
      ledgerEntries,
    };
  }

  // Update voucher - With retry and reversal handling
  static async updateVoucher(id, data, updatedBy) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid voucher ID", 400);
    }

    return this.withTransactionRetry(async () => {
      const session = await mongoose.startSession({
        defaultTransactionOptions: { maxTimeMS: 120000 },
      });
      session.startTransaction();

      try {
        const oldVoucher = await Voucher.findById(id).session(session);
        if (!oldVoucher) {
          throw new AppError("Voucher not found", 404);
        }

        if (oldVoucher.status === "approved" && !data.forceUpdate) {
          throw new AppError("Cannot update approved voucher", 400);
        }

        let needReprocess = false;
        if (
          data.totalAmount ||
          data.entries ||
          data.debitAccount ||
          data.creditAccount ||
          data.linkedInvoices ||
          data.paymentMode ||
          data.paymentDetails ||
          data.fromAccount ||
          data.toAccount ||
          data.voucherType === "receipt" ||
          data.voucherType === "payment" ||
          data.voucherType === "contra" ||
          data.voucherType === "journal"
        ) {
          await this.reverseLedgerEntries(id, session);
          await this.reverseAllocations(oldVoucher, session);

          // Reverse old cashBalance adjustment
          if (oldVoucher.partyType && oldVoucher.onAccountAmount > 0) {
            await this.adjustPartyCashBalance(
              oldVoucher.partyId,
              oldVoucher.partyType,
              oldVoucher.onAccountAmount,
              session,
              "subtract"
            );
          }

          // Reverse Transactor balance changes for contra or journal vouchers
          if (
            oldVoucher.voucherType === "contra" &&
            oldVoucher.fromAccountId &&
            oldVoucher.toAccountId
          ) {
            await this.reverseContraBalances(oldVoucher, session);
          } else if (oldVoucher.voucherType === "journal" && oldVoucher.entries && oldVoucher.entries.length >= 2) {
            await this.reverseJournalBalances(oldVoucher, session);
          }

          needReprocess = true;
        }

        // Handle attachments: merge old + new
        if (data.attachments && data.attachments.length > 0) {
          oldVoucher.attachments = [...(oldVoucher.attachments || []), ...data.attachments];
        }

        if (needReprocess) {
          const processData = { ...oldVoucher.toObject(), ...data };
          let processedData;
          switch (oldVoucher.voucherType) {
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
          Object.assign(oldVoucher, processedData);
        } else {
          Object.assign(oldVoucher, data);
        }

        oldVoucher.updatedBy = updatedBy;
        await oldVoucher.save({ session });

        if (needReprocess && oldVoucher.status === "approved") {
          await this.createLedgerEntries(oldVoucher, updatedBy, session);
        }

        await session.commitTransaction();
        return {
          ...oldVoucher.toObject(),
          linkedInvoices: oldVoucher.linkedInvoices ? oldVoucher.linkedInvoices.map((inv) => ({
            invoiceId: inv.invoiceId,
            amount: inv.allocatedAmount,
            balance: inv.newBalance,
          })) : [],
        };
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
  }

  // Reverse journal voucher balance changes in Transactor
  static async reverseJournalBalances(voucher, session) {
    if (!voucher.entries || voucher.entries.length < 2) {
      return;
    }

    const reversalPromises = voucher.entries.map(async (entry) => {
      if (!mongoose.Types.ObjectId.isValid(entry.accountId)) {
        return;
      }
      const account = await Transactor.findById(entry.accountId).select('currentBalance').session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance -= netChange; // Reverse the original effect
        account.updatedAt = new Date();
        await account.save({ session });
      }
    });

    await Promise.all(reversalPromises);
    console.log(`[Journal Reversal] Reversed balances for voucher ${voucher.voucherNo}`);
  }

  // Reverse contra voucher balance changes in Transactor
  static async reverseContraBalances(voucher, session) {
    if (!voucher.fromAccountId || !voucher.toAccountId || !voucher.totalAmount) {
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(voucher.fromAccountId) || !mongoose.Types.ObjectId.isValid(voucher.toAccountId)) {
      return; // Invalid IDs, skip
    }

    const [fromAccount, toAccount] = await Promise.all([
      Transactor.findById(voucher.fromAccountId).select('currentBalance').session(session),
      Transactor.findById(voucher.toAccountId).select('currentBalance').session(session),
    ]);

    if (fromAccount) {
      fromAccount.currentBalance += voucher.totalAmount;
      fromAccount.updatedAt = new Date();
      await fromAccount.save({ session });
    }

    if (toAccount) {
      toAccount.currentBalance -= voucher.totalAmount;
      toAccount.updatedAt = new Date();
      await toAccount.save({ session });
    }

    console.log(`[Contra Reversal] Reversed ${voucher.totalAmount} between accounts`);
  }

  // Approve/Reject voucher - With retry
  static async processVoucherApproval(id, action, approvedBy, comments) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid voucher ID", 400);
    }

    return this.withTransactionRetry(async () => {
      const session = await mongoose.startSession({
        defaultTransactionOptions: { maxTimeMS: 120000 },
      });
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
          linkedInvoices: voucher.linkedInvoices ? voucher.linkedInvoices.map((inv) => ({
            invoiceId: inv.invoiceId,
            amount: inv.allocatedAmount,
            balance: inv.newBalance,
          })) : [],
        };
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
  }

  // Delete voucher (reverse entries and mark as cancelled) - With retry
  static async deleteVoucher(id, deletedBy) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid voucher ID", 400);
    }

    return this.withTransactionRetry(async () => {
      const session = await mongoose.startSession({
        defaultTransactionOptions: { maxTimeMS: 120000 },
      });
      session.startTransaction();

      try {
        const voucher = await Voucher.findById(id).session(session);
        if (!voucher) {
          throw new AppError("Voucher not found", 404);
        }

        if (voucher.status === "approved") {
          await this.reverseLedgerEntries(id, session);
          await this.reverseAllocations(voucher, session);

          // Reverse cashBalance adjustment
          if (voucher.partyType && voucher.onAccountAmount > 0) {
            await this.adjustPartyCashBalance(
              voucher.partyId,
              voucher.partyType,
              voucher.onAccountAmount,
              session,
              "subtract"
            );
          }

          // Reverse Transactor balance changes for contra or journal vouchers
          if (
            voucher.voucherType === "contra" &&
            voucher.fromAccountId &&
            voucher.toAccountId
          ) {
            await this.reverseContraBalances(voucher, session);
          } else if (voucher.voucherType === "journal" && voucher.entries && voucher.entries.length >= 2) {
            await this.reverseJournalBalances(voucher, session);
          }
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
    });
  }

  // Reverse ledger entries - Optimized with parallel reversals
  static async reverseLedgerEntries(voucherId, session) {
    const entries = await LedgerEntry.find({ voucherId }).session(session);

    const reversalPromises = entries.map(async (entry) => {
      const reversalEntry = {
        ...entry.toObject(),
        _id: undefined,
        debitAmount: entry.creditAmount,
        creditAmount: entry.debitAmount,
        narration: `Reversal: ${entry.narration}`,
        createdAt: new Date(),
      };

      await LedgerEntry.create([reversalEntry], { session });

      // Only update LedgerAccount balances, not Transactor
      const account = await LedgerAccount.findById(entry.accountId).select('accountType currentBalance').session(session);
      if (account) {
        const originalNetChange = entry.debitAmount - entry.creditAmount;
        if (["asset", "expense"].includes(account.accountType)) {
          account.currentBalance -= originalNetChange;
        } else {
          account.currentBalance += originalNetChange;
        }
        await account.save({ session });
      }
    });

    await Promise.all(reversalPromises);

    await LedgerEntry.updateMany(
      { voucherId },
      { $set: { isReversed: true, reversedAt: new Date() } },
      { session }
    );
  }

  // Reverse allocations on linked invoices - Parallel
  static async reverseAllocations(voucher, session) {
    if (!voucher.linkedInvoices || voucher.linkedInvoices.length === 0) return;

    const reversalPromises = voucher.linkedInvoices.map(async (linked) => {
      if (!mongoose.Types.ObjectId.isValid(linked.invoiceId)) return;
      const invoice = await Transaction.findById(linked.invoiceId).session(session);
      if (invoice) {
        invoice.paidAmount -= linked.allocatedAmount;
        invoice.outstandingAmount += linked.allocatedAmount;
        if (invoice.paidAmount < 0) invoice.paidAmount = 0;
        if (invoice.outstandingAmount > invoice.totalAmount) invoice.outstandingAmount = invoice.totalAmount;
        invoice.status = invoice.outstandingAmount === invoice.totalAmount ? "unpaid" :
                         invoice.outstandingAmount === 0 ? "paid" : "partial";
        await invoice.save({ session });
      }
    });

    await Promise.all(reversalPromises);
  }

  // Get financial reports - Optimized aggregations with early match
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

  // Trial Balance Report - Early match in aggregate
  static async getTrialBalance(dateFrom, dateTo) {
    const matchConditions = { status: "approved" }; // Only approved
    if (dateFrom || dateTo) {
      matchConditions.date = {};
      if (dateFrom) matchConditions.date.$gte = new Date(dateFrom);
      if (dateTo) matchConditions.date.$lte = new Date(dateTo);
    }

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
          pipeline: [{ $project: { accountType: 1 } }], // Optimize lookup
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

  // Cash Flow Report - Early match
  static async getCashFlowReport(dateFrom, dateTo) {
    const matchConditions = { voucherType: { $in: ["receipt", "payment", "contra"] }, status: "approved" };
    if (dateFrom || dateTo) {
      matchConditions.date = {};
      if (dateFrom) matchConditions.date.$gte = new Date(dateFrom);
      if (dateTo) matchConditions.date.$lte = new Date(dateTo);
    }

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

  // Expense Summary Report - Early match
  static async getExpenseSummary(dateFrom, dateTo) {
    const matchConditions = { voucherType: "expense", status: "approved" };
    if (dateFrom || dateTo) {
      matchConditions.date = {};
      if (dateFrom) matchConditions.date.$gte = new Date(dateFrom);
      if (dateTo) matchConditions.date.$lte = new Date(dateTo);
    }

    const expenseSummary = await Voucher.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: "expensecategories",
          localField: "expenseCategoryId",
          foreignField: "_id",
          as: "category",
          pipeline: [{ $project: { categoryName: 1 } }],
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

  // Party Statement (Customer/Vendor) - With lean()
  static async getPartyStatement(partyId, partyType, dateFrom, dateTo) {
    if (!partyId || !partyType || !mongoose.Types.ObjectId.isValid(partyId)) {
      throw new AppError("Valid Party ID and type are required for statement", 400);
    }

    const matchConditions = {
      partyId: new mongoose.Types.ObjectId(partyId),
      partyType,
      status: "approved", // Only approved
    };

    if (dateFrom || dateTo) {
      matchConditions.date = {};
      if (dateFrom) matchConditions.date.$gte = new Date(dateFrom);
      if (dateTo) matchConditions.date.$lte = new Date(dateTo);
    }

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
        linkedInvoices: voucher.linkedInvoices ? voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })) : [],
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

  // Get dashboard statistics - Optimized aggregate with early match
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
      .populate("linkedInvoices.invoiceId")
      .lean();

    return {
      monthlyStats: stats,
      pendingApprovals,
      recentTransactions: recentTransactions.map((voucher) => ({
        ...voucher,
        linkedInvoices: voucher.linkedInvoices ? voucher.linkedInvoices.map((inv) => ({
          invoiceId: inv.invoiceId,
          amount: inv.allocatedAmount,
          balance: inv.newBalance,
        })) : [],
      })),
    };
  }
}

module.exports = FinancialService;