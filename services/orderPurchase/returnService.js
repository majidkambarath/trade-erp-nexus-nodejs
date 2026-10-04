const Transaction = require("../../models/modules/transactionModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const ORIGINAL_TYPE = { sales_return: "sales_order", purchase_return: "purchase_order" };
const DEAD_STATUSES = ["REJECTED", "CANCELLED"];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EPS = 1e-6;

// A return references the document it returns and may not exceed it. Returned quantities are
// DERIVED from the live returns each time rather than incremented, so deleting or rejecting a
// return frees its quantity automatically.
class ReturnService {
  static async settings(session) {
    const q = CompanySettings.findOne({ companyId: getTenant().companyId })
      .select("returnWindowDays requireReturnLink")
      .lean();
    return (await (session ? q.session(session) : q)) || {};
  }

  // Quantity and value already returned, per original line.
  static async returnedByLine(originalId, { excludeId, session } = {}) {
    const match = { "returnOf.transactionId": originalId, status: { $nin: DEAD_STATUSES } };
    if (excludeId) match._id = { $ne: excludeId };
    const agg = Transaction.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $group: { _id: "$items.returnOfLineId", qty: { $sum: "$items.qty" }, value: { $sum: "$items.taxableAmount" } } },
    ]);
    const rows = await (session ? agg.session(session) : agg);
    return new Map(rows.map((r) => [String(r._id), { qty: r.qty, value: r.value }]));
  }

  // Original lines with how much of each can still be returned (feeds the return form's picker).
  static async returnable(originalId, { excludeId, session } = {}) {
    const q = Transaction.findById(originalId);
    const original = await (session ? q.session(session) : q).lean();
    if (!original) throw new AppError("Original document not found", 404);
    const returned = await this.returnedByLine(original._id, { excludeId, session });
    return {
      transactionId: original._id,
      transactionNo: original.transactionNo,
      type: original.type,
      status: original.status,
      date: original.date,
      partyId: original.partyId,
      lines: original.items.map((l) => {
        const r = returned.get(String(l._id)) || { qty: 0, value: 0 };
        return {
          lineId: l._id, itemId: l.itemId, itemCode: l.itemCode, description: l.description,
          originalQty: l.qty, returnedQty: r.qty, remainingQty: round2(l.qty - r.qty),
          price: l.price ?? l.rate, vatPercent: l.vatPercent, discountPercent: l.discountPercent || 0,
        };
      }),
    };
  }

  // Validates a return before it is saved. Returns the items with returnOfLineId filled in.
  static async validate({ type, partyId, returnOf, items, date }, { session, excludeId } = {}) {
    const isReturn = type in ORIGINAL_TYPE;
    const cfg = await this.settings(session);

    if (!isReturn) {
      if (returnOf?.transactionId) throw new AppError("Only returns can reference an original document", 400, "NOT_A_RETURN");
      return { items, original: null };
    }
    if (!returnOf?.transactionId) {
      if (cfg.requireReturnLink) throw new AppError("Choose the document this return is against", 400, "RETURN_LINK_REQUIRED");
      return { items, original: null };
    }

    const q = Transaction.findById(returnOf.transactionId);
    const original = await (session ? q.session(session) : q);
    if (!original) throw new AppError("Original document not found", 404, "ORIGINAL_NOT_FOUND");
    if (original.type !== ORIGINAL_TYPE[type]) {
      throw new AppError(`A ${type.replace("_", " ")} must be against a ${ORIGINAL_TYPE[type].replace("_", " ")}`, 400, "WRONG_ORIGINAL_TYPE");
    }
    if (original.status !== "APPROVED") {
      throw new AppError("Returns can only be made against an approved document", 422, "ORIGINAL_NOT_APPROVED");
    }
    if (String(original.partyId) !== String(partyId)) {
      throw new AppError("The return must be for the same party as the original", 400, "PARTY_MISMATCH");
    }
    if (cfg.returnWindowDays > 0) {
      const days = (new Date(date || Date.now()) - new Date(original.date)) / 86400000;
      if (days > cfg.returnWindowDays) {
        throw new AppError(`Return window of ${cfg.returnWindowDays} days has passed`, 422, "RETURN_WINDOW_EXPIRED");
      }
    }

    const returned = await this.returnedByLine(original._id, { excludeId, session });
    const origLines = new Map(original.items.map((l) => [String(l._id), l]));
    const used = new Map(); // this document's own lines also count against each other

    const out = items.map((item, idx) => {
      let lineId = item.returnOfLineId ? String(item.returnOfLineId) : null;
      if (!lineId) {
        // No explicit line: accept it only when exactly one original line carries this item.
        const matches = original.items.filter((l) => String(l.itemId) === String(item.itemId));
        if (matches.length !== 1) {
          throw new AppError(`Line ${idx + 1} (${item.description}): say which original line it returns`, 400, "LINE_NOT_IN_ORIGINAL");
        }
        lineId = String(matches[0]._id);
      }
      const orig = origLines.get(lineId);
      if (!orig || String(orig.itemId) !== String(item.itemId)) {
        throw new AppError(`Line ${idx + 1} (${item.description}) is not on ${original.transactionNo}`, 400, "LINE_NOT_IN_ORIGINAL");
      }

      const before = returned.get(lineId) || { qty: 0, value: 0 };
      const sameDoc = used.get(lineId) || { qty: 0, value: 0 };
      const qty = Number(item.qty) || 0;
      const remaining = orig.qty - before.qty - sameDoc.qty;
      if (qty > remaining + EPS) {
        throw new AppError(
          `${item.description}: returning ${qty} but only ${round2(Math.max(remaining, 0))} of ${orig.qty} can still be returned against ${original.transactionNo}`,
          422,
          "OVER_RETURN"
        );
      }
      used.set(lineId, { qty: sameDoc.qty + qty, value: sameDoc.value });
      return { ...item, returnOfLineId: orig._id };
    });

    // Value cap, per line: what was invoiced (after discount, before VAT) cannot be exceeded.
    // Checked after pricing, so the caller passes priced items.
    const valueUsed = new Map();
    for (const item of out) {
      const k = String(item.returnOfLineId);
      const orig = origLines.get(k);
      const before = returned.get(k) || { qty: 0, value: 0 };
      const now = (valueUsed.get(k) || 0) + (Number(item.taxableAmount) || 0);
      valueUsed.set(k, now);
      if (item.taxableAmount !== undefined && before.value + now > (orig.taxableAmount ?? orig.lineTotal - (orig.vatAmount || 0)) + 0.01) {
        throw new AppError(`${item.description}: the value returned would exceed what was invoiced`, 422, "OVER_RETURN_VALUE");
      }
    }
    return { items: out, original };
  }
}

module.exports = ReturnService;
