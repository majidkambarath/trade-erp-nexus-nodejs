const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const StockPurchaseLog = require("../../models/modules/StockPurchaseLog"); // Import StockPurchaseLog model
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockService = require("../stock/stockService");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const costing = require("../../utils/inventoryCosting");
const { priceLine, priceCharge, priceDocument } = require("../../utils/pricing");
const TaxCodeService = require("../financial/taxCodeService");
const PostingService = require("../financial/postingService");
const RecostService = require("../stock/recostService");
const { EInvoiceSubmission } = require("../../models/modules/einvoiceModels");
const ReturnService = require("./returnService");
const BatchService = require("../stock/batchService");
const CreditControlService = require("../financial/creditControlService");
const VATReport = require("../../models/modules/financial/VATReport"); // Import the new VATReport model
const fs = require("fs");
const path = require("path");
const DebitLog = require("../../models/modules/DebitLog");
const CreditLog = require("../../models/modules/CreditLog");

function logInbound(tag, payload) {
  try {
    const logDir = path.join(__dirname, "..", "..", "..", "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `transaction-inbound.log`);
    const entry = {
      ts: new Date().toISOString(),
      tag,
      id: payload?._id || payload?.id || null,
      type: payload?.type || null,
      docno: payload?.docno ?? null,
      lpono: payload?.lpono ?? null,
      discount: payload?.discount ?? null,
    };
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (_) {
    /* ignore */
  }
}

// ---------- Helpers ----------
// Approving, rejecting or cancelling is what moves stock, books the ledger and runs credit control, so
// it only happens through processTransaction. Saving a document with one of these as its status would
// leave an "approved" document with none of those effects, so it is refused.
const PROCESS_ONLY_STATUSES = ["APPROVED", "REJECTED", "CANCELLED"];
function assertStatusNotForced(status) {
  if (PROCESS_ONLY_STATUSES.includes(status)) {
    throw new AppError(
      `A document cannot be saved as ${status}. Save it, then approve, reject or cancel it.`,
      400,
      "STATUS_REQUIRES_PROCESS"
    );
  }
}

// Document numbers come from NumberSeriesService (atomic counter per series and fiscal year).
// The previous random 3-digit generator collided against the unique transactionNo index.

function calculateItems(items) {
  return items.map((item) => {
    // Round each money column, then sum (utils/pricing.js): a discount reduces the taxable base.
    const priced = priceLine(item);

    // Derive itemCode robustly from provided fields (backend may send different shapes)
    const itemCode =
      item.itemCode ||
      item.code ||
      item.sku ||
      (item.stockDetails &&
        (item.stockDetails.itemCode || item.stockDetails.sku)) ||
      (item.itemId ? String(item.itemId) : "");

    return {
      ...item,
      itemCode,
      package: item.package ?? 0,
      grossAmount: priced.gross,
      discountAmount: priced.discount,
      taxableAmount: priced.taxable,
      vatAmount: priced.vat,
      lineTotal: priced.lineTotal,
      grandTotal: priced.lineTotal,
    };
  });
}

// Prices a whole document on the server: lines, header charges, header discount, round-off.
// Returns what to store. A client-supplied total only survives as a small explicit round-off;
// anything further from the computed total is ignored.
async function buildPricing({ items, charges = [], discount = 0, incomingTotal, date }, session) {
  const withTax = await TaxCodeService.applyToItems(items, date, { session });
  const processedItems = calculateItems(withTax);
  const pricedCharges = (charges || [])
    .filter((c) => Number(c.amount) > 0)
    .map((c) => {
      const p = priceCharge(c);
      return { code: c.code, description: c.description, amount: p.net, vatPercent: p.vatPercent, vatAmount: p.vat };
    });
  const pricing = priceDocument(
    processedItems.map((i) => ({
      gross: i.grossAmount, discount: i.discountAmount, taxable: i.taxableAmount, vat: i.vatAmount,
    })),
    pricedCharges.map((c) => ({ net: c.amount, vat: c.vatAmount })),
    { headerDiscount: discount, incomingTotal }
  );
  return { processedItems, charges: pricedCharges, pricing, totalAmount: pricing.grandTotal };
}

function withTransactionSession(fn) {
  return async (...args) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(...args, session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  };
}

// ---------- Service ----------
class TransactionService {
  // One document exactly as stored (the controller exposed this route but the method did not
  // exist, so GET /transactions/:id always failed). Editing reads it so nothing the list view
  // leaves out - discounts, tax codes, batches, charges - is lost on save.
  static async getTransactionById(id) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid transaction id", 400);
    const transaction = await Transaction.findById(id).lean();
    if (!transaction) throw new AppError("Transaction not found", 404);
    return transaction;
  }

  // Create Transaction
  static createTransaction = withTransactionSession(
    async (data, createdBy, session) => {
      // DEBUG inbound snapshot for create
      try {
        logInbound("createTransaction:incoming", data);
      } catch (_) {}
      const {
        transactionNo, // ADD: Destructure incoming transactionNo
        type,
        partyId,
        partyType,
        vendorReference,
        items,
        date,
        deliveryDate,
        terms,
        notes,
        priority,
        status, // ADD: Destructure incoming status
        totalAmount, // ADD: Destructure incoming totalAmount
        // Sales invoice specific fields
        docno,
        lpono,
        discount,
      } = data;

      if (!type || !partyId || !partyType)
        throw new AppError("Missing required fields", 400);
      assertStatusNotForced(status);

      await FiscalYearService.assertPostingAllowed(date || new Date(), { session });
      if (!items?.length) throw new AppError("Items are required", 400);

      console.log("Service: Incoming transactionNo:", transactionNo); // TEMP LOG: Track incoming

      // FIX: Conditionally set transactionNo - use incoming if provided, else auto-generate
      let finalTransactionNo = transactionNo?.trim();
      if (!finalTransactionNo) {
        finalTransactionNo = await NumberSeriesService.allocate(
          NumberSeriesService.forTransactionType(type),
          date || new Date(),
          { session }
        );
        console.log(
          "Service: Auto-generated transactionNo:",
          finalTransactionNo
        ); // TEMP LOG
      } else {
        console.log(
          "Service: Using incoming transactionNo:",
          finalTransactionNo
        ); // TEMP LOG
        // Validate uniqueness (prevent duplicates)
        const existing = await Transaction.findOne({
          transactionNo: finalTransactionNo,
        }).session(session);
        if (existing) {
          throw new AppError(
            `Transaction number ${finalTransactionNo} already exists`,
            400
          );
        }
      }

      // Stock availability check disabled for order capture
      // Previously validated for sales_order and purchase_return; now we only fetch to ensure item exists
      let code;
      for (const item of items) {
        const stock = await StockService.getStockByItemId(item.itemId);
        code = stock?.itemId;
        // Do not block order creation due to stock levels
      }

      const built = await buildPricing(
        { items, charges: data.charges, discount, incomingTotal: totalAmount, date: date || new Date() },
        session
      );
      // Returns: validated against the original (quantities and value), then the line links are kept.
      const checked = await ReturnService.validate(
        { type, partyId, returnOf: data.returnOf, items: built.processedItems, date: date || new Date() },
        { session }
      );
      const processedItems = checked.items;
      const finalTotalAmount = built.totalAmount;
      const returnOf = checked.original
        ? { transactionId: checked.original._id, transactionNo: checked.original.transactionNo }
        : undefined;
      console.log(
        "Service: Final totalAmount (incoming/calculated):",
        finalTotalAmount
      ); // TEMP LOG

      const transactionData = {
        transactionNo: finalTransactionNo, // USE: The conditional/final value
        type,
        partyId,
        partyType: partyType === "Vendor" ? "Vendor" : "Customer",
        partyTypeRef: partyType === "Vendor" ? "Vendor" : "Customer",
        items: processedItems,
        totalAmount: finalTotalAmount, // computed on the server
        charges: built.charges,
        pricing: built.pricing,
        returnOf,
        attachments: data.attachments || [],
        vendorReference,
        status: status || "DRAFT", // USE: Incoming or default
        createdBy,
        date: new Date(date || new Date()), // FIX: Ensure Date object (handles string input)
        deliveryDate: new Date(deliveryDate || new Date()), // FIX: Ensure Date object
        terms: terms || "",
        notes: notes || "",
        priority: priority || "Medium",
        // Sales invoice specific fields
        docno: docno || null,
        lpono: lpono || null,
        discount: Number(discount ?? 0),
      };

      console.log(
        "Service: Final transactionData before save:",
        JSON.stringify(transactionData, null, 2)
      ); // TEMP LOG

      const [newTransaction] = await Transaction.create([transactionData], {
        session,
      });

      // Create StockPurchaseLog for purchase orders (unchanged, but use finalTransactionNo)
      if (type === "purchase_order") {
        const purchaseLogData = {
          transactionNo: newTransaction.transactionNo, // Will now match incoming if provided
          type: "purchase_order",
          partyId,
          partyType: "Vendor",
          partyTypeRef: "Vendor",
          date: transactionData.date,
          deliveryDate: transactionData.deliveryDate,
          items: processedItems.map((item) => ({
            itemId: item.itemId,
            description: item.description,
            qty: item.qty,
            rate: item.rate,
            vatPercent: item.vatPercent || 0,
            price: item.lineTotal,
            // expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
          })),
          terms: transactionData.terms || "",
          notes: transactionData.notes || "",
          priority: transactionData.priority || "Medium",
        };

        await StockPurchaseLog.create([purchaseLogData], { session });
      }

      console.log(
        "Service: Created transaction:",
        JSON.stringify(newTransaction, null, 2)
      ); // TEMP LOG

      return newTransaction;
    }
  );
  // Update Transaction
  static updateTransaction = withTransactionSession(
    async (id, data, createdBy, session) => {
      // DEBUG inbound snapshot for update
      try {
        logInbound("updateTransaction:incoming", { id, ...data });
      } catch (_) {}
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);
      if (this.isProcessed(transaction.status))
        throw new AppError("Cannot edit processed transactions", 400);
      assertStatusNotForced(data.status);

      if (data.items || data.charges || data.discount !== undefined) {
        const built = await buildPricing(
          {
            items: data.items || transaction.items.map((i) => i.toObject()),
            charges: data.charges ?? transaction.charges,
            discount: data.discount ?? transaction.discount,
            incomingTotal: data.totalAmount,
            date: data.date || transaction.date,
          },
          session
        );
        const checked = await ReturnService.validate(
          {
            type: transaction.type,
            partyId: transaction.partyId,
            returnOf: transaction.returnOf?.transactionId ? transaction.returnOf : data.returnOf,
            items: built.processedItems,
            date: data.date || transaction.date,
          },
          { session, excludeId: transaction._id }
        );
        data.items = checked.items;
        data.charges = built.charges;
        data.pricing = built.pricing;
        data.totalAmount = built.totalAmount;
      }

      // Update StockPurchaseLog for purchase orders
      if (transaction.type === "purchase_order" && data.items) {
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (!purchaseLog) {
          throw new AppError("Purchase log not found", 404);
        }

        purchaseLog.items = data.items.map((item) => ({
          itemId: item.itemId,
          description: item.description,
          qty: item.qty,
          rate: item.rate,
          vatPercent: item.vatPercent || 0,
          price: item.lineTotal,
          // expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
        }));
        purchaseLog.totalAmount = data.totalAmount;
        purchaseLog.terms = data.terms || purchaseLog.terms;
        purchaseLog.notes = data.notes || purchaseLog.notes;
        purchaseLog.priority = data.priority || purchaseLog.priority;
        purchaseLog.updatedAt = new Date();

        await purchaseLog.save({ session });
      }

      Object.assign(transaction, data, { updatedAt: new Date() });
      await transaction.save({ session });
      return transaction;
    }
  );

  // Delete Transaction
  static deleteTransaction = withTransactionSession(
    async (id, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      const wasApproved = transaction.status === "APPROVED";

      // An invoice that has gone out as an e-invoice is a legal record: it is corrected with a
      // credit note, never deleted. (A failed attempt never left the building, so it does not count.)
      const sent = await EInvoiceSubmission.exists({
        sourceId: transaction._id, status: { $in: ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED", "REJECTED"] },
      }).session(session);
      if (sent) {
        throw new AppError(
          `${transaction.transactionNo} has been sent as an e-invoice and cannot be deleted. Issue a credit note instead.`,
          409,
          "EINVOICE_SENT"
        );
      }

      if (wasApproved) {
        await FiscalYearService.assertPostingAllowed(transaction.date, { session });
        await this.reverseTransactionStock(id, transaction, createdBy, session);
        await PostingService.reverseTransaction(transaction, { session });
        await RecostService.recostAfterChange(transaction, { session });
        await this.reversePartyBalanceAndLog(transaction, createdBy, session); // REVERSE financials
      }

      if (transaction.type === "purchase_order") {
        await StockPurchaseLog.deleteOne(
          { transactionNo: transaction.transactionNo },
          { session }
        );
      }

      await Transaction.findByIdAndDelete(id).session(session);
    }
  );

  // Process Transaction (approve/reject/cancel)
  // processTransaction(id, action, createdBy[, options]) - options: { acknowledged, req }.
  // withTransactionSession appends the session as the LAST argument.
  static processTransaction = withTransactionSession(
    async (id, action, createdBy, ...rest) => {
      const session = rest[rest.length - 1];
      const options = rest.length > 1 ? rest[0] || {} : {};
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      this.validateAction(transaction.type, action, transaction.status);
      await FiscalYearService.assertPostingAllowed(transaction.date, { session });

      // Store old status for reversal detection
      const wasApproved = transaction.status === "APPROVED";

      if (action === "approve") {
        // Credit limit / overdue check (sales only; off unless the company turns it on).
        await CreditControlService.assertSaleAllowed(transaction, {
          session, acknowledged: options.acknowledged === true, req: options.req,
        });
        const stockUpdates = await this.processTransactionStock(id, transaction, createdBy, session);
        // Accounting entries (receivable/payable, revenue or inventory, VAT, cost of goods sold).
        // A no-op until the company has mapped its accounts and switched ledger posting on.
        await PostingService.postTransaction(transaction, { stockUpdates, createdBy, session });
        await RecostService.recostAfterChange(transaction, { session });
        await this.createVATReportItems(transaction, createdBy, session);

        // NEW: Update party cash balance + create Debit/Credit Log
        await this.updatePartyBalanceAndLog(transaction, createdBy, session);

        // Handle purchase_order specific
        if (transaction.type === "purchase_order") {
          const purchaseLog = await StockPurchaseLog.findOne({
            transactionNo: transaction.transactionNo,
          }).session(session);
          if (purchaseLog) {
            purchaseLog.status = "APPROVED";
            await purchaseLog.save({ session });
          }
        }
      }

      // Handle rejection/cancellation
      if (action === "reject" && transaction.type === "purchase_order") {
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (purchaseLog) {
          purchaseLog.status = "REJECTED";
          await purchaseLog.save({ session });
        }
      }

      if (action === "cancel") {
        if (wasApproved) {
          await PostingService.reverseTransaction(transaction, { session });
          await this.reverseTransactionStock(
            id,
            transaction,
            createdBy,
            session
          );
          await this.reversePartyBalanceAndLog(transaction, createdBy, session); // REVERSE financials
        }

        if (transaction.type === "purchase_order") {
          const purchaseLog = await StockPurchaseLog.findOne({
            transactionNo: transaction.transactionNo,
          }).session(session);
          if (purchaseLog) {
            purchaseLog.status = "CANCELLED";
            await purchaseLog.save({ session });
          }
        }
      }

      // Update status
      this.updateTransactionStatus(transaction, action);
      await transaction.save({ session });

      return transaction;
    }
  );

  // NEW: Update cash balance + create Debit/Credit Log on approval
  static async updatePartyBalanceAndLog(transaction, createdBy, session) {
    const { type, partyId, partyType, totalAmount, transactionNo, date, _id } =
      transaction;

    const isVendor = partyType === "Vendor";
    const Model = mongoose.model(isVendor ? "Vendor" : "Customer");
    const LogModel = isVendor ? DebitLog : CreditLog;

    // Determine effect on balance
    const balanceEffect = {
      purchase_order: +totalAmount, // Vendor owes us more →
      purchase_return: -totalAmount, // Vendor owes less
      sales_order: -totalAmount, // Customer owes us more →
      sales_return: +totalAmount, // Customer owes less
    }[type];

    if (balanceEffect === undefined) return; // safety

    // Get current balance
    const party = await Model.findById(partyId).session(session);
    if (!party) throw new AppError(`${partyType} not found`, 404);

    const previousBalance = party.cashBalance;
    const newBalance = previousBalance + balanceEffect;

    // Update cashBalance
    await Model.findByIdAndUpdate(
      partyId,
      { cashBalance: newBalance },
      { session }
    );
const logAmount = balanceEffect;
    // Create log entry
    await LogModel.create(
      [
        {
          [isVendor ? "vendorId" : "customerId"]: partyId,
          type: type,
          date: date || new Date(),
          invNo: transactionNo,
          amount: logAmount,
          paid: 0,
          balance: newBalance,
          ref: _id.toString(),
          status: "UNPAID",
          createdBy,
        },
      ],
      { session }
    );
  }

  static async reversePartyBalanceAndLog(transaction, createdBy, session) {
    const { type, partyId, partyType, totalAmount, transactionNo, _id } =
      transaction;

    const isVendor = partyType === "Vendor";
    const Model = mongoose.model(isVendor ? "Vendor" : "Customer");
    const LogModel = isVendor ? DebitLog : CreditLog;

    // Exact inverse of updatePartyBalanceAndLog's balanceEffect. The sales side used to repeat
    // the forward sign, so deleting an approved sale doubled its effect instead of undoing it.
    const reverseEffect = {
      purchase_order: -totalAmount,
      purchase_return: totalAmount,
      sales_order: totalAmount,
      sales_return: -totalAmount,
    }[type];

    if (reverseEffect === undefined) return;

    const party = await Model.findById(partyId).session(session);
    if (!party) return;

    const newBalance = party.cashBalance + reverseEffect;

    await Model.findByIdAndUpdate(
      partyId,
      { cashBalance: newBalance },
      { session }
    );

    // Optional: Create reversal log (recommended)
    await LogModel.create(
      [
        {
          [isVendor ? "vendorId" : "customerId"]: partyId,
          type: `${type}_reversed`,
          date: new Date(),
          invNo: transactionNo,
          amount: Math.abs(totalAmount),
          paid: 0,
          balance: newBalance,
          ref: `REV-${_id}`,
          status: "REVERSED",
          createdBy,
        },
      ],
      { session }
    );
  }

  // Helper to create VAT report items for approved transactions
  static async createVATReportItems(transaction, createdBy, session) {
    const {
      type,
      _id: transactionId,
      transactionNo,
      partyId,
      partyType,
      date,
      items,
    } = transaction;

    // Determine if it's output (sales) or input (purchase) VAT
    const isOutputVAT = ["sales_order", "purchase_return"].includes(type);
    const isInputVAT = ["purchase_order", "sales_return"].includes(type);
    if (!isOutputVAT && !isInputVAT) return; // No VAT handling for other types

    // Fetch party name (assume Customer/Vendor models have name fields)
    let partyName = "Unknown";
    if (partyType === "Customer") {
      const customer = await mongoose
        .model("Customer")
        .findById(partyId)
        .session(session);
      partyName = customer?.customerName || partyName;
    } else if (partyType === "Vendor") {
      const vendor = await mongoose
        .model("Vendor")
        .findById(partyId)
        .session(session);
      partyName = vendor?.vendorName || partyName;
    }

    // Filter items with VAT > 0 and prepare VAT items
    const vatItems = items
      .filter((item) => item.vatAmount > 0)
      .map((item) => ({
        transactionId,
        transactionNo,
        itemId: item.itemId,
        itemCode: item.itemCode,
        description: item.description,
        qty: item.qty,
        rate: item.rate || item.price, // Fallback to price if rate missing
        lineTotal: item.lineTotal,
        vatAmount: item.vatAmount,
        vatRate: item.vatPercent || 0,
        partyId,
        partyName,
        partyType,
        date,
      }));

    // VAT charged on header charges (freight, handling) is VAT too: it is in the ledger, so it belongs here.
    for (const c of transaction.charges || []) {
      if (!(c.vatAmount > 0)) continue;
      vatItems.push({
        transactionId, transactionNo, itemCode: c.code || "CHARGE",
        description: c.description || "Charge", qty: 1, rate: c.amount,
        lineTotal: Math.round((c.amount + c.vatAmount) * 100) / 100,
        vatAmount: c.vatAmount, vatRate: c.vatPercent || 0, partyId, partyName, partyType, date,
      });
    }

    if (vatItems.length === 0) return;

    // For simplicity, we'll create or update a temporary "open" VAT report for the transaction's month.
    // This avoids complex period management here; a separate report generation job can aggregate/finalize.
    const periodStart = new Date(date.getFullYear(), date.getMonth(), 1);
    const periodEnd = new Date(
      date.getFullYear(),
      date.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    );

    let vatReport = await VATReport.findOne({
      periodStart,
      periodEnd,
      status: "DRAFT", // Assume we use a draft report per period
    }).session(session);

    if (!vatReport) {
      vatReport = new VATReport({
        periodStart,
        periodEnd,
        generatedBy: createdBy,
        totalVATOutput: 0,
        totalVATInput: 0,
        netVATPayable: 0,
        items: [],
      });
    }

    // Add new items and update totals
    vatReport.items.push(...vatItems);
    vatItems.forEach((vi) => {
      if (isOutputVAT) {
        vatReport.totalVATOutput += vi.vatAmount;
      } else if (isInputVAT) {
        vatReport.totalVATInput += vi.vatAmount;
      }
    });
    vatReport.netVATPayable =
      vatReport.totalVATOutput - vatReport.totalVATInput;

    await vatReport.save({ session });
  }

  // Get all Transactions
  // Get all Transactions
  static async getAllTransactions(filters) {
    try {
      const query = {};

      // ──────── FILTERS ──────── (unchanged)
      if (filters.type) {
        query.type = Array.isArray(filters.type)
          ? { $in: filters.type }
          : filters.type;
      }
      if (filters.status) query.status = filters.status;
      if (filters.partyId) {
        if (!mongoose.Types.ObjectId.isValid(filters.partyId))
          throw new Error("Invalid partyId");
        query.partyId = new mongoose.Types.ObjectId(filters.partyId);
      }
      if (filters.partyType) query.partyType = filters.partyType;

      if (filters.search) {
        // Escape user input: an unescaped "(" throws, and crafted patterns can backtrack badly.
        const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const r = new RegExp(escaped, "i");
        query.$or = [
          { transactionNo: r },
          { notes: r },
          { createdBy: r },
          { "items.description": r },
        ];
      }

      // ──────── DATE FILTER ──────── (unchanged)
      if (filters.dateFilter) {
        const today = new Date();
        const types = Array.isArray(filters.type)
          ? filters.type
          : [filters.type].filter(Boolean);
        const field = types.some((t) =>
          ["purchase_return", "sales_return"].includes(t)
        )
          ? "returnDate"
          : "date";

        switch (filters.dateFilter) {
          case "TODAY":
            query[field] = {
              $gte: new Date(today.setHours(0, 0, 0, 0)),
              $lte: new Date(today.setHours(23, 59, 59, 999)),
            };
            break;
          case "WEEK":
            query[field] = {
              $gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
            };
            break;
          case "MONTH":
            query[field] = {
              $gte: new Date(today.getFullYear(), today.getMonth(), 1),
            };
            break;
          case "CUSTOM":
            if (!filters.startDate || !filters.endDate)
              throw new Error("startDate and endDate required for CUSTOM");
            query[field] = {
              $gte: new Date(filters.startDate),
              $lte: new Date(filters.endDate),
            };
            break;
          default:
            throw new Error("Invalid date filter");
        }
      }

      // ──────── PAGINATION ──────── (unchanged)
      const page = Math.max(1, parseInt(filters.page) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(filters.limit) || 20));
      const skip = (page - 1) * limit;

      // ──────── AGGREGATION PIPELINE ────────
      // Paginate first, then join. Previously every matching transaction was joined
      // (customers, vendors, per-line stock + UOM) and only then sorted and sliced,
      // so each page cost grew with the total row count.
      const pipeline = [
        { $match: query },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },

        // ---- 1. Lookup Customer ---- (unchanged)
        {
          $lookup: {
            from: "customers",
            localField: "partyId",
            foreignField: "_id",
            as: "customerData",
          },
        },

        // ---- 2. Lookup Vendor ---- (unchanged)
        {
          $lookup: {
            from: "vendors",
            localField: "partyId",
            foreignField: "_id",
            as: "vendorData",
          },
        },

        // ---- 3. Build a single `party` object (full doc) ---- (unchanged)
        {
          $set: {
            party: {
              $cond: {
                if: { $eq: ["$partyType", "Customer"] },
                then: { $arrayElemAt: ["$customerData", 0] },
                else: { $arrayElemAt: ["$vendorData", 0] },
              },
            },
          },
        },

        // ---- 4. FIXED: Build `partyName` correctly ----
        // Use $getField to extract property from first array element (MongoDB 5.1+)
        // Fallback to null if no match
        {
          $set: {
            partyName: {
              $cond: {
                if: { $eq: ["$partyType", "Customer"] },
                then: {
                  $ifNull: [
                    {
                      $getField: {
                        field: "customerName",
                        input: { $arrayElemAt: ["$customerData", 0] },
                      },
                    },
                    null,
                  ],
                },
                else: {
                  $ifNull: [
                    {
                      $getField: {
                        field: "vendorName",
                        input: { $arrayElemAt: ["$vendorData", 0] },
                      },
                    },
                    null,
                  ],
                },
              },
            },
          },
        },

        // ──────── NO $unset – keep everything ──────── (unchanged)

        // ---- 5. Unwind items for stock lookup ---- (unchanged)
        {
          $unwind: { path: "$items", preserveNullAndEmptyArrays: true },
        },

        // ---- 6. Lookup Stock + nested UOM ---- (unchanged)
        {
          $lookup: {
            from: "stocks",
            let: { itemId: "$items.itemId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$itemId"] } } },
              {
                $lookup: {
                  from: "uoms",
                  localField: "unitOfMeasure",
                  foreignField: "_id",
                  as: "unitOfMeasureDetails",
                },
              },
              {
                $set: {
                  unitOfMeasureDetails: {
                    $arrayElemAt: ["$unitOfMeasureDetails", 0],
                  },
                },
              },
            ],
            as: "items.stockDetails",
          },
        },
        {
          $set: {
            "items.stockDetails": { $arrayElemAt: ["$items.stockDetails", 0] },
          },
        },

        // ---- 7. Group back the document ---- (unchanged, but now partyName is correct)
        {
          $group: {
            _id: "$_id",
            transactionNo: { $first: "$transactionNo" },
            type: { $first: "$type" },
            partyId: { $first: "$partyId" },
            partyType: { $first: "$partyType" },
            partyTypeRef: { $first: "$partyTypeRef" },
            vendorReference: { $first: "$vendorReference" },
            date: { $first: "$date" },
            deliveryDate: { $first: "$deliveryDate" },
            returnDate: { $first: "$returnDate" },
            expectedDispatch: { $first: "$expectedDispatch" },
            status: { $first: "$status" },
            totalAmount: { $first: "$totalAmount" },
            // Ensure sales-order fields are included in list output
            docno: { $first: "$docno" },
            lpono: { $first: "$lpono" },
            discount: { $first: "$discount" },
            paidAmount: { $first: "$paidAmount" },
            outstandingAmount: { $first: "$outstandingAmount" },
            items: { $push: "$items" },
            terms: { $first: "$terms" },
            notes: { $first: "$notes" },
            quoteRef: { $first: "$quoteRef" },
            linkedRef: { $first: "$linkedRef" },
            creditNoteIssued: { $first: "$creditNoteIssued" },
            createdBy: { $first: "$createdBy" },
            createdAt: { $first: "$createdAt" },
            updatedAt: { $first: "$updatedAt" },
            priority: { $first: "$priority" },
            grnGenerated: { $first: "$grnGenerated" },
            invoiceGenerated: { $first: "$invoiceGenerated" },

            // keep the raw lookup arrays
            customerData: { $first: "$customerData" },
            vendorData: { $first: "$vendorData" },

            // our new fields
            party: { $first: "$party" },
            partyName: { $first: "$partyName" },
          },
        },

        // ---- 8. Restore order: $group does not preserve input order,
        // and this sorts only the page (<= limit docs), not the whole table.
        { $sort: { createdAt: -1 } },
      ];

      const transactions = await Transaction.aggregate(pipeline);
      const total = await Transaction.countDocuments(query);

      // ---- Final shape (optional safety) ---- (updated fallback for consistency)
      const result = transactions.map((t) => ({
        ...t,
        partyName: t.partyName || "Unknown Party", // Now rarely triggers
        party: t.party || null,
        customerData: t.customerData?.length ? t.customerData[0] : null,
        vendorData: t.vendorData?.length ? t.vendorData[0] : null,
        items: t.items.map((i) => ({
          ...i,
          stockDetails: i.stockDetails || null,
        })),
      }));
      // console.log(result);
      return {
        transactions: result,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total,
          limit,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch transactions: ${error.message}`);
    }
  }

  // Process Transaction Stock
  // Moves stock AND cost for each line. Direction comes from the document type; the cost basis
  // is a separate axis (utils/inventoryCosting.js):
  //   purchase_order  -> in,  cost = documented purchase cost (VAT-exclusive line value)
  //   purchase_return -> out, cost = documented purchase cost of the returned goods
  //   sales_order     -> out, cost = quantity x average cost (COGS); selling price never enters
  //   sales_return    -> in,  cost = current average (original-sale link is a later phase)
  static async processTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session
  ) {
    const { type, items, transactionNo } = transaction;
    const costBasis = costing.COST_BASIS_BY_TYPE[type];
    if (!costBasis) throw new AppError(`Cannot move stock for ${type}`, 400);
    const stockUpdates = [];

    for (const item of items) {
      // Read inside the session so two lines for the same item see each other's effect.
      // Order lines carry the stock document's _id (Transaction.items.itemId refs "Stock").
      const stock = await Stock.findById(item.itemId).session(session);
      if (!stock) throw new AppError(`Stock item ${item.itemId} not found`, 404);

      const qty = Number(item.qty) || 0;
      const quantityChange = this.getQuantityChange(type, qty);

      // Seed the cost pool; costValue is null until the item first moves under this scheme.
      const pool = {
        quantity: stock.currentStock,
        costValue:
          stock.costValue ?? costing.roundValue(stock.currentStock * (stock.purchasePrice || 0)),
        avgRate: costing.roundRate(stock.purchasePrice || 0),
      };

      // VAT-exclusive value of the line. lineTotal is VAT-inclusive (calculateItems), so this is
      // correct whichever of price / rate the form filled in.
      const documentedCost = costing.roundValue(
        (Number(item.lineTotal) || 0) - (Number(item.vatAmount) || 0)
      );
      // A return linked to its original restores stock at what the goods cost when sold.
      let cogsRate;
      if (type === "sales_return" && transaction.returnOf?.transactionId) {
        const sold = await InventoryMovement.find({
          referenceId: transaction.returnOf.transactionId,
          stockId: stock.itemId,
          costBasis: "sale",
          isReversed: false,
        }).session(session);
        const soldQty = sold.reduce((t, m) => t + Math.abs(m.quantity), 0);
        if (soldQty > 0) cogsRate = sold.reduce((t, m) => t + (m.totalValue || 0), 0) / soldQty;
      }
      const result = costing.applyMovement(pool, costBasis, { qty, cost: documentedCost, cogsRate });

      await Stock.findByIdAndUpdate(
        stock._id,
        {
          currentStock: result.pool.quantity,
          purchasePrice: result.pool.avgRate,
          costValue: result.pool.costValue,
          updatedAt: new Date(),
        },
        { session }
      );

      const movement = await this.createInventoryMovement(
        {
          stockId: stock.itemId,
          quantity: quantityChange,
          previousStock: stock.currentStock,
          newStock: result.pool.quantity,
          eventType: this.getEventType(type),
          referenceType: "Transaction",
          referenceId: transactionId,
          referenceNumber: transactionNo,
          date: transaction.date || new Date(), // document date: costing replays in this order
          unitCost: result.rate,
          totalValue: result.cost,
          costBasis,
          rateBefore: pool.avgRate,
          rateAfter: result.pool.avgRate,
          costPoolAfter: result.pool.costValue,
          poolQtyAfter: result.pool.quantity,
          cogsAmount: costBasis === "sale" ? result.cost : null,
          notes: `${this.getEventType(type)} - ${item.description}`,
          createdBy,
          batchNumber: stock.batchNumber,
          expiryDate: stock.expiryDate,
        },
        session
      );

      // Batches (quantity + expiry per receipt). Sales take first-expiry-first-out.
      const lineIndex = items.indexOf(item);
      if (type === "purchase_order") {
        await BatchService.receive(transaction, item, qty, result.rate, { session, index: lineIndex });
      } else if (type === "sales_order") {
        const Customer = mongoose.model("Customer");
        const customer = await Customer.findById(transaction.partyId).select("minShelfLifeDays").session(session).lean();
        const taken = await BatchService.allocate(
          { stockId: stock._id, qty, orderDate: transaction.date, minShelfLifeDays: customer?.minShelfLifeDays || 0 },
          { session }
        );
        item.allocations = taken.allocations; // saved with the document, so a reversal can put it back
      } else if (type === "sales_return") {
        const origItem = transaction.returnOf?.transactionId
          ? (await Transaction.findById(transaction.returnOf.transactionId).select("items").session(session).lean())
              ?.items.find((l) => String(l._id) === String(item.returnOfLineId))
          : null;
        if (origItem?.allocations?.length) {
          // back into the batches it was sold from, up to the returned quantity
          let left = qty;
          const back = [];
          for (const a of origItem.allocations) {
            if (left <= 0) break;
            const q = Math.min(a.qty, left);
            back.push({ batchId: a.batchId, qty: q });
            left -= q;
          }
          await BatchService.restore(back, { session });
          item.allocations = back.map((b) => ({ batchId: b.batchId, qty: b.qty }));
          if (left > 0) await BatchService.receiveReturn(transaction, item, left, { session, index: lineIndex });
        } else {
          await BatchService.receiveReturn(transaction, item, qty, { session, index: lineIndex });
        }
      } else if (type === "purchase_return") {
        const taken = await BatchService.allocate(
          { stockId: stock._id, qty, orderDate: transaction.date, onlyFromTransactionId: transaction.returnOf?.transactionId || undefined },
          { session }
        );
        item.allocations = taken.allocations;
      }

      stockUpdates.push({
        itemId: item.itemId,
        previousStock: stock.currentStock,
        newStock: result.pool.quantity,
        newPurchasePrice: result.pool.avgRate,
        cost: result.cost,
        movement,
      });
    }

    return stockUpdates;
  }

  // Reverse Transaction Stock
  static async reverseTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session
  ) {
    // Batches first: a purchase whose goods were partly sold cannot be un-received (409).
    if (transaction.type === "purchase_order") {
      await BatchService.removeReceipt(transaction._id, { session });
    } else if (["sales_order", "purchase_return"].includes(transaction.type)) {
      for (const it of transaction.items) await BatchService.restore(it.allocations, { session });
    } else if (transaction.type === "sales_return") {
      for (const it of transaction.items) {
        // only the part that went back into an original batch is taken out again
        const A = (it.allocations || []).map((a) => ({ batchId: a.batchId, qty: -a.qty }));
        await BatchService.restore(A, { session });
      }
      await BatchService.removeReceipt(transaction._id, { session });
    }

    const existingMovements = await InventoryMovement.find({
      referenceId: transactionId,
      referenceType: "Transaction",
      isReversed: false,
    }).session(session);

    for (const movement of existingMovements) {
      const stock = await Stock.findOne({ itemId: movement.stockId }).session(session);
      if (!stock) throw new AppError(`Stock item ${movement.stockId} not found`, 404);
      const reversalQuantity = -movement.quantity;
      const newStock = stock.currentStock + reversalQuantity;

      // Undo the cost effect too. totalValue is the cost that moved with the stock: an inbound
      // movement added it to the pool, an outbound one took it out.
      const costDelta = movement.quantity > 0 ? -(movement.totalValue || 0) : (movement.totalValue || 0);
      const priorCostValue =
        stock.costValue ?? costing.roundValue(stock.currentStock * (stock.purchasePrice || 0));
      const newCostValue = costing.roundValue(priorCostValue + costDelta);
      const newAvg = costing.recalcAvg(newStock, newCostValue, costing.roundRate(stock.purchasePrice || 0));

      await Stock.findByIdAndUpdate(
        stock._id,
        {
          currentStock: newStock,
          costValue: newCostValue,
          purchasePrice: newAvg,
          updatedAt: new Date(),
        },
        { session }
      );

      const reversalMovement = await this.createInventoryMovement(
        {
          stockId: stock.itemId,
          quantity: reversalQuantity,
          previousStock: stock.currentStock,
          newStock,
          eventType: movement.eventType,
          referenceType: "Transaction",
          referenceId: transactionId,
          referenceNumber: `REV-${transaction.transactionNo}`,
          unitCost: movement.unitCost,
          totalValue: movement.totalValue,
          costBasis: movement.costBasis,
          rateBefore: stock.purchasePrice,
          rateAfter: newAvg,
          costPoolAfter: newCostValue,
          poolQtyAfter: newStock,
          notes: `Reversal of ${movement.notes}`,
          createdBy,
          batchNumber: movement.batchNumber,
          expiryDate: movement.expiryDate,
        },
        session
      );

      await InventoryMovement.findByIdAndUpdate(
        movement._id,
        { isReversed: true, reversalReference: reversalMovement._id },
        { session }
      );
    }

    // Update StockPurchaseLog status for reversal
    if (transaction.type === "purchase_order") {
      const purchaseLog = await StockPurchaseLog.findOne({
        transactionNo: transaction.transactionNo,
      }).session(session);
      if (purchaseLog) {
        purchaseLog.status = "REVERSED"; // Requires status field in schema
        await purchaseLog.save({ session });
      }
    }
  }

  // Create Inventory Movement
  static async createInventoryMovement(movementData, session) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  // Status & Validation
  static getQuantityChange(type, qty) {
    return (
      {
        purchase_order: qty,
        sales_order: -qty,
        purchase_return: -qty,
        sales_return: qty,
      }[type] || 0
    );
  }

  static getEventType(type) {
    return {
      purchase_order: "PURCHASE_RECEIVE",
      sales_order: "SALES_DISPATCH",
      purchase_return: "PURCHASE_RETURN",
      sales_return: "SALES_RETURN",
    }[type];
  }

  static validateAction(type, action, status) {
    const validActions = ["approve", "reject", "cancel"];
    if (!validActions.includes(action))
      throw new AppError(`Invalid action '${action}'`, 400);
    if (this.isProcessed(status))
      throw new AppError(
        `Transaction already processed with status '${status}'`,
        400
      );
  }

  static updateTransactionStatus(transaction, action) {
    const statusMap = {
      approve: {
        status: "APPROVED",
        grnGenerated: transaction.type === "purchase_order" ? true : undefined,
        invoiceGenerated: transaction.type === "sales_order" ? true : undefined,
        creditNoteIssued:
          transaction.type === "sales_return" ? true : undefined,
      },
      reject: { status: "REJECTED" },
      cancel: { status: "CANCELLED" },
    };

    Object.assign(transaction, statusMap[action] || {});
  }

  static isProcessed(status) {
    return ["APPROVED", "REJECTED", "CANCELLED", "PAID", "PARTIAL"].includes(
      status
    );
  }
}

module.exports = TransactionService;
