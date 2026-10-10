const mongoose = require("mongoose");
const Stock = require("../../models/modules/stockModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const AppError = require("../../utils/AppError");
const { allBranches } = require("../../utils/tenantContext");
const kinds = require("../../utils/itemKinds");

// Goods and services, where the database is involved (the pure rules are in utils/itemKinds.js):
//   - what kind each line of a document is, and the accounts a service names (one query per document)
//   - the refusals: a service has no stock; an item's type cannot change once something is built on it
//   - the income / expense accounts a service item names must be real, active accounts of the right category
const withSession = (q, session) => (session ? q.session(session) : q);
const isId = (v) => mongoose.isValidObjectId(v);

class ItemKindService {
  // Map(String itemId -> the item's type and accounts) for the lines of a document. An item that no longer
  // exists is simply absent: callers treat an absent item as goods (the old behaviour) and fail on it elsewhere.
  static async load(lines, { session } = {}) {
    const ids = [...new Set((lines || []).map((l) => String(l?.itemId?._id || l?.itemId)).filter(isId))];
    if (!ids.length) return new Map();
    const rows = await withSession(Stock.find({ _id: { $in: ids } }).select("itemType incomeAccountId expenseAccountId").lean(), session);
    return new Map(rows.map((s) => [String(s._id), s]));
  }

  // (line) => { service, incomeAccountId, expenseAccountId } over a Map from load().
  static kindOf(map) {
    return (line) => {
      const s = map.get(String(line?.itemId?._id || line?.itemId));
      return { service: kinds.isService(s), incomeAccountId: s?.incomeAccountId || null, expenseAccountId: s?.expenseAccountId || null };
    };
  }

  // The lines with itemType set from the item master. The request's own value is overwritten, so a client cannot
  // mark a goods line as a service to dodge the stock movement (or the reverse).
  static async stamp(lines, { session } = {}) {
    const map = await this.load(lines, { session });
    return (lines || []).map((l) => {
      const s = map.get(String(l?.itemId?._id || l?.itemId));
      return { ...l, itemType: kinds.itemTypeOf(s) };
    });
  }

  // A service has no quantity to adjust, count, write off, open with or move.
  static assertStocked(stock, what = "have stock") {
    if (kinds.isService(stock)) {
      throw new AppError(`${stock.itemName} is a service item and cannot ${what}. Services have no quantity on hand.`, 409, "SERVICE_HAS_NO_STOCK");
    }
  }

  // What is built on an item: stock movements and batches (goods only) and every document with a line for it,
  // in every branch. A type change is refused while any of it exists.
  static async usage(stock, { session } = {}) {
    const Transaction = require("../../models/modules/transactionModel");
    const Quotation = require("../../models/modules/quotationModel");
    const DeliveryNote = require("../../models/modules/deliveryNoteModel");
    const [movements, batches, transactions, quotations, notes] = await allBranches(() =>
      Promise.all([
        withSession(InventoryMovement.countDocuments({ stockId: stock.itemId }), session),
        withSession(StockBatch.countDocuments({ stockId: stock._id }), session),
        withSession(Transaction.countDocuments({ "items.itemId": stock._id }), session),
        withSession(Quotation.countDocuments({ "items.itemId": stock._id }), session),
        withSession(DeliveryNote.countDocuments({ "items.itemId": stock._id }), session),
      ])
    );
    return { movements, batches, documents: transactions + quotations + notes, transactions, quotations, deliveryNotes: notes };
  }

  // Goods -> service needs an item nothing has happened to: no stock, no movement, no batch, no document.
  // Service -> goods needs no document against it (a service line was sold without stock; making the item
  // goods afterwards would leave those lines meaning something else). Either way an item nothing refers to
  // can be changed freely, so a mistake at creation is easy to put right.
  static async assertTypeChange(stock, nextType, { session } = {}) {
    if (kinds.itemTypeOf(stock) === nextType) return;
    const u = await this.usage(stock, { session });
    const onHand = Number(stock.currentStock) || 0;
    if (u.documents > 0 || u.movements > 0 || u.batches > 0 || onHand !== 0) {
      const toService = nextType === kinds.SERVICE;
      const why = [
        u.documents > 0 && `${u.documents} document${u.documents === 1 ? "" : "s"} refer to it`,
        u.movements > 0 && `it has ${u.movements} stock movement${u.movements === 1 ? "" : "s"}`,
        u.batches > 0 && `it has batches`,
        onHand !== 0 && `${onHand} are on hand`,
      ].filter(Boolean).join(", ");
      throw new AppError(
        `${stock.itemName} cannot become ${toService ? "a service" : "goods"}: ${why}. Create a new ${toService ? "service" : "goods"} item instead.`,
        409,
        "ITEM_TYPE_LOCKED",
        { ...u, onHand }
      );
    }
  }

  // The income / expense accounts a service item names. Blank clears the choice. Only a service can name them: goods
  // post to the company's defaults, so a stray value on goods would look like a setting that does nothing.
  static async checkAccounts({ itemType, incomeAccountId, expenseAccountId }, { session } = {}) {
    const wanted = [
      ["incomeAccountId", incomeAccountId, "income", "INVALID_INCOME_ACCOUNT", "Income account"],
      ["expenseAccountId", expenseAccountId, "expense", "INVALID_EXPENSE_ACCOUNT", "Expense account"],
    ];
    for (const [, value, type, code, label] of wanted) {
      if (value === undefined || value === null || value === "") continue;
      if (itemType !== kinds.SERVICE) throw new AppError(`${label} applies to service items only`, 400, "ACCOUNTS_ONLY_FOR_SERVICES");
      if (!isId(value)) throw new AppError(`${label} is not valid`, 400, code);
      const account = await withSession(LedgerAccount.findById(value).select("accountName accountType isActive allowDirectPosting").lean(), session);
      if (!account) throw new AppError(`${label} not found`, 400, code);
      if (account.accountType !== type) throw new AppError(`${label} must be an ${type} account; ${account.accountName} is ${account.accountType}`, 400, code);
      if (account.isActive === false || account.allowDirectPosting === false) {
        throw new AppError(`${account.accountName} cannot take postings, so it cannot be this item's ${label.toLowerCase()}`, 400, code);
      }
    }
  }
}

module.exports = ItemKindService;
