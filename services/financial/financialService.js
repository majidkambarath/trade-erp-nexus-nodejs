const {
  Voucher,
  LedgerAccount,
  LedgerEntry,
} = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const ExpenseType = require("../../models/modules/financial/expenseTypeModel");
const Vendor = require("../../models/modules/vendorModel");
const Transaction = require("../../models/modules/transactionModel");
const Transactor = require("../../models/modules/financial/transactorModel");
const AppError = require("../../utils/AppError");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const { CLOSING_VOUCHER_TYPE } = require("../../utils/yearEnd");
const { applyBalances } = require("./ledgerBalances");
const { naturalBalance, categoryOf } = require("../../utils/accounting");
const mongoose = require("mongoose");
const { ensurePartyAccount } = require("./partyAccounts");
const LedgerVoucherService = require("./ledgerVoucherService");
const FxVoucherService = require("./fxVoucherService");
const ReconciliationGuard = require("../banking/reconciliationGuard");
const DebitLog = require("../../models/modules/DebitLog"); // ADD THIS
const CreditLog = require("../../models/modules/CreditLog"); // ADD THIS

class FinancialService {
  // Generate voucher number based on type
  // Voucher numbers come from NumberSeriesService (one atomic counter per series and fiscal
  // year). The previous generator used a random 3-digit suffix and collided.
  static async generateVoucherNo(type, date, session) {
    return NumberSeriesService.allocate(NumberSeriesService.forVoucherType(type), date, { session });
  }

  // Helper: Centralized cash balance adjustment (for Customer/Vendor)
  static async adjustPartyCashBalance(
    partyId,
    partyType,
    amount,
    session,
    operation = "add"
  ) {
    if (!partyId || amount <= 0 || !mongoose.Types.ObjectId.isValid(partyId))
      return; // Early exit

    const PartyModel = partyType === "Customer" ? Customer : Vendor;
    const party = await PartyModel.findById(partyId)
      .select("cashBalance")
      .session(session);
    if (!party) {
      throw new AppError(`${partyType} not found`, 404);
    }

    const delta = operation === "add" ? amount : -amount;
    party.cashBalance = Math.max(0, (party.cashBalance || 0) + delta);
    await party.save({ session });
    console.log(
      `[CashBalance] ${partyType} ${partyId}: Adjusted by ${delta} (new: ${party.cashBalance})`
    );
  }

  // Retry wrapper for transactions to handle TransientTransactionError
  static async withTransactionRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (
          error.name === "MongoServerError" &&
          error.code === 251 &&
          attempt < maxRetries
        ) {
          console.log(
            `[Retry] Transaction attempt ${attempt} failed: ${error.message}. Retrying...`
          );
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt)); // Exponential backoff
          continue;
        }
        throw error;
      }
    }
  }

  // Create any type of voucher (with retry and optimized session). Pass a session as the third
  // argument to post INSIDE the caller's transaction: the voucher then commits or rolls back with
  // whatever else the caller writes (a bank statement match), and the caller does the committing.
  static async createVoucher(data, createdBy, outerSession) {
    const run = async () => {
      const session = outerSession || (await mongoose.startSession({
        defaultTransactionOptions: { maxTimeMS: 120000 }, // 120s timeout
      }));
      if (!outerSession) session.startTransaction();

      try {
        const { voucherType, attachments = [], ...voucherData } = data;

        if (!voucherType) {
          throw new AppError("Voucher type is required", 400);
        }
        // only receipts and payments can be made in a foreign currency; anything else would post the
        // foreign figure as if it were AED
        if (!["receipt", "payment"].includes(voucherType)) await FxVoucherService.assertBaseCurrencyOnly(voucherData, { session });

        const postingDate = voucherData.date || new Date();
        await FiscalYearService.assertPostingAllowed(postingDate, { session });
        const voucherNo = await this.generateVoucherNo(voucherType, postingDate, session);
        console.log(
          `[Transaction] Started for voucher ${voucherNo} with session ${session.id}`
        );

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
            // rows on the chart of accounts, or the older two-account form
            processedData = Array.isArray(voucherData.lines)
              ? await LedgerVoucherService.processJournal(voucherData, session)
              : await this.processJournalVoucher(voucherData, session);
            break;
          case "contra":
            processedData = voucherData.ledgerBased
              ? await LedgerVoucherService.processContra(voucherData, session)
              : await this.processContraVoucher(voucherData, session);
            break;
          case "expense":
            processedData = voucherData.ledgerBased
              ? await LedgerVoucherService.processExpense(voucherData, session, { PaymentModeService: require("../banking/paymentModeService") })
              : await this.processExpenseVoucher(voucherData, session);
            break;
          case "debit_note":
          case "credit_note":
            processedData = await this.processNoteWithBalance(voucherData, session, voucherType);
            break;
          default:
            throw new AppError("Invalid voucher type", 400);
        }

        const { _cheque, _vatPercent, ...storable } = processedData;
        processedData = storable;

        const voucherDoc = {
          voucherNo,
          voucherType,
          createdBy,
          attachments,
          ...processedData,
        };

        const voucher = await Voucher.create([voucherDoc], { session });
        const newVoucher = voucher[0];

        // A cheque is recorded in the cheque register; it waits there until it clears.
        if (_cheque) await this.registerCheque(newVoucher, _cheque, voucherType === "receipt" ? "receipt" : "payment", createdBy, session);

        // Create ledger entries only if approved
        if (newVoucher.status === "approved") {
          await this.createLedgerEntries(newVoucher, createdBy, session);
          await this.createPaymentLogEntries(newVoucher, session);
        }

        if (!outerSession) await session.commitTransaction();
        console.log(`[Transaction] Committed for voucher ${voucherNo}`);
        return newVoucher;
      } catch (error) {
        if (!outerSession) await session.abortTransaction();
        console.error(`[Transaction] Aborted for voucher: ${error.message}`);
        throw error;
      } finally {
        if (!outerSession) session.endSession();
      }
    };
    // inside a caller's transaction there is nothing to retry from here: the caller owns it
    return outerSession ? run() : this.withTransactionRetry(run);
  }

  // Process Receipt Voucher (money received from customer) - Optimized with projections and validation
  static async processReceiptVoucher(data, session) {
    const {
      date = new Date(),
      customerId,
      customerName,
      linkedInvoices = [],
      paymentMode,
      narration,
      paymentDetails = {
        bankDetails: null,
        chequeDetails: null,
        onlineDetails: null,
      },
    } = data;

    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      throw new AppError(
        "Valid Customer ID is required for receipt voucher",
        400
      );
    }

    // Validate customer exists (with projection)
    const customer = await Customer.findById(customerId)
      .select("customerName")
      .session(session);
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // A foreign-currency receipt is converted to AED here, once; everything below (the payment
    // mode, allocation to invoices, the amount kept on account, the ledger) works in that AED
    // amount. Settling foreign-currency INVOICES (exchange gain/loss) is phase 2.
    const fx = await FxVoucherService.resolve(data, { session });
    const totalAmount = fx.totalAmount;

    // Validate the payment mode and work out where the money goes (cash or bank account, the
    // cheques account until a cheque clears, a card's settlement account less its fee...)
    const money = await require("../banking/paymentModeService").resolve({
      direction: "receipt", mode: paymentMode, details: paymentDetails, amount: totalAmount, date,
      description: `Receipt from ${customer.customerName}`, session,
    });

    // Validate and allocate linked invoices (parallel fetch for optimization)
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      const invoicePromises = linkedInvoices.map(async (linked) => {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0 || !mongoose.Types.ObjectId.isValid(invoiceId)) {
          throw new AppError(
            `Invalid allocation for invoice ${invoiceId}`,
            400
          );
        }

        const invoice = await Transaction.findById(invoiceId).session(session);
        if (!invoice) {
          throw new AppError(`Invoice not found: ${invoiceId}`, 404);
        }
        if (
          invoice.partyId.toString() !== customerId.toString() ||
          invoice.partyType !== "Customer"
        ) {
          throw new AppError(
            `Invoice ${invoiceId} does not belong to this customer`,
            400
          );
        }

        const current = invoice.outstandingAmount;
        if (Math.abs(current - (allocated + expectedNew)) > 0.01) {
          throw new AppError(
            `Invoice balance mismatch for ${invoiceId}. Expected: ${current}, Provided: ${
              allocated + expectedNew
            }`,
            409
          );
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        // Whether it is paid is paidAmount / outstandingAmount. The document's status stays
        // APPROVED: overwriting it made a part-paid invoice disappear from ageing, returns, credit
        // control and deletion, which all look for APPROVED documents.
        await invoice.save({ session });

        return {
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        };
      });

      validatedInvoices = await Promise.all(invoicePromises); // Parallel processing
      totalAllocated = validatedInvoices.reduce(
        (sum, inv) => sum + inv.allocatedAmount,
        0
      );
    }

    const onAccountAmount = totalAmount - totalAllocated;
    if (onAccountAmount < 0) {
      throw new AppError("Allocated amount cannot exceed total amount", 400);
    }

    // Update customer cashBalance for on-account
    await this.adjustPartyCashBalance(
      customerId,
      "Customer",
      onAccountAmount,
      session,
      "add"
    );

    // Create entries for double-entry accounting (parallel fetch)
    const customerAccount =
      totalAllocated > 0
        ? await this.getOrCreateCustomerAccount(customerId, customer.customerName, session)
        : null;

    const entries = [];

    // Debit: where the money went (cash / bank / cheques in hand / card settlement, and any card fee)
    entries.push(...FxVoucherService.stampLegs(money.legs, fx));

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
      const advanceAccount = await this.getOrCreateCustomerAdvanceAccount(
        customerId,
        customer.customerName,
        session
      );
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
      paymentMode: money.mode,
      paymentDetails: money.details,
      _cheque: money.cheque,
      ...fx.fields,
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
      narration,
      paymentDetails = {
        bankDetails: null,
        chequeDetails: null,
        onlineDetails: null,
      },
    } = data;

    if (!vendorId || !mongoose.Types.ObjectId.isValid(vendorId)) {
      throw new AppError(
        "Valid Vendor ID is required for payment voucher",
        400
      );
    }

    // Validate vendor exists
    const vendor = await Vendor.findById(vendorId)
      .select("vendorName")
      .session(session);
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }

    // A foreign-currency payment is converted to AED here, once; see processReceiptVoucher.
    const fx = await FxVoucherService.resolve(data, { session });
    const totalAmount = fx.totalAmount;

    // Validate the payment mode and work out where the money comes from
    const money = await require("../banking/paymentModeService").resolve({
      direction: "payment", mode: paymentMode, details: paymentDetails, amount: totalAmount, date,
      description: `Payment to ${vendor.vendorName}`, session,
    });

    // Validate and allocate linked invoices (parallel)
    let validatedInvoices = [];
    let totalAllocated = 0;
    if (linkedInvoices.length > 0) {
      const invoicePromises = linkedInvoices.map(async (linked) => {
        const { invoiceId, amount: allocated, balance: expectedNew } = linked;
        if (allocated <= 0 || !mongoose.Types.ObjectId.isValid(invoiceId)) {
          throw new AppError(
            `Invalid allocation for invoice ${invoiceId}`,
            400
          );
        }

        const invoice = await Transaction.findById(invoiceId).session(session);
        if (!invoice) {
          throw new AppError(`Invoice not found: ${invoiceId}`, 404);
        }
        if (
          invoice.partyId.toString() !== vendorId.toString() ||
          invoice.partyType !== "Vendor"
        ) {
          throw new AppError(
            `Invoice ${invoiceId} does not belong to this vendor`,
            400
          );
        }

        const current = invoice.outstandingAmount;
        if (Math.abs(current - (allocated + expectedNew)) > 0.01) {
          throw new AppError(
            `Invoice balance mismatch for ${invoiceId}. Expected: ${current}, Provided: ${
              allocated + expectedNew
            }`,
            409
          );
        }

        invoice.paidAmount += allocated;
        invoice.outstandingAmount = expectedNew;
        // Whether it is paid is paidAmount / outstandingAmount. The document's status stays
        // APPROVED: overwriting it made a part-paid invoice disappear from ageing, returns, credit
        // control and deletion, which all look for APPROVED documents.
        await invoice.save({ session });

        return {
          invoiceId: invoice._id,
          allocatedAmount: allocated,
          previousBalance: current,
          newBalance: expectedNew,
        };
      });

      validatedInvoices = await Promise.all(invoicePromises);
      totalAllocated = validatedInvoices.reduce(
        (sum, inv) => sum + inv.allocatedAmount,
        0
      );
    }

    const onAccountAmount = totalAmount - totalAllocated;
    if (onAccountAmount < 0) {
      throw new AppError("Allocated amount cannot exceed total amount", 400);
    }

    // Update vendor cashBalance for on-account
    await this.adjustPartyCashBalance(
      vendorId,
      "Vendor",
      onAccountAmount,
      session,
      "add"
    );

    // Create entries (parallel fetch)
    const vendorAccount =
      totalAllocated > 0
        ? await this.getOrCreateVendorAccount(vendorId, vendor.vendorName, session)
        : null;

    const entries = [];

    // Credit: where the money came from (cash / bank / cheques issued / card)
    entries.push(...FxVoucherService.stampLegs(money.legs, fx));

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
      const advanceAccount = await this.getOrCreateVendorAdvanceAccount(
        vendorId,
        vendor.vendorName,
        session
      );
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
      paymentMode: money.mode,
      paymentDetails: money.details,
      _cheque: money.cheque,
      ...fx.fields,
      totalAmount,
      onAccountAmount,
      narration,
      entries,
      status: "approved",
    };
  }

  // Records the cheque behind a receipt or payment voucher and links it to the voucher.
  static async registerCheque(voucher, cheque, direction, createdBy, session) {
    const ChequeService = require("../banking/chequeService");
    const row = await ChequeService.register({ voucher, cheque, direction, createdBy, session, req: {} });
    voucher.paymentDetails = { ...(voucher.paymentDetails?.toObject?.() || voucher.paymentDetails || {}), chequeId: row._id };
    await voucher.save({ session });
    return row;
  }

  // Debit and credit notes. One that lowers what the party owes and is not set against an invoice
  // is money on account, like an unallocated receipt, so the party's balance moves with it.
  static async processNoteWithBalance(data, session, voucherType) {
    const processed = await LedgerVoucherService.processNote(data, session, { voucherType });
    const reduces = (processed.partyType === "Customer" && voucherType === "credit_note") || (processed.partyType === "Vendor" && voucherType === "debit_note");
    if (reduces && !processed.linkedInvoices.length) {
      processed.onAccountAmount = processed.totalAmount;
      await this.adjustPartyCashBalance(processed.partyId, processed.partyType, processed.totalAmount, session, "add");
    }
    return processed;
  }

  // Everything a posted voucher did, undone: ledger entries, invoice settlements, party logs and the
  // on-account balance. Used by delete, and by a cheque that bounces.
  static async reverseVoucherEffects(voucher, session) {
    await this.reverseLedgerEntries(voucher._id, session);
    await this.reverseAllocations(voucher, session);
    const LogModel = voucher.partyType === "Vendor" ? DebitLog : CreditLog;
    await LogModel.deleteMany({ ref: voucher.voucherNo }, { session });
    if (voucher.partyType && voucher.onAccountAmount > 0) {
      await this.adjustPartyCashBalance(voucher.partyId, voucher.partyType, voucher.onAccountAmount, session, "subtract");
    }
    // The older transactor-based contra and journal vouchers also moved balances on those accounts.
    if (!voucher.ledgerBased) {
      if (voucher.voucherType === "contra" && voucher.fromAccountId && voucher.toAccountId) {
        await this.reverseContraBalances(voucher, session);
      } else if (voucher.voucherType === "journal" && voucher.entries && voucher.entries.length >= 2) {
        await this.reverseJournalBalances(voucher, session);
      }
    }
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
      throw new AppError(
        "Debit account, credit account, and valid total amount are required",
        400
      );
    }

    if (debitAccount === creditAccount) {
      throw new AppError("Debit and credit accounts cannot be the same", 400);
    }

    // Fetch accounts from Transactor collection by accountCode (parallel)
    const [debitAccountDoc, creditAccountDoc] = await Promise.all([
      Transactor.findOne({
        accountCode: debitAccount,
        isActive: true,
        deletedAt: null,
      })
        .select(
          "accountCode accountName accountType allowDirectPosting currentBalance"
        )
        .session(session),
      Transactor.findOne({
        accountCode: creditAccount,
        isActive: true,
        deletedAt: null,
      })
        .select(
          "accountCode accountName accountType allowDirectPosting currentBalance"
        )
        .session(session),
    ]);

    // Validate accounts exist
    if (!debitAccountDoc) {
      throw new AppError(
        `Debit account not found or inactive: ${debitAccount}`,
        404
      );
    }
    if (!creditAccountDoc) {
      throw new AppError(
        `Credit account not found or inactive: ${creditAccount}`,
        404
      );
    }

    // Validate direct posting
    if (!debitAccountDoc.allowDirectPosting) {
      throw new AppError(
        `Direct posting not allowed for account: ${debitAccountDoc.accountName} (${debitAccountDoc.accountCode})`,
        400
      );
    }
    if (!creditAccountDoc.allowDirectPosting) {
      throw new AppError(
        `Direct posting not allowed for account: ${creditAccountDoc.accountName} (${creditAccountDoc.accountCode})`,
        400
      );
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

    console.log(
      `[Journal] Debit ${totalAmount} to ${debitAccountDoc.accountName} (${debitAccountDoc.accountCode}), Credit ${totalAmount} from ${creditAccountDoc.accountName} (${creditAccountDoc.accountCode})`
    );

    // Create entries for double-entry accounting
    const entries = [
      {
        accountId: debitAccountDoc._id,
        accountName: debitAccountDoc.accountName,
        accountCode: debitAccountDoc.accountCode,
        debitAmount: totalAmount,
        creditAmount: 0,
        description:
          narration || `Journal entry debiting ${debitAccountDoc.accountName}`,
      },
      {
        accountId: creditAccountDoc._id,
        accountName: creditAccountDoc.accountName,
        accountCode: creditAccountDoc.accountCode,
        debitAmount: 0,
        creditAmount: totalAmount,
        description:
          narration ||
          `Journal entry crediting ${creditAccountDoc.accountName}`,
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
      throw new AppError(
        "From and To account codes are required for contra voucher",
        400
      );
    }

    if (!totalAmount || totalAmount <= 0) {
      throw new AppError("Valid amount is required for contra voucher", 400);
    }

    if (fromAccount === toAccount) {
      throw new AppError("From and To accounts cannot be the same", 400);
    }

    // Fetch accounts by accountCode (parallel)
    const [fromAccountDoc, toAccountDoc] = await Promise.all([
      Transactor.findOne({
        accountCode: fromAccount,
        isActive: true,
        deletedAt: null,
      })
        .select(
          "accountCode accountName accountType allowDirectPosting currentBalance"
        )
        .session(session),
      Transactor.findOne({
        accountCode: toAccount,
        isActive: true,
        deletedAt: null,
      })
        .select(
          "accountCode accountName accountType allowDirectPosting currentBalance"
        )
        .session(session),
    ]);

    // Validate accounts exist
    if (!fromAccountDoc) {
      throw new AppError(
        `From account not found or inactive: ${fromAccount}`,
        404
      );
    }
    if (!toAccountDoc) {
      throw new AppError(`To account not found or inactive: ${toAccount}`, 404);
    }

    // Validate both accounts allow direct posting
    if (!fromAccountDoc.allowDirectPosting) {
      throw new AppError(
        `Direct posting not allowed for account: ${fromAccountDoc.accountName} (${fromAccountDoc.accountCode})`,
        400
      );
    }
    if (!toAccountDoc.allowDirectPosting) {
      throw new AppError(
        `Direct posting not allowed for account: ${toAccountDoc.accountName} (${toAccountDoc.accountCode})`,
        400
      );
    }

    // Validate sufficient balance in fromAccount
    if (fromAccountDoc.currentBalance < totalAmount) {
      throw new AppError(
        `Insufficient balance in ${fromAccountDoc.accountName}. Available: ${fromAccountDoc.currentBalance}, Required: ${totalAmount}`,
        400
      );
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

    console.log(
      `[Contra] Transfer ${totalAmount} from ${fromAccountDoc.accountName} (${fromAccountDoc.accountCode}) to ${toAccountDoc.accountName} (${toAccountDoc.accountCode})`
    );

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
      narration:
        narration ||
        `Fund transfer from ${fromAccountDoc.accountName} to ${toAccountDoc.accountName}`,
      notes: `From: ${fromAccountDoc.accountCode} | To: ${toAccountDoc.accountCode}`,
      entries,
      status: "approved",
    };
  }

  // Process Expense Voucher - Optimized with projections
  static async processExpenseVoucher(data, session) {
    const {
      date = new Date(),
      mainExpenseCategoryId,
      expenseCategoryId,
      transactorId,
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

    // Validate required fields
    if (
      !mainExpenseCategoryId ||
      !mongoose.Types.ObjectId.isValid(mainExpenseCategoryId)
    ) {
      throw new AppError("Valid Expense type ID is required", 400);
    }
    // Validate required fields
    if (
      !expenseCategoryId ||
      !mongoose.Types.ObjectId.isValid(expenseCategoryId)
    ) {
      throw new AppError("Valid Expense type ID is required", 400);
    }

    if (!transactorId || !mongoose.Types.ObjectId.isValid(transactorId)) {
      throw new AppError(
        "Valid Transactor ID is required for expense payment",
        400
      );
    }

    if (!totalAmount || totalAmount <= 0) {
      throw new AppError("Valid total amount is required", 400);
    }

    if (!description || description.trim() === "") {
      throw new AppError("Description is required for expense voucher", 400);
    }

    // Validate payment mode and details
    if (!["cash", "bank", "cheque", "online"].includes(paymentMode)) {
      throw new AppError("Invalid payment mode", 400);
    }

    if (
      paymentMode === "cheque" &&
      !paymentDetails.chequeDetails?.chequeNumber
    ) {
      throw new AppError("Cheque details required for cheque payment", 400);
    }

    if (
      paymentMode === "online" &&
      !paymentDetails.onlineDetails?.transactionId
    ) {
      throw new AppError(
        "Online transaction details required for online payment",
        400
      );
    }

    if (paymentMode === "bank" && !paymentDetails.bankDetails?.accountNumber) {
      throw new AppError("Bank details required for bank payment", 400);
    }

    // Parallel fetch: expense type and transactor (payment source)
    const [expenseType, transactor] = await Promise.all([
      ExpenseType.findById(mainExpenseCategoryId)
        .select("name")
        .session(session),
      Transactor.findById(transactorId)
        .select(
          "accountCode accountName accountType currentBalance isActive allowDirectPosting"
        )
        .session(session),
    ]);

    if (!expenseType) {
      throw new AppError("Expense type not found", 404);
    }

    if (!transactor) {
      throw new AppError("Transactor account not found", 404);
    }

    // Validate transactor is active and allows direct posting
    if (!transactor.isActive) {
      throw new AppError(
        `Transactor account is inactive: ${transactor.accountName}`,
        400
      );
    }

    if (!transactor.allowDirectPosting) {
      throw new AppError(
        `Direct posting not allowed for account: ${transactor.accountName} (${transactor.accountCode})`,
        400
      );
    }

    // Validate sufficient balance in transactor account
    if (transactor.currentBalance < totalAmount) {
      throw new AppError(
        `Insufficient balance in ${transactor.accountName}. Available: ${transactor.currentBalance}, Required: ${totalAmount}`,
        400
      );
    }

    // Create entries for double-entry accounting using Transactor accounts
    // Debit: Transactor account marked as expense type (increases expense)
    // Credit: Payment source Transactor (decreases cash/bank)

    // Get or create expense transactor account based on expense type
    let expenseTransactor = await Transactor.findOne({
      accountType: "expense",
      isActive: true,
      deletedAt: null,
    })
      .select("_id accountCode accountName currentBalance")
      .session(session);

    if (!expenseTransactor) {
      throw new AppError("No active expense transactor account found", 400);
    }

    // Create entries - both using Transactor accounts
    const entries = [
      {
        accountId: expenseTransactor._id,
        accountName: expenseTransactor.accountName,
        accountCode: expenseTransactor.accountCode,
        debitAmount: totalAmount,
        creditAmount: 0,
        description: `${description} (${expenseType.name})`,
        taxPercent: 0,
        taxAmount: 0,
      },
      {
        accountId: transactor._id,
        accountName: transactor.accountName,
        accountCode: transactor.accountCode,
        debitAmount: 0,
        creditAmount: totalAmount,
        description: `Expense payment - ${expenseType.name}`,
        taxPercent: 0,
        taxAmount: 0,
      },
    ];

    // Update both transactor balances
    // Credit account: reduce balance (payment out)
    transactor.currentBalance -= totalAmount;
    transactor.updatedAt = new Date();

    // Debit account: increase balance (expense in)
    expenseTransactor.currentBalance += totalAmount;
    expenseTransactor.updatedAt = new Date();

    await Promise.all([
      transactor.save({ session }),
      expenseTransactor.save({ session }),
    ]);

    console.log(
      `[Expense] Type: ${expenseType.name}, Amount: ${totalAmount}, From: ${transactor.accountName} (${transactor.accountCode}), To: ${expenseTransactor.accountName}`
    );

    // Determine approval status based on transactor settings
    const requiresApproval =
      transactor.requiresApproval &&
      (transactor.approvalLimit === 0 ||
        totalAmount > transactor.approvalLimit);

    return {
      date,
      mainExpenseCategoryId,
      expenseCategoryId,
      expenseTypeName: expenseType.name,
      transactorId,
      transactorName: transactor.accountName,
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
    return ensurePartyAccount("customer", customerId, customerName, { session: session });
  }

  // Helper: Get or create customer advance account (liability)
  static async getOrCreateCustomerAdvanceAccount(customerId, customerName, session) {
    return ensurePartyAccount("customerAdvance", customerId, customerName, { session: session });
  }

  // Helper: Get or create vendor payable account (liability)
  static async getOrCreateVendorAccount(vendorId, vendorName, session) {
    return ensurePartyAccount("vendor", vendorId, vendorName, { session: session });
  }

  // Helper: Get or create vendor advance account (asset)
  static async getOrCreateVendorAdvanceAccount(vendorId, vendorName, session) {
    return ensurePartyAccount("vendorAdvance", vendorId, vendorName, { session: session });
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
      // money-side legs of a foreign-currency voucher (AED amounts above; see fxVoucherService.js)
      currency: entry.currency,
      exchangeRate: entry.exchangeRate,
      amountForeign: entry.amountForeign,
      createdBy,
    }));

    await LedgerEntry.insertMany(ledgerEntries, { session });

    // Update account balances - Skip for Transactor accounts (handled in processJournalVoucher and processContraVoucher)
    if (voucher.ledgerBased || (voucher.voucherType !== "contra" && voucher.voucherType !== "journal")) {
      await this.updateAccountBalances(voucher.entries, session);
    }
  }

 static async createPaymentLogEntries(voucher, session) {
  const {
    voucherType,
    linkedInvoices = [],
    partyId,
    partyType,
    voucherNo,
    _id: voucherId,
    date,
    createdBy,
  } = voucher;

  if (linkedInvoices.length === 0) return;

  const isPayment = voucherType === "payment";
  const isReceipt = voucherType === "receipt";
  if (!isPayment && !isReceipt) return;

  const LogModel = isPayment ? DebitLog : CreditLog;
  const partyField = isPayment ? "vendorId" : "customerId";
  const logType = isPayment ? "payment_received" : "payment_made";

  // POPULATE invoiceId to get transactionNo
  const populatedInvoices = await Voucher.populate(voucher, {
    path: "linkedInvoices.invoiceId",
    select: "transactionNo totalAmount",
    model: "Transaction",
  });

  const logs = [];

  for (const link of populatedInvoices.linkedInvoices) {
    const { invoiceId, allocatedAmount, previousBalance, newBalance } = link;

    // Now invoiceId is populated → we can safely access transactionNo
    const invNo = invoiceId?.transactionNo || invoiceId.toString();

    logs.push({
      [partyField]: partyId,
      type: logType,
      date: date || new Date(),
      invNo,
      amount: -allocatedAmount,           // Tally style: payment reduces balance
      paid: allocatedAmount,
      balance: newBalance,
      ref: voucherNo,
      status: newBalance <= 0 ? "PAID" : "PARTIAL",
      createdBy,
    });
  }

  if (logs.length > 0) {
    await LogModel.insertMany(logs, { session });
  }
}

  // Update account balances after posting - Parallel updates
  // One increment per account, however many lines the voucher has on it: reading each account and saving it back
  // in parallel loses an update when two lines name the same account (a journal with two lines on one account,
  // a closing entry that credits Retained Earnings once per branch).
  static async updateAccountBalances(entries, session) {
    await applyBalances(entries.filter((entry) => mongoose.Types.ObjectId.isValid(entry.accountId)), session);
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
    })
      .select("accountCode accountName")
      .session(session);

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
      console.log(`[Account] Created system account: ${accountName}`);
    }

    // Optional: In-memory cache for high-frequency access (implement with Redis for prod)
    // if (!global.cashBankCache) global.cashBankCache = new Map();
    // if (!global.cashBankCache.has(accountName)) global.cashBankCache.set(accountName, account);

    return account;
  }

  // Helper method to check if account is cash/bank type (for LedgerAccount)
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

  // Helper method to check if Transactor account is cash/bank type
  static isCashBankAccountTransactor(transactor) {
    const cashBankPrefixes = ["CAS", "BAN", "PET"];
    const cashBankKeywords = ["cash", "bank", "petty"];

    const hasValidPrefix = cashBankPrefixes.some((prefix) =>
      transactor.accountCode.startsWith(prefix)
    );
    const hasValidKeyword = cashBankKeywords.some((keyword) =>
      transactor.accountName.toLowerCase().includes(keyword)
    );

    return (
      transactor.accountType === "asset" && (hasValidPrefix || hasValidKeyword)
    );
  }

  // Get all vouchers with filters and pagination - Optimized query with lean()
  static async getAllVouchers(filters = {}) {
    const query = {};

    if (filters.voucherType) query.voucherType = filters.voucherType;
    if (filters.status) query.status = filters.status;
    if (filters.paymentMode) query.paymentMode = filters.paymentMode === "transfer" ? { $in: ["transfer", "online"] } : filters.paymentMode;
    if (filters.partyId && mongoose.Types.ObjectId.isValid(filters.partyId))
      query.partyId = filters.partyId;
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
        // a date with no time means the whole of that day
        if (!isNaN(toDate)) query.date.$lte = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.dateTo)) ? new Date(toDate.getTime() + 86400000 - 1) : toDate;
      }
    }

    // Search functionality
    if (filters.search) {
      const regex = new RegExp(String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); // typed text, not a pattern
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
      .populate("expenseCategoryId", "name")
      .populate("transactorId", "accountCode accountName")
      .populate("linkedInvoices.invoiceId")
      .lean(); // Faster for read-only

    const total = await Voucher.countDocuments(query);

    const formattedVouchers = vouchers.map((voucher) => ({
      ...voucher,
      linkedInvoices: voucher.linkedInvoices
        ? voucher.linkedInvoices.map((inv) => ({
            invoiceId: inv.invoiceId,
            amount: inv.allocatedAmount,
            balance: inv.newBalance,
          }))
        : [],
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
      .populate({
        path: "expenseCategoryId",
        select: "name parentCategory isMainCategory createdBy",
        populate: {
          path: "parentCategory",
          select: "name isMainCategory",
          model: "ExpenseCategory", // Explicit model ref (recommended)
        },
      })
      .populate("transactorId", "accountCode accountName accountType")
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
        linkedInvoices: voucher.linkedInvoices
          ? voucher.linkedInvoices.map((inv) => ({
              invoiceId: inv.invoiceId,
              amount: inv.allocatedAmount,
              balance: inv.newBalance,
            }))
          : [],
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

        // Period lock: nothing may change inside a closed fiscal year.
        await FiscalYearService.assertPostingAllowed(oldVoucher.date, { session });

        if (["bounced", "cancelled"].includes(oldVoucher.status)) {
          throw new AppError(`A ${oldVoucher.status} voucher cannot be edited`, 400, "VOUCHER_VOIDED");
        }
        if (oldVoucher.status === "approved" && !data.forceUpdate) {
          throw new AppError("Cannot update approved voucher", 400);
        }
        // changing a voucher that is waiting for its second approver takes back the first: what was approved is no longer what is there
        if (oldVoucher.status !== "approved" && oldVoucher.approvals?.length) oldVoucher.approvals = [];
        if (!["receipt", "payment"].includes(oldVoucher.voucherType)) await FxVoucherService.assertBaseCurrencyOnly(data, { session });

        let needReprocess = false;
        if (
          data.totalAmount ||
          data.foreignAmount ||
          data.currency ||
          data.exchangeRate ||
          (data.date && oldVoucher.foreignAmount > 0) || // a foreign voucher's rate follows its day
          data.entries ||
          data.debitAccount ||
          data.creditAccount ||
          data.linkedInvoices ||
          data.paymentMode ||
          data.paymentDetails ||
          data.fromAccount ||
          data.toAccount ||
          data.lines ||
          data.amount ||
          data.expenseAccountId ||
          data.referenceInvoiceId ||
          data.voucherType === "receipt" ||
          data.voucherType === "payment" ||
          data.voucherType === "contra" ||
          data.voucherType === "journal" ||
          data.voucherType === "expense" ||
          data.voucherType === "debit_note" ||
          data.voucherType === "credit_note"
        ) {
          // a cheque that has cleared cannot be edited away; one that has not is withdrawn and
          // recorded again below
          if (oldVoucher.paymentMode === "cheque") {
            await require("../banking/chequeService").onVoucherRemoved(oldVoucher, { session, req: {}, adminId: updatedBy, forEdit: true });
          }
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
          if (!oldVoucher.ledgerBased) {
            if (
              oldVoucher.voucherType === "contra" &&
              oldVoucher.fromAccountId &&
              oldVoucher.toAccountId
            ) {
              await this.reverseContraBalances(oldVoucher, session);
            } else if (
              oldVoucher.voucherType === "journal" &&
              oldVoucher.entries &&
              oldVoucher.entries.length >= 2
            ) {
              await this.reverseJournalBalances(oldVoucher, session);
            }
          }

          needReprocess = true;
        }

        // Handle attachments: merge old + new
        if (data.attachments && data.attachments.length > 0) {
          oldVoucher.attachments = [
            ...(oldVoucher.attachments || []),
            ...data.attachments,
          ];
        }

        let updatedCheque = null;
        if (needReprocess) {
          const processData = { ...oldVoucher.toObject(), ...data };
          // a foreign-currency receipt / payment keeps its rate unless the rate, currency or day changes
          FxVoucherService.prepareEdit(oldVoucher, data, processData);
          let processedData;
          // a ledger-based voucher is stored as ledger entries / note lines; hand them back to the
          // processors in the shape they take
          if (oldVoucher.ledgerBased) {
            if (!processData.lines) {
              processData.lines =
                oldVoucher.voucherType === "journal"
                  ? oldVoucher.entries.map((e) => ({ accountId: e.accountId, debit: e.debitAmount, credit: e.creditAmount, narration: e.description }))
                  : (oldVoucher.noteLines || []).map((l) => ({ accountId: l.accountId, description: l.description, amount: l.amount, taxCodeId: l.taxCodeId }));
            }
            if (oldVoucher.voucherType === "expense" && data.amount === undefined) processData.amount = oldVoucher.subtotal;
            if (oldVoucher.voucherType === "expense" && data.vendorId === undefined && oldVoucher.partyId) processData.vendorId = oldVoucher.partyId;
          }
          switch (oldVoucher.voucherType) {
            case "receipt":
              processedData = await this.processReceiptVoucher(processData, session);
              break;
            case "payment":
              processedData = await this.processPaymentVoucher(processData, session);
              break;
            case "journal":
              processedData = oldVoucher.ledgerBased
                ? await LedgerVoucherService.processJournal(processData, session)
                : await this.processJournalVoucher(processData, session);
              break;
            case "contra":
              processedData = oldVoucher.ledgerBased
                ? await LedgerVoucherService.processContra(processData, session)
                : await this.processContraVoucher(processData, session);
              break;
            case "expense":
              processedData = oldVoucher.ledgerBased
                ? await LedgerVoucherService.processExpense(processData, session, { PaymentModeService: require("../banking/paymentModeService") })
                : await this.processExpenseVoucher(processData, session);
              break;
            case "debit_note":
            case "credit_note":
              processedData = await this.processNoteWithBalance(processData, session, oldVoucher.voucherType);
              break;
            default:
              throw new AppError("Invalid voucher type", 400);
          }
          const { _cheque, _vatPercent, ...storable } = processedData;
          processedData = storable;
          updatedCheque = _cheque;
          Object.assign(oldVoucher, processedData);
        } else {
          Object.assign(oldVoucher, data);
        }

        oldVoucher.updatedBy = updatedBy;
        await oldVoucher.save({ session });

        if (needReprocess && oldVoucher.status === "approved") {
          await this.createLedgerEntries(oldVoucher, updatedBy, session);
        }
        if (updatedCheque) {
          await this.registerCheque(oldVoucher, updatedCheque, oldVoucher.voucherType === "receipt" ? "receipt" : "payment", updatedBy, session);
        }

        await session.commitTransaction();
        return {
          ...oldVoucher.toObject(),
          linkedInvoices: oldVoucher.linkedInvoices
            ? oldVoucher.linkedInvoices.map((inv) => ({
                invoiceId: inv.invoiceId,
                amount: inv.allocatedAmount,
                balance: inv.newBalance,
              }))
            : [],
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
      const account = await Transactor.findById(entry.accountId)
        .select("currentBalance")
        .session(session);
      if (account) {
        const netChange = entry.debitAmount - entry.creditAmount;
        account.currentBalance -= netChange; // Reverse the original effect
        account.updatedAt = new Date();
        await account.save({ session });
      }
    });

    await Promise.all(reversalPromises);
    console.log(
      `[Journal Reversal] Reversed balances for voucher ${voucher.voucherNo}`
    );
  }

  // Reverse contra voucher balance changes in Transactor
  static async reverseContraBalances(voucher, session) {
    if (
      !voucher.fromAccountId ||
      !voucher.toAccountId ||
      !voucher.totalAmount
    ) {
      return;
    }

    if (
      !mongoose.Types.ObjectId.isValid(voucher.fromAccountId) ||
      !mongoose.Types.ObjectId.isValid(voucher.toAccountId)
    ) {
      return; // Invalid IDs, skip
    }

    const [fromAccount, toAccount] = await Promise.all([
      Transactor.findById(voucher.fromAccountId)
        .select("currentBalance")
        .session(session),
      Transactor.findById(voucher.toAccountId)
        .select("currentBalance")
        .session(session),
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

    console.log(
      `[Contra Reversal] Reversed ${voucher.totalAmount} between accounts`
    );
  }

  // Approve/Reject voucher - With retry
  static async processVoucherApproval(id, action, approvedBy, comments, options = {}) {
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

        // Period lock: nothing may change inside a closed fiscal year.
        await FiscalYearService.assertPostingAllowed(voucher.date, { session });

        if (!["approve", "reject"].includes(action)) {
          throw new AppError("Invalid action. Use approve or reject", 400);
        }

        if (voucher.status !== "pending" && voucher.status !== "draft") {
          throw new AppError(
            "Voucher is not in a state that can be approved/rejected",
            400
          );
        }

        // May THIS person approve THIS voucher - limits, separate approver, a second approver above an amount
        let approval = null;
        if (action === "approve") {
          const verdict = await require("../core/approvalPolicyService").judge({
            amount: voucher.totalAmount, preparedBy: voucher.createdBy, approvals: voucher.approvals, req: options.req, session,
          });
          if (!verdict.final) {
            // The first of two approvals: kept; the voucher stays pending until a different person gives the second
            voucher.approvals = [...(voucher.approvals || []), verdict.approval];
            await voucher.save({ session });
            await session.commitTransaction();
            return { ...voucher.toObject(), linkedInvoices: [], awaitingSecondApproval: true };
          }
          approval = verdict.approval || null;
        }

        // Update voucher status
        voucher.status = action === "approve" ? "approved" : "rejected";
        voucher.approvalStatus = action === "approve" ? "approved" : "rejected";
        voucher.approvedBy = approvedBy;
        voucher.approvedAt = new Date();
        if (approval) voucher.approvals = require("../../utils/approvalRules").addApproval(voucher.approvals, approval);
        else if (action === "reject") voucher.approvals = [];

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
          await this.createPaymentLogEntries(voucher, session);
        }

        await session.commitTransaction();
        return {
          ...voucher.toObject(),
          linkedInvoices: voucher.linkedInvoices
            ? voucher.linkedInvoices.map((inv) => ({
                invoiceId: inv.invoiceId,
                amount: inv.allocatedAmount,
                balance: inv.newBalance,
              }))
            : [],
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

        // Period lock: nothing may change inside a closed fiscal year.
        await FiscalYearService.assertPostingAllowed(voucher.date, { session });

        // What the audit log keeps of the voucher, read before it is cancelled.
        const removed = {
          voucherNo: voucher.voucherNo,
          voucherType: voucher.voucherType,
          date: voucher.date,
          partyId: voucher.partyId,
          totalAmount: voucher.totalAmount,
          status: voucher.status,
        };

        // A cheque that has not cleared is withdrawn with its voucher (a cleared one is reversed
        // with it, the ledger entries of the clearing included).
        if (voucher.paymentMode === "cheque") {
          await require("../banking/chequeService").onVoucherRemoved(voucher, { session, req: {}, adminId: deletedBy, forEdit: false });
        }
        if (voucher.status === "approved") {
          await this.reverseVoucherEffects(voucher, session);
        }

        // Mark as cancelled instead of hard delete
        voucher.status = "cancelled";
        voucher.updatedBy = deletedBy;
        await voucher.save({ session });

        await session.commitTransaction();
        return { message: "Voucher cancelled successfully", removed };
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
    // a voucher the bank statement has been matched to is not undone from here (BANK_MATCHED / BANK_RECONCILED)
    await ReconciliationGuard.assertNotMatched(voucherId, { session });
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
    });

    await Promise.all(reversalPromises);

    // Only LedgerAccount balances, not Transactor: the mirror image of each entry, applied once per account
    // (see updateAccountBalances for why not one by one in parallel).
    await applyBalances(
      entries.map((entry) => ({ accountId: entry.accountId, debitAmount: entry.creditAmount, creditAmount: entry.debitAmount })),
      session
    );

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
      const invoice = await Transaction.findById(linked.invoiceId).session(
        session
      );
      if (invoice) {
        invoice.paidAmount -= linked.allocatedAmount;
        invoice.outstandingAmount += linked.allocatedAmount;
        if (invoice.paidAmount < 0) invoice.paidAmount = 0;
        if (invoice.outstandingAmount > invoice.totalAmount)
          invoice.outstandingAmount = invoice.totalAmount;
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
        return this.getTrialBalance(dateFrom, dateTo, { includeClosing: ["true", "1", true].includes(filters.includeClosing) });
      case "profit_loss":
        return this.getProfitAndLoss(dateFrom, dateTo);
      case "balance_sheet":
        return this.getBalanceSheet(dateTo);
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

  // Trial Balance Report - Early match in aggregate
  // Trial Balance: per account, opening (before dateFrom) and period movement, closing balance
  // in its natural sign, and the closing position on the debit or credit side.
  //
  // LedgerEntry rows exist only for approved vouchers (createLedgerEntries is called on
  // approval), and the entry has no `status` field - the previous `{status:"approved"}` match
  // therefore matched nothing and the report was always empty.
  //
  // A year-end closing entry (voucherType "closing") dated before `dateFrom` is part of the opening balance - that is how a
  // closed year's profit reaches Retained Earnings and income and expense start the next year at zero. One dated inside
  // the period is left out of its movement, so the closed year still shows its own profit; `includeClosing` counts it.
  static async getTrialBalance(dateFrom, dateTo, { includeClosing = false } = {}) {
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;

    const match = { isReversed: { $ne: true } };
    if (to) match.date = { $lte: to };

    const notClosing = { $ne: ["$voucherType", CLOSING_VOUCHER_TYPE] };
    const periodTest = from
      ? (includeClosing ? { $gte: ["$date", from] } : { $and: [{ $gte: ["$date", from] }, notClosing] })
      : (includeClosing ? null : notClosing);
    const inPeriod = (field) => (periodTest ? { $cond: [periodTest, field, 0] } : field);
    const beforePeriod = (field) =>
      from ? { $cond: [{ $lt: ["$date", from] }, field, 0] } : 0;

    const rows = await LedgerEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$accountId",
          accountName: { $first: "$accountName" },
          accountCode: { $first: "$accountCode" },
          openingDebit: { $sum: beforePeriod("$debitAmount") },
          openingCredit: { $sum: beforePeriod("$creditAmount") },
          periodDebit: { $sum: inPeriod("$debitAmount") },
          periodCredit: { $sum: inPeriod("$creditAmount") },
        },
      },
      {
        $lookup: {
          from: "ledgeraccounts",
          localField: "_id",
          foreignField: "_id",
          as: "acc",
          pipeline: [{ $project: { accountType: 1, groupId: 1 } }],
        },
      },
      {
        $lookup: {
          from: "accountgroups",
          localField: "acc.groupId",
          foreignField: "_id",
          as: "grp",
          pipeline: [{ $project: { category: 1, name: 1 } }],
        },
      },
      { $sort: { accountCode: 1, accountName: 1 } },
    ]);

    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const trialBalance = rows.map((row) => {
      const accountType = row.acc?.[0]?.accountType;
      // The account's group category wins; fall back to its legacy accountType.
      const category = row.grp?.[0]?.category || categoryOf(accountType);
      const net = r2(row.openingDebit + row.periodDebit - (row.openingCredit + row.periodCredit));
      return {
        _id: row._id,
        accountName: row.accountName,
        accountCode: row.accountCode,
        accountType,
        category,
        groupName: row.grp?.[0]?.name || null,
        openingBalance: r2(naturalBalance(category, row.openingDebit, row.openingCredit)),
        totalDebits: r2(row.periodDebit),
        totalCredits: r2(row.periodCredit),
        // Natural balance: liabilities, equity and income read positive on the credit side.
        balance: r2(
          naturalBalance(category, row.openingDebit + row.periodDebit, row.openingCredit + row.periodCredit)
        ),
        closingDebit: net > 0 ? net : 0,
        closingCredit: net < 0 ? -net : 0,
      };
    });

    const sum = (key) => r2(trialBalance.reduce((t, a) => t + a[key], 0));
    const summary = {
      totalDebits: sum("totalDebits"),
      totalCredits: sum("totalCredits"),
      closingDebit: sum("closingDebit"),
      closingCredit: sum("closingCredit"),
    };
    summary.isBalanced = Math.abs(summary.closingDebit - summary.closingCredit) < 0.01;

    return { trialBalance, summary };
  }

  // Profit & Loss for a period: income less expenses, from the same ledger as the Trial Balance.
  // Amounts are the period's movement in each account's natural sign.
  static async getProfitAndLoss(dateFrom, dateTo) {
    const { trialBalance } = await this.getTrialBalance(dateFrom, dateTo);
    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const lines = (category) =>
      trialBalance
        .filter((a) => a.category === category)
        .map((a) => ({
          _id: a._id, accountCode: a.accountCode, accountName: a.accountName, groupName: a.groupName,
          amount: r2(naturalBalance(category, a.totalDebits, a.totalCredits)),
        }))
        .filter((a) => Math.abs(a.amount) >= 0.005);
    const income = lines("INCOME");
    const expenses = lines("EXPENSE");
    const totalIncome = r2(income.reduce((t, a) => t + a.amount, 0));
    const totalExpenses = r2(expenses.reduce((t, a) => t + a.amount, 0));
    return { dateFrom: dateFrom || null, dateTo: dateTo || null, income, expenses, totalIncome, totalExpenses, netProfit: r2(totalIncome - totalExpenses) };
  }

  // Balance Sheet as at a date. The profit of the fiscal year the date falls in is shown inside equity (it is not
  // closed to Retained Earnings until the year is closed); the profit of closed years is already in Retained Earnings.
  // Read from the start of that year, so the closing entries of earlier years count and this year's own do not.
  static async getBalanceSheet(asOf) {
    const year = await FiscalYearService.getForDate(asOf ? new Date(asOf) : new Date());
    const { trialBalance } = await this.getTrialBalance(year ? year.startDate : undefined, asOf);
    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const lines = (category) =>
      trialBalance
        .filter((a) => a.category === category)
        .map((a) => ({ _id: a._id, accountCode: a.accountCode, accountName: a.accountName, groupName: a.groupName, amount: r2(a.balance) }))
        .filter((a) => Math.abs(a.amount) >= 0.005);
    const sum = (arr) => r2(arr.reduce((t, a) => t + a.amount, 0));
    const assets = lines("ASSET");
    const liabilities = lines("LIABILITY");
    const equity = lines("EQUITY");
    const earned = r2(sum(lines("INCOME")) - sum(lines("EXPENSE")));
    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);
    const totalEquity = r2(sum(equity) + earned);
    return {
      asOf: asOf || null, assets, liabilities, equity, profitToDate: earned,
      totalAssets, totalLiabilities, totalEquity, totalLiabilitiesAndEquity: r2(totalLiabilities + totalEquity),
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    };
  }

  // Cash Flow Report - Early match
  static async getCashFlowReport(dateFrom, dateTo) {
    const matchConditions = {
      voucherType: { $in: ["receipt", "payment", "contra"] },
      status: "approved",
    };
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
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $group: {
          _id: "$expenseCategoryId",
          categoryName: {
            $first: { $arrayElemAt: ["$category.name", 0] },
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

  // Party Statement (Customer/Vendor) - With lean()
  static async getPartyStatement(partyId, partyType, dateFrom, dateTo) {
    if (!partyId || !partyType || !mongoose.Types.ObjectId.isValid(partyId)) {
      throw new AppError(
        "Valid Party ID and type are required for statement",
        400
      );
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
        linkedInvoices: voucher.linkedInvoices
          ? voucher.linkedInvoices.map((inv) => ({
              invoiceId: inv.invoiceId,
              amount: inv.allocatedAmount,
              balance: inv.newBalance,
            }))
          : [],
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

    const pendingApprovals = await Voucher.countDocuments({
      status: "pending",
    });

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
        linkedInvoices: voucher.linkedInvoices
          ? voucher.linkedInvoices.map((inv) => ({
              invoiceId: inv.invoiceId,
              amount: inv.allocatedAmount,
              balance: inv.newBalance,
            }))
          : [],
      })),
    };
  }
}

module.exports = FinancialService;
