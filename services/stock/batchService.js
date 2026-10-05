const mongoose = require("mongoose");
const StockBatch = require("../../models/modules/stockBatchModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const DAY = 86400000;
const EPS = 1e-6;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const withSession = (q, session) => (session ? q.session(session) : q);

// Batches carry quantity and expiry. Stock that arrived before batches existed has none; a sale
// larger than the batched quantity is therefore NOT refused - the remainder is returned as
// `unallocated` (legacy / unbatched stock), so existing data keeps working.
class BatchService {
  // Pure FEFO ordering + shelf-life filter: earliest expiry first, no-expiry last, ties by receipt.
  // A batch that has expired by the order date, or will expire before the customer's minimum
  // remaining shelf life, is not eligible.
  static eligibleInOrder(batches, { orderDate = new Date(), minShelfLifeDays = 0 } = {}) {
    const cutoff = new Date(new Date(orderDate).getTime() + Math.max(minShelfLifeDays, 0) * DAY);
    return batches
      .filter((b) => b.qtyOnHand > EPS && b.status === "active" && (!b.expiryDate || new Date(b.expiryDate) >= cutoff))
      .sort((a, b) => {
        const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
        const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
        return ea - eb || new Date(a.receivedAt) - new Date(b.receivedAt) || String(a._id).localeCompare(String(b._id));
      });
  }

  // Pure: split `qty` across ordered batches.
  static plan(ordered, qty) {
    let left = qty;
    const takes = [];
    for (const b of ordered) {
      if (left <= EPS) break;
      const take = Math.min(b.qtyOnHand, left);
      takes.push({ batch: b, qty: round3(take) });
      left -= take;
    }
    return { takes, unallocated: left > EPS ? round3(left) : 0 };
  }

  // The batch document a receipt creates. `transaction` is the receiving document (an approved
  // purchase, or an opening-stock voucher): its id, number and date are all that is read.
  static batchDoc(transaction, item, qty, unitCost, index = 0) {
    const { companyId } = getTenant();
    const batchNumber =
      (item.batchNumber && String(item.batchNumber).trim()) || `${transaction.transactionNo}-${index + 1}`;
    return {
      companyId,
      stockId: item.itemId,
      itemCode: item.itemCode,
      batchNumber,
      expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      receivedQty: qty,
      qtyOnHand: qty,
      unitCost: unitCost || 0,
      sourceTransactionId: transaction._id,
      sourceTransactionNo: transaction.transactionNo,
      receivedAt: transaction.date || new Date(),
    };
  }

  static async receive(transaction, item, qty, unitCost, { session, index = 0 } = {}) {
    const [batch] = await StockBatch.create([this.batchDoc(transaction, item, qty, unitCost, index)], { session });
    return batch;
  }

  // Many receipts of one document in a single round trip: lines = [{ item, qty, unitCost, index }].
  static async receiveMany(transaction, lines, { session } = {}) {
    if (!lines.length) return [];
    return StockBatch.insertMany(
      lines.map((l) => this.batchDoc(transaction, l.item, l.qty, l.unitCost, l.index)),
      { session }
    );
  }

  // Take `qty` first-expiry-first-out. Each decrement is guarded (qtyOnHand >= take), so two
  // concurrent sales cannot both take the same units.
  static async allocate({ stockId, qty, orderDate, minShelfLifeDays = 0, onlyFromTransactionId }, { session } = {}) {
    const { companyId } = getTenant();
    const filter = { companyId, stockId, status: "active", qtyOnHand: { $gt: 0 } };
    if (onlyFromTransactionId) filter.sourceTransactionId = onlyFromTransactionId;
    const batches = await withSession(StockBatch.find(filter).lean(), session);
    const { takes, unallocated } = this.plan(this.eligibleInOrder(batches, { orderDate, minShelfLifeDays }), qty);

    const allocations = [];
    let short = unallocated;
    for (const { batch, qty: take } of takes) {
      const res = await StockBatch.updateOne(
        { _id: batch._id, qtyOnHand: { $gte: take - EPS } },
        { $inc: { qtyOnHand: -take } },
        { session }
      );
      if (res.modifiedCount === 0) { short = round3(short + take); continue; } // lost a race: leave it unallocated
      allocations.push({ batchId: batch._id, batchNumber: batch.batchNumber, qty: take, expiryDate: batch.expiryDate });
    }
    await StockBatch.updateMany({ companyId, stockId, qtyOnHand: { $lte: EPS }, status: "active" }, { status: "depleted" }, { session });
    return { allocations, unallocated: short };
  }

  // Put quantity back into the batches it came from (a return, or reversing a dispatch).
  static async restore(allocations, { session } = {}) {
    for (const a of allocations || []) {
      await StockBatch.updateOne(
        { _id: a.batchId },
        { $inc: { qtyOnHand: a.qty }, $set: { status: "active" } },
        { session }
      );
    }
  }

  // Returned stock with no link to its original goes into a batch of its own.
  static async receiveReturn(transaction, item, qty, { session, index = 0 } = {}) {
    const { companyId } = getTenant();
    const [batch] = await StockBatch.create(
      [{
        companyId, stockId: item.itemId, itemCode: item.itemCode,
        batchNumber: `${transaction.transactionNo}-R${index + 1}`,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
        receivedQty: qty, qtyOnHand: qty, sourceTransactionId: transaction._id,
        sourceTransactionNo: transaction.transactionNo, receivedAt: transaction.date || new Date(),
      }],
      { session }
    );
    return batch;
  }

  // Reversing an approved purchase removes its batches - unless some of that stock was already
  // sold, which cannot be un-received.
  static async removeReceipt(transactionId, { session } = {}) {
    const batches = await withSession(StockBatch.find({ sourceTransactionId: transactionId }), session);
    for (const b of batches) {
      if (b.qtyOnHand + EPS < b.receivedQty) {
        throw new AppError(
          `Batch ${b.batchNumber} has already been partly sold or returned; it cannot be removed`,
          409,
          "BATCH_PARTLY_USED"
        );
      }
    }
    await StockBatch.deleteMany({ sourceTransactionId: transactionId }, { session });
  }

  static async list({ stockId, status, expiringWithinDays, includeEmpty = false } = {}, req) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (stockId) q.stockId = stockId;
    if (status) q.status = status;
    if (!includeEmpty && !status) q.qtyOnHand = { $gt: 0 };
    if (expiringWithinDays !== undefined && expiringWithinDays !== "") {
      q.expiryDate = { $ne: null, $lte: new Date(Date.now() + Number(expiringWithinDays) * DAY) };
    }
    const rows = await StockBatch.find(q).populate("stockId", "itemName sku").sort({ expiryDate: 1, receivedAt: 1 }).limit(500).lean();
    const now = Date.now();
    return rows.map((b) => ({
      ...b,
      itemName: b.stockId?.itemName,
      sku: b.stockId?.sku,
      stockId: b.stockId?._id || b.stockId,
      daysToExpiry: b.expiryDate ? Math.ceil((new Date(b.expiryDate) - now) / DAY) : null,
      expired: Boolean(b.expiryDate && new Date(b.expiryDate) < now),
    }));
  }
}

module.exports = BatchService;
