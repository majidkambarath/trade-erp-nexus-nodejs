const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const StockPurchaseLog = require("../../models/modules/StockPurchaseLog"); // Import StockPurchaseLog model
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockService = require("../stock/stockService");
const AppError = require("../../utils/AppError");
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
function generateTransactionNo(type) {
  const prefix = {
    purchase_order: "PO",
    sales_order: "SO",
    purchase_return: "PR",
    sales_return: "SR",
  }[type];

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
  return `${prefix}${sequence}`;
}

function calculateItems(items) {
  return items.map((item) => {
    // Use whichever unit price is present (price or rate), fallbacks to 0
    const unitPrice = Number(item.price ?? item.rate ?? 0);
    const qty = Number(item.qty ?? 0);
    const lineValue = qty * unitPrice;
    const vatPct = Number(item.vatPercent ?? 0);
    const vatAmount = (lineValue * vatPct) / 100;
    const lineTotal = +(lineValue + vatAmount).toFixed(2);

    // Derive itemCode robustly from provided fields (backend may send different shapes)
    const itemCode =
      item.itemCode ||
      item.code ||
      item.sku ||
      (item.stockDetails &&
        (item.stockDetails.itemCode || item.stockDetails.sku)) ||
      (item.itemId ? String(item.itemId) : "");

    // Ensure grandTotal is present to match frontend contract
    const grandTotal =
      item.grandTotal != null ? Number(item.grandTotal) : lineTotal;

    return {
      ...item,
      itemCode,
      package: item.package ?? 0,
      vatAmount: +vatAmount.toFixed(2),
      lineTotal,
      grandTotal,
    };
  });
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
      if (!items?.length) throw new AppError("Items are required", 400);

      console.log("Service: Incoming transactionNo:", transactionNo); // TEMP LOG: Track incoming

      // FIX: Conditionally set transactionNo - use incoming if provided, else auto-generate
      let finalTransactionNo = transactionNo?.trim();
      if (!finalTransactionNo) {
        finalTransactionNo = generateTransactionNo(type);
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

      const processedItems = calculateItems(items);
      const calculatedTotal = processedItems.reduce(
        (sum, i) => sum + i.lineTotal,
        0
      );

      // FIX: Use incoming totalAmount if provided, else calculated (adjust if you always want calculated)
      const finalTotalAmount =
        totalAmount !== undefined ? totalAmount : calculatedTotal;
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
        totalAmount: finalTotalAmount, // USE: Final total
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

      if (data.items) {
        // Recalculate items with updated data
        data.items = calculateItems(data.items);
        data.totalAmount = data.items.reduce((sum, i) => sum + i.lineTotal, 0);
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

      if (wasApproved) {
        await this.reverseTransactionStock(id, transaction, createdBy, session);
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
  static processTransaction = withTransactionSession(
    async (id, action, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      this.validateAction(transaction.type, action, transaction.status);

      // Store old status for reversal detection
      const wasApproved = transaction.status === "APPROVED";

      if (action === "approve") {
        await this.processTransactionStock(id, transaction, createdBy, session);
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

    const reverseEffect = {
      purchase_order: -totalAmount,
      purchase_return: totalAmount,
      sales_order: -totalAmount,
      sales_return: totalAmount,
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
  static async processTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session
  ) {
    const { type, items, transactionNo } = transaction;
    const stockUpdates = [];

    for (const item of items) {
      const stock = await StockService.getStockByItemId(item.itemId);
      const quantityChange = this.getQuantityChange(type, item.qty);
      const newStock = stock.currentStock + quantityChange;
      // Allow approval even if sales order drives stock negative
      // Previously: if (quantityChange < 0 && newStock < 0) throw error
      // We now skip this blocking validation for sales orders

      let newPurchasePrice = stock.purchasePrice;
      // let price = item.rate; // Use rate as unit price
      let unitPrice = item.rate ? item.rate / (item.qty || 1) : 0; // FIXED: Compute unit from rate/qty
      if (type === "purchase_order") {
        const currentValue = stock.purchasePrice * stock.currentStock;
        const newValue = item.rate || 0;
        const totalQuantity = stock.currentStock + item.qty;
        newPurchasePrice =
          totalQuantity > 0
            ? (currentValue + newValue) / totalQuantity
            : stock.purchasePrice;
      }

      await stock.constructor.findByIdAndUpdate(
        stock._id,
        {
          currentStock: newStock,
          purchasePrice: +newPurchasePrice.toFixed(2),
          updatedAt: new Date(),
        },
        { session }
      );

      const movement = await this.createInventoryMovement(
        {
          stockId: stock.itemId,
          quantity: quantityChange,
          previousStock: stock.currentStock,
          newStock,
          eventType: this.getEventType(type),
          referenceType: "Transaction",
          referenceId: transactionId,
          referenceNumber: transactionNo,
          unitCost: unitPrice,
          totalValue: Math.abs(quantityChange) * unitPrice,
          notes: `${this.getEventType(type)} - ${item.description}`,
          createdBy,
          batchNumber: stock.batchNumber,
          expiryDate: stock.expiryDate,
        },
        session
      );

      stockUpdates.push({
        itemId: item.itemId,
        previousStock: stock.currentStock,
        newStock,
        newPurchasePrice,
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
    const existingMovements = await InventoryMovement.find({
      referenceId: transactionId,
      referenceType: "Transaction",
      isReversed: false,
    }).session(session);

    for (const movement of existingMovements) {
      const stock = await StockService.getStockByItemId(movement.stockId);
      const reversalQuantity = -movement.quantity;
      const newStock = stock.currentStock + reversalQuantity;

      await stock.constructor.findByIdAndUpdate(
        stock._id,
        { currentStock: newStock, updatedAt: new Date() },
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
          totalValue: Math.abs(reversalQuantity) * movement.unitCost,
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
