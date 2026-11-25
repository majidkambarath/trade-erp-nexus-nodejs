const AppError = require("../../utils/AppError");
const VanOp = require("../../models/modules/vansales/vanOpModel");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { orgDay } = require("../../utils/documentExpiry");
const VanTripSales = require("./vanTripSales");
const VanVisitService = require("./vanVisitService");

const MAX_OPS = 100;
const KINDS = new Set(["sell", "collect", "return", "visit"]);

// What a phone did with no signal, applied when it is back. Each operation runs in ONE transaction with its VanOp row,
// keyed on the phone's own id: the same operation sent twice makes one invoice (the second insert hits the unique index,
// the transaction rolls back, and the first result is answered). Operations are applied in the order the phone did
// them, each on its own: one refused (credit stopped, not enough on the van) does not stop the rest, and comes back
// with the server's reason so the salesman can fix it and send it again. Nothing here is a new rule: every operation
// is the same sell / collect / return / visit the online screen calls, with the same checks.
class VanSyncService {
  static async sync(tripId, ops, by, { req, mayUnderprice = false, byName = "" } = {}) {
    if (!Array.isArray(ops) || !ops.length) throw new AppError("Nothing to send", 400, "NOTHING_TO_SYNC");
    if (ops.length > MAX_OPS) throw new AppError(`Send at most ${MAX_OPS} at a time`, 400, "TOO_MANY_OPS");
    const results = [];
    for (const op of ops) {
      const clientId = String(op?.clientId || "").trim().slice(0, 64);
      if (!clientId || !KINDS.has(op?.kind)) {
        results.push({ clientId, ok: false, error: { code: "OP_INVALID", message: "Not something the van can send" } });
        continue;
      }
      const at = op.at && !Number.isNaN(new Date(op.at).getTime()) ? new Date(op.at) : new Date();
      try {
        const result = await withTransactionSession(async (session) => {
          await VanOp.create([{ clientId, tripId, kind: op.kind, at, by: String(by) }], { session });
          const body = { ...(op.body || {}), date: orgDay(at) };
          let r;
          if (op.kind === "sell") {
            const { invoice, receipt } = await VanTripSales.sell(tripId, body, by, { req, mayUnderprice }, session);
            r = { invoiceId: String(invoice._id), invoiceNo: invoice.transactionNo, total: invoice.totalAmount, receiptNo: receipt?.voucherNo || null };
          } else if (op.kind === "collect") {
            const { receipt } = await VanTripSales.collect(tripId, body, by, { req }, session);
            r = { receiptId: String(receipt._id), receiptNo: receipt.voucherNo };
          } else if (op.kind === "return") {
            const { creditNote } = await VanTripSales.returnGoods(tripId, body, by, { req, mayUnderprice }, session);
            r = { returnId: String(creditNote._id), returnNo: creditNote.transactionNo };
          } else {
            const v = await VanVisitService.record(tripId, { ...(op.body || {}), at }, by, byName, session);
            r = { visitId: String(v._id) };
          }
          await VanOp.updateOne({ clientId }, { $set: { result: r } }, { session });
          return r;
        })();
        results.push({ clientId, ok: true, result });
      } catch (err) {
        const repeat = err?.code === 11000 && (err.keyPattern?.clientId || /clientId/.test(String(err.message || "")));
        if (repeat) {
          const prev = await VanOp.findOne({ clientId }).lean();
          if (prev) {
            results.push({ clientId, ok: true, result: prev.result, repeat: true });
            continue;
          }
        }
        results.push({ clientId, ok: false, error: { code: err.code || "FAILED", message: err.message || "It could not be saved", details: err.details } });
      }
    }
    return { results, applied: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length };
  }
}

module.exports = VanSyncService;
