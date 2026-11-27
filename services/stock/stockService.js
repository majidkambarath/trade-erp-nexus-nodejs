const logger = require("../../utils/logger");
const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const Vendor = require("../../models/modules/vendorModel");
const StockPurchaseLog = require("../../models/modules/StockPurchaseLog"); // Import StockPurchaseLog model
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");
const StockAdjustmentService = require("./stockAdjustmentService");
const ItemKindService = require("./itemKindService");
const kinds = require("../../utils/itemKinds");
const { searchRegex } = require("../../utils/regex");
const { isTransient, backoff } = require("../../utils/withTransactionSession");
const { normaliseHsn } = require("../../utils/gst");
const { cleanBarcode } = require("../../utils/barcodes");

// The HSN / SAC code a request names: digits or nothing. undefined = not named; a bad one is refused.
function requestedHsn(data) {
  if (data?.hsnCode === undefined) return undefined;
  const code = normaliseHsn(data.hsnCode);
  if (code === undefined) throw new AppError("An HSN / SAC code is 4 to 8 digits", 400, "INVALID_HSN");
  return code;
}

// The barcode a request names, trimmed; "" when it names none (the item then takes its SKU). A bad one is refused.
function requestedBarcode(value) {
  const { value: code, error } = cleanBarcode(value);
  if (error) throw new AppError(error, 400, "INVALID_BARCODE", { fields: ["barcodeQrCode"] });
  return code;
}

// A scanner reading a code must find ONE item, so a barcode may not be another item's barcode or SKU. Checked here
// rather than by a unique index: an organisation's older items may already share one, and an index that cannot be built
// would protect nothing. An item that already shares one is not refused until somebody changes that barcode.
// `fromSku`: nobody typed a barcode, the SKU is standing in (or becoming the new SKU), so it is the SKU box that is wrong.
// `barcodesOnly`: look only at barcodes (a changed SKU: another item's SKU is the unique index's own refusal).
async function assertBarcodeFree(code, exceptId, session, { fromSku = false, barcodesOnly = false } = {}) {
  if (!code) return;
  const filter = barcodesOnly ? { barcodeQrCode: code } : { $or: [{ barcodeQrCode: code }, { sku: code }] };
  if (exceptId) filter._id = { $ne: exceptId };
  const other = await Stock.findOne(filter).select("itemName sku").session(session || null).lean();
  if (other) {
    throw new AppError(
      fromSku
        ? `That SKU is the barcode of ${other.itemName} (${other.sku}). Choose another SKU, or give this item its own barcode.`
        : `That barcode is already used by ${other.itemName} (${other.sku}). Each item needs its own barcode.`,
      409,
      "BARCODE_TAKEN",
      { fields: [fromSku ? "sku" : "barcodeQrCode"], itemId: String(other._id) }
    );
  }
}

// The item type a request names, or goods when it names none. Anything else is refused with a code the screen can show.
function requestedType(value, ...rest) {
  const fallback = rest.length ? rest[0] : kinds.GOODS; // pass undefined to learn that nothing was asked for
  const type = kinds.parseItemType(value);
  if (type === null) throw new AppError("Item type must be goods or service", 400, "INVALID_ITEM_TYPE");
  return type === undefined ? fallback : type;
}

// A service has no quantity, reorder level, batch, expiry or barcode: a request that gives it one is refused, not trimmed,
// so nobody believes a reorder level on a service is being watched.
function assertNoStockFields(data) {
  const given = kinds.stockFieldsOnService(data);
  if (given.length) {
    throw new AppError(
      `A service item has no ${given.join(", ")}. Leave stock fields blank for services.`,
      400,
      "SERVICE_HAS_NO_STOCK",
      { fields: given }
    );
  }
}

// The automatic SKU: two letters of the category's name, then the next number after the highest SKU with that prefix,
// four digits (the rule the item form has always shown, lib/quickCreate.js nextSku). Worked out HERE, not in the
// browser, so two people adding items at once cannot both be handed the same one: whoever loses the race on the unique
// index is given the next number (createStock retries) instead of an error.
const skuPrefix = (categoryName) => String(categoryName || "").substring(0, 2).toUpperCase().replace(/[^A-Z]/g, "");
async function nextSkuFor(categoryName, session) {
  const prefix = skuPrefix(categoryName);
  const rx = new RegExp(`^${prefix}\\d+$`);
  const q = Stock.find({ sku: rx }).select("sku").lean();
  const rows = await (session ? q.session(session) : q);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.sku).slice(prefix.length), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  const numbered = (n) => `${prefix}${String(n).padStart(4, "0")}`;
  // the SKU also stands in as the barcode, so a number some item already carries as its barcode is passed over
  let next = max + 1;
  for (;;) {
    const held = Stock.exists({ barcodeQrCode: numbered(next) });
    if (!(await (session ? held.session(session) : held))) return numbered(next);
    next += 1;
  }
}
const CREATE_TRIES = 8;

// The item's own code: the first three letters of its name and a random four-digit number, the format the item list has always
// shown. Nothing checks it against the other items beforehand - the unique index does - so createStock draws again when two
// items drew the same one. (About 4 in 10 odds of at least one clash among 100 items whose names start alike.)
function generateItemId(itemName) {
  const prefix = String(itemName || "").trim().substring(0, 3).toUpperCase() || "ITM"; // "ITM" when the name is missing
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${randomNum}`;
}

// What an item may say about its supplier: the name and the code, nothing else. `GET /stock/stock` is open to every role
// (lookups.view: the pick lists), and a bare populate("vendorId") handed every reader the supplier's WHOLE record - bank
// account numbers and IBANs, KYC document numbers, credit limit, balance (found in the review of 21 Nov 2026, the same
// class as the transaction list's party projection). The screens read `vendorName` and `_id` only.
const VENDOR_FIELDS = "vendorName vendorId";

class StockService {
  static nextSkuFor = nextSkuFor;
  static generateItemId = generateItemId; // a seam: a test makes two items draw the same code

  // `autoSku: true` (the item form's automatic SKU, and an item quick-added from an order) lets the server choose the
  // SKU; anything the request typed in `sku` is then only the preview the form showed.
  //
  // Two things are tried again, each by running the whole create afresh in a new transaction: an automatic SKU another item
  // took first (counted again), and an item CODE another item drew first (drawn again). A SKU the person typed is never
  // retried: a clash there is their answer to read ("That SKU is already used").
  static async createStock(data, createdBy) {
    const autoSku = Boolean(data?.autoSku);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.createStockOnce(data, createdBy, { autoSku });
      } catch (err) {
        // a committed twin is a duplicate key; one still in its transaction is a write conflict - either way, try again
        const duplicate = err?.code === 11000;
        const codeClash = duplicate && (err.keyPattern?.itemId || /itemId/.test(String(err.message)));
        const skuClash = autoSku && duplicate && (err.keyPattern?.sku || /sku/.test(String(err.message)));
        const again = codeClash || skuClash || (autoSku && isTransient(err));
        if (!again || attempt >= CREATE_TRIES) throw err;
        await backoff(attempt);
      }
    }
  }

  static async createStockOnce(data, createdBy, { autoSku = false } = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        itemId,
        itemName,
        categoryId,
        vendorId,
        unitOfMeasure,
        barcodeQrCode,
        reorderLevel,
        batchNumber,
        expiryDate,
        purchasePrice,
        salesPrice,
        currentStock,
        status,
        origin,
        brand,
        incomeAccountId,
        expenseAccountId,
      } = data;

      // goods (the default) or service; a service keeps none of the stock fields and may name its own accounts
      const itemType = requestedType(data.itemType);
      const isService = itemType === kinds.SERVICE;
      if (isService) assertNoStockFields(data);
      await ItemKindService.checkAccounts({ itemType, incomeAccountId, expenseAccountId }, { session });

      // Validate category exists
      const categoryExists = await Category.findById(categoryId).session(
        session
      );
      if (!categoryExists) {
        throw new AppError("Category not found", 404);
      }
      const sku = autoSku ? await nextSkuFor(categoryExists.name, session) : data.sku;

      // Validate vendor exists
      // const vendorExists = await Vendor.findById(vendorId).session(session);
      // if (!vendorExists) {
      //   throw new AppError("Vendor not found", 404);
      // }

      const newItemId = StockService.generateItemId(itemName);
      // Check if SKU already exists
      const existingSku = await Stock.findOne({ sku }).session(session);
      if (existingSku) {
        throw new AppError("That SKU is already used by another item", 400, "DUPLICATE_SKU", { fields: ["sku"] });
      }

      // goods carry a barcode: the one named, else the SKU, which the item form draws as one
      const typed = isService ? "" : requestedBarcode(barcodeQrCode);
      const barcode = isService ? "" : typed || sku;
      if (!isService) await assertBarcodeFree(barcode, null, session, { fromSku: !typed });

      // Create stock record
      const stock = await Stock.create(
        [
          {
            itemId: newItemId,
            sku,
            itemName,
            category: categoryId,
            vendorId,
            itemType,
            ...(requestedHsn(data) ? { hsnCode: requestedHsn(data) } : {}),
            ...(isService ? { incomeAccountId: incomeAccountId || null, expenseAccountId: expenseAccountId || null } : {}),
            unitOfMeasure,
            // a service has no barcode, reorder level, batch or expiry: the model leaves them at their blanks
            ...(isService
              ? { reorderLevel: 0, currentStock: 0 }
              : {
                  barcodeQrCode: barcode,
                  reorderLevel: Number(reorderLevel) || 0,
                  batchNumber,
                  expiryDate: expiryDate ? new Date(expiryDate) : undefined,
                  currentStock: Number(currentStock) || 0,
                }),
            purchasePrice: Number(purchasePrice) || 0,
            salesPrice: Number(salesPrice) || 0,
            status,
            origin,
            brand,
          },
        ],
        { session }
      );

      // Create initial inventory movement if stock > 0 (a service never has any)
      const initialStock = isService ? 0 : Number(currentStock) || 0;
      if (initialStock > 0) {
        await this.createInventoryMovement(
          {
            stockId: newItemId,
            quantity: initialStock,
            previousStock: 0,
            newStock: initialStock,
            eventType: "INITIAL_STOCK",
            referenceType: "Initial",
            referenceId: stock[0]._id,
            referenceNumber: `INIT-${newItemId}`,
            unitCost: Number(purchasePrice) || 0,
            totalValue: initialStock * (Number(purchasePrice) || 0),
            notes: "Initial stock entry",
            createdBy,
            batchNumber,
            expiryDate,
            origin,
            brand,
          },
          session
        );
      }

      await session.commitTransaction();
      return stock[0];
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async updateStock(id, data, createdBy, options = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const currentStock = await Stock.findById(id).session(session);
      if (!currentStock) {
        throw new AppError("Stock item not found", 404);
      }

      // Check SKU uniqueness if updating
      if (data.sku && data.sku !== currentStock.sku) {
        const existingSku = await Stock.findOne({
          sku: data.sku,
          _id: { $ne: id },
        }).session(session);
        if (existingSku) {
          throw new AppError("That SKU is already used by another item", 400, "DUPLICATE_SKU", { fields: ["sku"] });
        }
      }

      // Validate category if provided
      if (data.category) {
        const categoryExists = await Category.findById(data.category).session(
          session
        );
        if (!categoryExists) {
          throw new AppError("Category not found", 404);
        }
      }

      // Validate vendor if provided
      if (data.vendorId) {
        const vendorExists = await Vendor.findById(data.vendorId).session(
          session
        );
        if (!vendorExists) {
          throw new AppError("Vendor not found", 404);
        }
      }

      // goods or service. The type can change only while nothing is built on the item, and a service keeps no stock fields.
      const currentType = kinds.itemTypeOf(currentStock);
      const nextType = requestedType(data.itemType, currentType);
      if (nextType !== currentType) await ItemKindService.assertTypeChange(currentStock, nextType, { session });
      if (nextType === kinds.SERVICE) assertNoStockFields(data);
      await ItemKindService.checkAccounts(
        {
          itemType: nextType,
          incomeAccountId: data.incomeAccountId === undefined ? undefined : data.incomeAccountId,
          expenseAccountId: data.expenseAccountId === undefined ? undefined : data.expenseAccountId,
        },
        { session }
      );

      // Handle stock quantity update
      const oldQuantity = currentStock.currentStock;
      const newQuantity =
        data.currentStock !== undefined
          ? Number(data.currentStock)
          : oldQuantity;

      // Validate non-negative stock
      if (newQuantity < 0) {
        throw new AppError("Stock quantity cannot be negative", 400);
      }

      // Convert numeric fields. What an edit may write: not the system's own fields (the cost pool moves only through the costing
      // engine, the id and the organisation never change) and not an update operator ($set ...) smuggled in as a key.
      const updateData = Object.fromEntries(
        Object.entries(data).filter(([k]) => !["_id", "__v", "companyId", "costValue", "createdAt", "updatedAt"].includes(k) && !k.startsWith("$"))
      );
      if (data.reorderLevel)
        updateData.reorderLevel = Number(data.reorderLevel);
      if (data.purchasePrice)
        updateData.purchasePrice = Number(data.purchasePrice);
      if (data.salesPrice) updateData.salesPrice = Number(data.salesPrice);
      if (data.currentStock)
        updateData.currentStock = Number(data.currentStock);
      if (data.expiryDate) updateData.expiryDate = new Date(data.expiryDate);
      if (data.itemType !== undefined) updateData.itemType = nextType;
      if (data.hsnCode !== undefined) updateData.hsnCode = requestedHsn(data);
      if (data.sku !== undefined && String(data.sku) !== currentStock.sku && nextType !== kinds.SERVICE) {
        await assertBarcodeFree(String(data.sku).trim(), id, session, { fromSku: true, barcodesOnly: true });
      }
      // a barcode named on an edit: blank goes back to the SKU; only a CHANGED one is checked, so an item that already
      // shares a barcode with another (from before the rule) can still be saved for an unrelated change
      if (data.barcodeQrCode !== undefined && nextType !== kinds.SERVICE) {
        const barcode = requestedBarcode(data.barcodeQrCode) || data.sku || currentStock.sku;
        if (barcode !== currentStock.barcodeQrCode) await assertBarcodeFree(barcode, id, session);
        updateData.barcodeQrCode = barcode;
      }
      // goods name no accounts of their own; a service that becomes goods (only possible while unused) forgets them
      if (nextType === kinds.GOODS && currentType === kinds.SERVICE) Object.assign(updateData, { incomeAccountId: null, expenseAccountId: null });

      const updatedStock = await Stock.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: true,
        session,
      });
      // an unused goods item that becomes a service leaves nothing of the stock side behind
      const becameService = nextType === kinds.SERVICE && currentType === kinds.GOODS;
      if (becameService) {
        await Stock.updateOne(
          { _id: id },
          { $set: { reorderLevel: 0, currentStock: 0, costValue: null }, $unset: { batchNumber: 1, expiryDate: 1, barcodeQrCode: 1 } },
          { session }
        );
      }

      // A changed quantity is a stock event: costed, batched, written to the movement ledger and,
      // when posting is on, booked against Inventory / Stock adjustment.
      let adjustment = null;
      if (newQuantity !== oldQuantity) {
        adjustment = await StockAdjustmentService.apply(
          { ...options, stock: currentStock, newQuantity, unitCost: options.unitCost ?? data.purchasePrice, createdBy },
          { session }
        );
      }

      await session.commitTransaction();
      // the adjustment moved the cost pool after the edit was written: return what is stored now
      const result = adjustment || becameService ? await Stock.findById(id) : updatedStock;
      if (adjustment) result.$locals.adjustment = adjustment;
      return result;
    } catch (error) {
      await session.abortTransaction();
      console.error(`Error updating stock (ID: ${id}):`, error.message);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async processTransactionStock(
    transactionId,
    transactionData,
    createdBy
  ) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { type, items, transactionNo } = transactionData;
      const stockUpdates = [];

      for (const item of items) {
        const stock = await Stock.findOne({ itemId: item.itemId }).session(
          session
        );
        if (!stock) {
          throw new AppError(`Stock item ${item.itemId} not found`, 404);
        }
        if (kinds.isService(stock)) continue; // a service line moves no stock

        const quantityChange = this.getQuantityChange(type, item.qty);
        const newStock = stock.currentStock + quantityChange;

        if (quantityChange < 0 && newStock < 0) {
          throw new AppError(
            `Insufficient stock for ${item.description}. Available: ${stock.currentStock}, Required: ${item.qty}`,
            400
          );
        }

        let newPurchasePrice = stock.purchasePrice;
        if (type === "purchase_order") {
          // Calculate weighted average price
          const currentValue = stock.purchasePrice * stock.currentStock;
          const newValue = item.rate; //item.price * item.qty
          const totalQuantity = stock.currentStock + item.qty;
          newPurchasePrice =
            totalQuantity > 0
              ? (currentValue + newValue) / totalQuantity
              : stock.purchasePrice;
        }

        await Stock.findByIdAndUpdate(
          stock._id,
          {
            currentStock: newStock,
            purchasePrice: newPurchasePrice,
            updatedAt: new Date(),
          },
          { session }
        );

        const movement = await this.createInventoryMovement(
          {
            stockId: item.itemId,
            quantity: quantityChange,
            previousStock: stock.currentStock,
            newStock,
            eventType: this.getEventType(type),
            referenceType: "Transaction",
            referenceId: transactionId,
            referenceNumber: transactionNo,
            unitCost: item.price,
            totalValue: Math.abs(quantityChange) * item.price,
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

      await session.commitTransaction();
      return stockUpdates;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

 static async getPurchaseLogsByItemId(itemId) {
  try {
    // Convert itemId to ObjectId
    const stockId = new mongoose.Types.ObjectId(itemId);

    // Find the stock document to confirm it exists
    const stock = await Stock.findOne({ _id: stockId });
    if (!stock) {
      throw new AppError("Stock item not found", 404);
    }

    // Find purchase logs where items.itemId matches the stock._id
    const purchaseLogs = await StockPurchaseLog.find({
      "items.itemId": stockId,
    })
      .populate({
        path: "partyId",
        select: "vendorName", // Select only vendorName
      })
      .lean();

    logger.debug("Raw purchase logs:", purchaseLogs);

    // Format the response to include only relevant item details
    const formattedLogs = purchaseLogs.map((log) => ({
      transactionNo: log.transactionNo,
      type: log.type,
      party: log.partyId ? log.partyId.vendorName : "N/A", // Use vendorName
      date: log.date,
      deliveryDate: log.deliveryDate,
      items: log.items
        .filter((item) => item.itemId.toString() === stockId.toString())
        .map((item) => ({
          itemId: item.itemId,
          description: item.description,
          qty: item.qty,
          rate: item.rate,
          vatPercent: item.vatPercent,
          price: item.price,
          expiryDate: item.expiryDate,
        })),
      terms: log.terms,
      notes: log.notes,
      priority: log.priority,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
    }));

    return formattedLogs;
  } catch (error) {
    throw new AppError(
      error.message || "Error fetching purchase logs",
      error.statusCode || 500
    );
  }
}
  static async reverseTransactionStock(
    transactionId,
    transactionData,
    createdBy
  ) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { type, items, transactionNo } = transactionData;

      const existingMovements = await InventoryMovement.find({
        referenceId: transactionId,
        referenceType: "Transaction",
      }).session(session);

      for (const movement of existingMovements) {
        const stock = await Stock.findOne({ itemId: movement.stockId }).session(
          session
        );
        if (!stock) continue;

        const reversalQuantity = -movement.quantity;
        const newStock = stock.currentStock + reversalQuantity;

        // Note: Not updating purchasePrice on reversal
        await Stock.findOneAndUpdate(
          { itemId: movement.stockId },
          { currentStock: newStock, updatedAt: new Date() },
          { session }
        );

        await this.createInventoryMovement(
          {
            stockId: movement.stockId,
            quantity: reversalQuantity,
            previousStock: stock.currentStock,
            newStock,
            eventType: movement.eventType,
            referenceType: "Transaction",
            referenceId: transactionId,
            referenceNumber: `REV-${transactionNo}`,
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
          { isReversed: true },
          { session }
        );
      }

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async createInventoryMovement(movementData, session = null) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  static getQuantityChange(transactionType, quantity) {
    const quantityMap = {
      purchase_order: quantity,
      sales_order: -quantity,
      purchase_return: -quantity,
      sales_return: quantity,
    };

    return quantityMap[transactionType] || 0;
  }

  static getEventType(transactionType) {
    const eventMap = {
      purchase_order: "PURCHASE_RECEIVE",
      sales_order: "SALES_DISPATCH",
      purchase_return: "PURCHASE_RETURN",
      sales_return: "SALES_RETURN",
    };

    return eventMap[transactionType];
  }

  static async getStockHistory(itemId, startDate, endDate) {
    return InventoryMovement.getStockHistory(itemId, startDate, endDate);
  }

  static async getStockWithMovements(itemId) {
    const stock = await Stock.findOne({ itemId })
      .populate("category")
      .populate("vendorId", VENDOR_FIELDS);
    if (!stock) {
      throw new AppError("Stock item not found", 404);
    }

    const movements = await InventoryMovement.find({ stockId: itemId })
      .sort({ date: -1 })
      .limit(20);

    const movementsSummary = await InventoryMovement.aggregate([
      { $match: { stockId: itemId } },
      {
        $group: {
          _id: "$eventType",
          totalQuantity: { $sum: "$quantity" },
          count: { $sum: 1 },
          totalValue: { $sum: "$totalValue" },
        },
      },
    ]);

    return {
      stock,
      recentMovements: movements,
      movementsSummary,
    };
  }

  static async getLowStockItems() {
    return Stock.find({
      $expr: { $lte: ["$currentStock", "$reorderLevel"] },
      status: "Active",
      ...kinds.STOCKED_ONLY, // a service has 0 on hand and a 0 reorder level: it would always read as low
    })
      .populate("category")
      .populate("vendorId", VENDOR_FIELDS)
      .sort({ currentStock: 1 });
  }

  static async getStockValuation() {
    return Stock.aggregate([
      {
        $match: { status: "Active", ...kinds.STOCKED_ONLY },
      },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          totalQuantity: { $sum: "$currentStock" },
          totalPurchaseValue: {
            $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
          },
          totalSalesValue: {
            $sum: { $multiply: ["$currentStock", "$salesPrice"] },
          },
        },
      },
    ]);
  }

  static async getAllStock(filters) {
    const query = {};

    if (filters.search) {
      query.$or = [
        { itemId: searchRegex(filters.search) },
        { sku: searchRegex(filters.search) },
        { itemName: searchRegex(filters.search) },
        { batchNumber: searchRegex(filters.search) },
        { barcodeQrCode: searchRegex(filters.search) }, // what a scanner reads is what a person types
      ];
    }

    if (filters.status) query.status = filters.status;

    // (`new` is required: without it Mongoose 8 throws, so these two filters answered 500 whenever they were used)
    if (filters.category) {
      if (!mongoose.isValidObjectId(filters.category)) throw new AppError("Invalid category id", 400, "INVALID_ID");
      query.category = new mongoose.Types.ObjectId(String(filters.category));
    }

    if (filters.vendorId) {
      if (!mongoose.isValidObjectId(filters.vendorId)) throw new AppError("Invalid vendor id", 400, "INVALID_ID");
      query.vendorId = new mongoose.Types.ObjectId(String(filters.vendorId));
    }

    // ?itemType=goods|service narrows the list; anything about quantity on hand is about goods only
    const wantType = requestedType(filters.itemType, undefined);
    const aboutQuantity = filters.lowStock === "true" || filters.minStock || filters.maxStock;
    if (wantType === kinds.SERVICE) {
      if (aboutQuantity) return []; // a service has no quantity to be low, high or between
      query.itemType = kinds.SERVICE;
    } else if (wantType === kinds.GOODS || aboutQuantity) {
      Object.assign(query, kinds.STOCKED_ONLY);
    }

    if (filters.lowStock === "true") {
      query.$expr = { $lte: ["$currentStock", "$reorderLevel"] };
    }

    if (filters.minStock)
      query.currentStock = { $gte: Number(filters.minStock) };
    if (filters.maxStock) {
      query.currentStock = {
        ...query.currentStock,
        $lte: Number(filters.maxStock),
      };
    }

    if (filters.minPrice) query.salesPrice = { $gte: Number(filters.minPrice) };
    if (filters.maxPrice) {
      query.salesPrice = {
        ...query.salesPrice,
        $lte: Number(filters.maxPrice),
      };
    }

    return Stock.find(query)
      .populate("category")
      .populate("vendorId", VENDOR_FIELDS)
      .sort({ createdAt: -1 });
  }

  static async getStockById(id) {
    const stock = await Stock.findById(id)
      .populate("category")
      .populate("vendorId", VENDOR_FIELDS)
      .populate("unitOfMeasure")
      .populate("incomeAccountId", "accountName accountCode") // a service's own accounts, named for the item screen
      .populate("expenseAccountId", "accountName accountCode");
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async getStockByItemId(itemId) {
    // an item is looked up by its id: anything else is "no such item", not a database error
    if (!mongoose.isValidObjectId(itemId)) throw new AppError("Stock item not found", 404);
    const stock = await Stock.findOne({
      _id: itemId,
    })
      .populate("category")
      .populate("vendorId", VENDOR_FIELDS);
    logger.debug(stock);
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async deleteStock(id) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const stock = await Stock.findById(id).session(session);
      if (!stock) throw new AppError("Stock item not found", 404);

      // an item that has moved, been bought, sold or quoted is part of the books: it is switched off, never deleted
      await require("../core/inUseService").assertItemFree(stock, { session });

      await Stock.findByIdAndDelete(id).session(session);

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getStockStats() {
    const stats = await Stock.aggregate([
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          activeItems: {
            $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] },
          },
          inactiveItems: {
            $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] },
          },
          // services are counted as items but never as low stock (0 on hand, 0 reorder level)
          serviceItems: {
            $sum: { $cond: [{ $eq: ["$itemType", kinds.SERVICE] }, 1, 0] },
          },
          lowStockItems: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$itemType", kinds.SERVICE] }, { $lte: ["$currentStock", "$reorderLevel"] }] },
                1,
                0,
              ],
            },
          },
          totalStockValue: {
            $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
          },
          totalSalesValue: {
            $sum: { $multiply: ["$currentStock", "$salesPrice"] },
          },
          totalCurrentStock: { $sum: "$currentStock" },
        },
      },
    ]);

    return (
      stats[0] || {
        totalItems: 0,
        activeItems: 0,
        inactiveItems: 0,
        serviceItems: 0,
        lowStockItems: 0,
        totalStockValue: 0,
        totalSalesValue: 0,
        totalCurrentStock: 0,
      }
    );
  }
}

module.exports = StockService;
