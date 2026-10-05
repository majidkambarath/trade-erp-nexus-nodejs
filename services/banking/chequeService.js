const mongoose = require("mongoose");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const { Voucher, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("../financial/accountConfigService");
const FinancialService = require("../financial/financialService");
const FiscalYearService = require("../core/fiscalYearService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdmin = (v) => (mongoose.isValidObjectId(v) ? v : SYSTEM_USER);
const day = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The cheque register. A cheque is recorded when its receipt or payment voucher is saved, waits
// in a post-dated-cheques account, and moves to the bank account only when it clears.
//
//   pending --clear--> cleared --bounce--> bounced
//   pending --bounce--> bounced        (the voucher's effects are reversed: the party owes again)
//   pending --cancel--> cancelled      (same reversal; the cheque is withdrawn or replaced)
class ChequeService {
  // Called inside the voucher's transaction.
  static async register({ voucher, cheque, direction, createdBy, session, req }) {
    const { companyId } = getTenant(req);
    // The same cheque cannot be recorded twice: a customer's cheque is identified by its number
    // and bank, one of ours by its number and the account it is drawn on.
    const key = direction === "receipt"
      ? (cheque.drawnOnBankId ? { drawnOnBankId: cheque.drawnOnBankId } : { drawnOnBankName: new RegExp(`^${escapeRe(cheque.drawnOnBankName)}$`, "i") })
      : { bankAccountId: cheque.bankAccountId };
    const dup = await Cheque.findOne({ companyId, direction, chequeNo: cheque.chequeNo, status: { $in: ["pending", "cleared"] }, voucherId: { $ne: voucher._id }, ...key }).session(session);
    if (dup) throw new AppError(`Cheque ${cheque.chequeNo} is already recorded on ${dup.voucherNo}`, 409, "DUPLICATE_CHEQUE");

    const [row] = await Cheque.create(
      [{
        companyId, direction, voucherId: voucher._id, voucherNo: voucher.voucherNo, voucherDate: voucher.date,
        partyType: voucher.partyType, partyId: voucher.partyId, partyName: voucher.partyName,
        chequeNo: cheque.chequeNo, chequeDate: cheque.chequeDate, amount: voucher.totalAmount,
        // a foreign-currency cheque: `amount` stays the AED value; this is what it was written for
        ...(voucher.foreignAmount > 0 ? { currency: voucher.currency, foreignAmount: voucher.foreignAmount, exchangeRate: voucher.exchangeRate } : {}),
        drawnOnBankId: cheque.drawnOnBankId, drawnOnBankName: cheque.drawnOnBankName,
        bankAccountId: cheque.bankAccountId, isPDC: cheque.isPDC,
        history: [{ status: "pending", by: createdBy ? String(createdBy) : null, note: cheque.isPDC ? "Post-dated cheque recorded" : "Cheque recorded" }],
        createdBy: asAdmin(createdBy),
      }],
      { session }
    );
    return row;
  }

  static async list(req, { status, direction, q, from, to, page = 1, limit = 50 } = {}) {
    const { companyId } = getTenant(req);
    const filter = { companyId };
    if (status) filter.status = status;
    if (direction) filter.direction = direction;
    if (from || to) filter.chequeDate = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
    if (q) {
      const re = new RegExp(escapeRe(q), "i");
      filter.$or = [{ chequeNo: re }, { partyName: re }, { voucherNo: re }, { drawnOnBankName: re }];
    }
    const [rows, total, pending] = await Promise.all([
      Cheque.find(filter).populate("bankAccountId", "accountName accountCode").sort({ chequeDate: 1, createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
      Cheque.countDocuments(filter),
      Cheque.aggregate([{ $match: { companyId, status: "pending" } }, { $group: { _id: "$direction", amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    ]);
    const today = day(new Date());
    return {
      rows: rows.map((r) => ({
        ...r,
        bankAccountName: r.bankAccountId?.accountName || "",
        bankAccountId: r.bankAccountId?._id || r.bankAccountId,
        // pending and dated in the future: not yet presentable
        matured: day(r.chequeDate) <= today,
      })),
      total,
      summary: {
        receivable: pending.find((p) => p._id === "receipt") || { amount: 0, count: 0 },
        payable: pending.find((p) => p._id === "payment") || { amount: 0, count: 0 },
      },
    };
  }

  static async get(id, req, session) {
    const { companyId } = getTenant(req);
    const q = Cheque.findOne({ _id: id, companyId });
    const cheque = await (session ? q.session(session) : q);
    if (!cheque) throw new AppError("Cheque not found", 404);
    return cheque;
  }

  // Moves the amount from the post-dated cheques account into the bank account.
  static async clear(id, { clearedOn, note } = {}, req, adminId) {
    const on = clearedOn ? new Date(clearedOn) : new Date();
    if (Number.isNaN(on.getTime())) throw new AppError("Enter a valid clearing date", 400, "INVALID_DATE");
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const cheque = await this.get(id, req, session);
        if (cheque.status !== "pending") throw new AppError(`This cheque is already ${cheque.status}`, 409, "CHEQUE_NOT_PENDING");
        if (day(on) < day(cheque.chequeDate)) {
          throw new AppError(`This cheque is dated ${cheque.chequeDate.toISOString().slice(0, 10)} and cannot clear before then`, 409, "CHEQUE_NOT_MATURE");
        }
        await FiscalYearService.assertPostingAllowed(on, { session });
        const pdcId = await AccountConfigService.resolveAccount(cheque.direction === "receipt" ? "pdc-receipt" : "pdc-issue", { session });
        const { LedgerAccount } = require("../../models/modules/financial/financialModels");
        const [pdc, bank] = await Promise.all([
          LedgerAccount.findById(pdcId).select("accountName accountCode").session(session).lean(),
          LedgerAccount.findById(cheque.bankAccountId).select("accountName accountCode").session(session).lean(),
        ]);
        const base = {
          voucherId: cheque.voucherId, voucherNo: cheque.voucherNo, voucherType: "cheque_clearance", date: on,
          narration: `Cheque ${cheque.chequeNo} cleared`, partyId: cheque.partyId, partyType: cheque.partyType,
          referenceType: "cheque", referenceId: cheque._id, referenceNo: cheque.chequeNo, createdBy: asAdmin(adminId),
          // a foreign-currency cheque clears at the AED value it was received at (the bank's own
          // rate on the day, and the exchange difference it causes, is phase 2)
          ...(cheque.foreignAmount > 0 ? { currency: cheque.currency, exchangeRate: cheque.exchangeRate, amountForeign: cheque.foreignAmount } : {}),
        };
        const toBank = cheque.direction === "receipt";
        const docs = [
          { ...base, accountId: bank._id, accountName: bank.accountName, accountCode: bank.accountCode, debitAmount: toBank ? cheque.amount : 0, creditAmount: toBank ? 0 : cheque.amount },
          { ...base, accountId: pdc._id, accountName: pdc.accountName, accountCode: pdc.accountCode, debitAmount: toBank ? 0 : cheque.amount, creditAmount: toBank ? cheque.amount : 0 },
        ];
        await LedgerEntry.insertMany(docs, { session });
        await FinancialService.updateAccountBalances(docs, session);
        cheque.status = "cleared";
        cheque.clearedOn = on;
        cheque.history.push({ status: "cleared", at: new Date(), by: adminId ? String(adminId) : null, note: note || "" });
        await cheque.save({ session });
        result = cheque.toObject();
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  static bounce(id, data, req, adminId) {
    return this.void(id, "bounced", data, req, adminId);
  }
  static cancel(id, data, req, adminId) {
    return this.void(id, "cancelled", data, req, adminId);
  }

  // The cheque did not honour (or was withdrawn): the voucher is reversed as if it had not been
  // taken, so the invoices it settled are open again, and the voucher is marked.
  static async void(id, to, { reason, on } = {}, req, adminId) {
    if (to === "bounced" && !String(reason || "").trim()) throw new AppError("Say why the cheque bounced", 400, "REASON_REQUIRED");
    const when = on ? new Date(on) : new Date();
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const cheque = await this.get(id, req, session);
        const allowed = to === "bounced" ? ["pending", "cleared"] : ["pending"];
        if (!allowed.includes(cheque.status)) {
          throw new AppError(`A ${cheque.status} cheque cannot be marked ${to}`, 409, "CHEQUE_NOT_PENDING");
        }
        const voucher = await Voucher.findById(cheque.voucherId).session(session);
        if (!voucher) throw new AppError("The voucher for this cheque no longer exists", 404);
        await FiscalYearService.assertPostingAllowed(voucher.date, { session });
        await FiscalYearService.assertPostingAllowed(when, { session });
        if (voucher.status === "approved") await FinancialService.reverseVoucherEffects(voucher, session);
        voucher.status = to === "bounced" ? "bounced" : "cancelled";
        voucher.updatedBy = asAdmin(adminId);
        await voucher.save({ session });
        cheque.status = to;
        if (to === "bounced") cheque.bouncedOn = when;
        cheque.reason = reason || "";
        cheque.history.push({ status: to, at: new Date(), by: adminId ? String(adminId) : null, note: reason || "" });
        await cheque.save({ session });
        result = cheque.toObject();
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // A voucher is being deleted or re-saved. A cheque that has not cleared is simply withdrawn
  // (the caller reverses the ledger); one that has cleared may only be deleted, not edited.
  static async onVoucherRemoved(voucher, { session, req, adminId, forEdit = false }) {
    const { companyId } = getTenant(req);
    const cheques = await Cheque.find({ companyId, voucherId: voucher._id, status: { $in: ["pending", "cleared"] } }).session(session);
    for (const c of cheques) {
      if (forEdit && c.status === "cleared") {
        throw new AppError("This cheque has cleared, so its voucher cannot be edited. Mark the cheque bounced first.", 409, "CHEQUE_CLEARED");
      }
      c.status = "cancelled";
      c.reason = forEdit ? "Voucher edited" : "Voucher deleted";
      c.history.push({ status: "cancelled", at: new Date(), by: adminId ? String(adminId) : null, note: c.reason });
      await c.save({ session });
    }
    return cheques.length;
  }
}

module.exports = ChequeService;
