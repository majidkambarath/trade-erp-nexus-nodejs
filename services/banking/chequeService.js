const mongoose = require("mongoose");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const { Voucher, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("../financial/accountConfigService");
const FinancialService = require("../financial/financialService");
const FiscalYearService = require("../core/fiscalYearService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const rules = require("../../utils/chequeRules");
const dishonourRules = require("../../utils/chequeDishonour");

const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdmin = (v) => (mongoose.isValidObjectId(v) ? v : SYSTEM_USER);
const day = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The cheque register. A cheque is recorded when its receipt or payment voucher is saved, waits
// in a post-dated-cheques account, and moves to the bank account only when it clears.
//
//   pending --deposit--> deposited --clear--> cleared --bounce--> bounced
//   pending --clear--> cleared                  (straight to the bank, e.g. matched from a statement)
//   pending --hold--> hold --resume--> pending  (kept in the drawer on purpose)
//   pending, hold, deposited --bounce--> bounced (the voucher's effects are reversed: the party owes again)
//   pending, hold --cancel--> cancelled          (same reversal; the cheque is withdrawn or replaced)
// The whole table, and every refusal, is utils/chequeRules.js. Deposit, hold and resume POST NOTHING.
class ChequeService {
  // Called inside the voucher's transaction.
  static async register({ voucher, cheque, direction, createdBy, session, req }) {
    const { companyId } = getTenant(req);
    // The same cheque cannot be recorded twice: a customer's cheque is identified by its number
    // and bank, one of ours by its number and the account it is drawn on.
    const key = direction === "receipt"
      ? (cheque.drawnOnBankId ? { drawnOnBankId: cheque.drawnOnBankId } : { drawnOnBankName: new RegExp(`^${escapeRe(cheque.drawnOnBankName)}$`, "i") })
      : { bankAccountId: cheque.bankAccountId };
    const dup = await Cheque.findOne({ companyId, direction, chequeNo: cheque.chequeNo, status: { $in: rules.OPEN }, voucherId: { $ne: voucher._id }, ...key }).session(session);
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
      Cheque.aggregate([{ $match: { companyId, status: { $in: rules.LIVE } } }, { $group: { _id: "$direction", amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
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

  // The bank will not take a cheque before the date written on it.
  static assertMature(cheque, on, verb) {
    if (day(on) < day(cheque.chequeDate)) {
      throw new AppError(`This cheque is dated ${cheque.chequeDate.toISOString().slice(0, 10)} and cannot ${verb} before then`, 409, "CHEQUE_NOT_MATURE");
    }
  }
  static async get(id, req, session) {
    const { companyId } = getTenant(req);
    const q = Cheque.findOne({ _id: id, companyId });
    const cheque = await (session ? q.session(session) : q);
    if (!cheque) throw new AppError("Cheque not found", 404);
    return cheque;
  }

  // Moves the amount from the post-dated cheques account into the bank account. Pass a session as
  // the fifth argument to clear INSIDE the caller's transaction (matching a bank statement line to
  // a cheque clears it and records the match together); the caller then does the committing.
  static async clear(id, { clearedOn, note } = {}, req, adminId, outerSession) {
    const on = clearedOn ? new Date(clearedOn) : new Date();
    if (Number.isNaN(on.getTime())) throw new AppError("Enter a valid clearing date", 400, "INVALID_DATE");
    const apply = async (session) => {
        const cheque = await this.get(id, req, session);
        const step = rules.canTransition(cheque.status, "clear");
        if (!step.ok) throw new AppError(step.message, 409, step.code);
        this.assertMature(cheque, on, "clear");
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
        return cheque.toObject();
    };
    if (outerSession) return apply(outerSession);
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await apply(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // A change of state that posts nothing (deposit, hold, resume). One conditional update: the cheque is moved only if it
  // is still in the state it was read in, so two people pressing at once cannot both win. No transaction is needed - it is
  // a single document - and no period lock either: nothing is posted, so a cheque may be deposited in a closed month.
  static async moveStatus(id, action, { set = {}, unset = {}, note = "", check } = {}, req, adminId) {
    const cheque = await this.get(id, req);
    const step = rules.canTransition(cheque.status, action);
    if (!step.ok) throw new AppError(step.message, 409, step.code);
    if (check) check(cheque);
    const { companyId } = getTenant(req);
    const update = { $set: { status: step.to, ...set }, $push: { history: { status: step.to, at: new Date(), by: adminId ? String(adminId) : null, note } } };
    if (Object.keys(unset).length) update.$unset = unset;
    const moved = await Cheque.findOneAndUpdate({ _id: cheque._id, companyId, status: cheque.status }, update, { new: true });
    if (!moved) throw new AppError("This cheque was changed by someone else a moment ago. Open it again and try once more.", 409, "CHEQUE_CHANGED");
    return moved.toObject();
  }

  static async deposit(id, { depositedOn, slipNo, note } = {}, req, adminId) {
    const on = depositedOn ? new Date(depositedOn) : new Date();
    if (Number.isNaN(on.getTime())) throw new AppError("Enter a valid deposit date", 400, "INVALID_DATE");
    const slip = String(slipNo || "").trim();
    if (slip.length > 40) throw new AppError("The deposit slip number can be at most 40 characters", 400, "INVALID_SLIP");
    return this.moveStatus(id, "deposit", {
      set: { presentedOn: on, depositSlipNo: slip },
      note: String(note || "").trim() || (slip ? `Deposited at the bank, slip ${slip}` : "Deposited at the bank"),
      check: (c) => this.assertMature(c, on, "be deposited"),
    }, req, adminId);
  }

  static async hold(id, { reason, until } = {}, req, adminId) {
    const why = String(reason || "").trim();
    if (!why) throw new AppError("Say why the cheque is being held", 400, "REASON_REQUIRED");
    if (why.length > 250) throw new AppError("The reason can be at most 250 characters", 400, "REASON_TOO_LONG");
    let holdUntil = null;
    if (until) {
      holdUntil = new Date(until);
      if (Number.isNaN(holdUntil.getTime())) throw new AppError("Enter a valid date to hold the cheque until", 400, "INVALID_DATE");
    }
    return this.moveStatus(id, "hold", { set: { holdReason: why, holdUntil }, note: why }, req, adminId);
  }

  static async resume(id, { note } = {}, req, adminId) {
    return this.moveStatus(id, "resume", { set: { holdReason: "", holdUntil: null }, note: String(note || "").trim() || "Taken off hold" }, req, adminId);
  }
  // Several cheques at once (a business with 200 post-dated cheques cannot act one at a time). ONE TRANSACTION PER CHEQUE,
  // never one for all: a bad cheque must not undo the good ones, and 200 clears in one transaction would risk write
  // conflicts. The reply is 200 even when some fail; each failure carries its own code. Bounce is not offered in bulk -
  // it needs a reason and a return memo for each cheque.
  static async bulk(action, ids, data = {}, req, adminId) {
    if (!rules.BULK_ACTIONS.includes(action)) throw new AppError(`Cheques can be done in bulk by: ${rules.BULK_ACTIONS.join(", ")}`, 400, "INVALID_ACTION");
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (!list.length) throw new AppError("Choose at least one cheque", 400, "NO_CHEQUES");
    if (list.length > rules.MAX_BULK) throw new AppError(`At most ${rules.MAX_BULK} cheques at a time`, 400, "BULK_TOO_LARGE");
    const run = {
      deposit: (id) => this.deposit(id, { depositedOn: data.on, slipNo: data.slipNo, note: data.note }, req, adminId),
      clear: (id) => this.clear(id, { clearedOn: data.on, note: data.note }, req, adminId),
      hold: (id) => this.hold(id, { reason: data.reason, until: data.until }, req, adminId),
      resume: (id) => this.resume(id, { note: data.note }, req, adminId),
    }[action];
    const successful = [];
    const failed = [];
    for (const id of list) {
      try {
        if (!mongoose.isValidObjectId(id)) throw new AppError("Not a cheque id", 400, "INVALID_ID");
        const done = await run(id);
        successful.push({ id, chequeNo: done.chequeNo });
      } catch (err) {
        failed.push({ id, code: err.code || "ERROR", message: err.message });
      }
    }
    return { action, successful, failed };
  }
  static bounce(id, data, req, adminId) {
    return this.void(id, "bounced", data, req, adminId);
  }
  static cancel(id, data, req, adminId) {
    return this.void(id, "cancelled", data, req, adminId);
  }
  // Handed back to the party before it was presented. (Not named "return": a reserved word is a poor method name.)
  static giveBack(id, data, req, adminId) {
    return this.void(id, "returned", data, req, adminId);
  }

  // The posting-map account a bank charge goes to. A company set up before the key existed has it unmapped; the defaults
  // are added once and we retry. That top-up commits on its OWN, so this runs before the transaction opens, never inside.
  static async bankChargesAccount(req) {
    const AccountConfigService = require("../financial/accountConfigService");
    try {
      return await AccountConfigService.resolveAccount("bank-charges");
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      await require("../financial/defaultChartService").provision(req);
      return AccountConfigService.resolveAccount("bank-charges");
    }
  }

  // The bank took a fee for sending the cheque back, and maybe the customer is to be charged for it. Both are ordinary
  // vouchers posted through the ordinary code (so the ledger, the VAT return and the audit trail see them like any other),
  // INSIDE the bounce's transaction: a bounce recorded without its fee is worse than one that refuses and says why.
  static async postDishonourCharges({ cheque, dishonour, feeAccountId, when, session, req, adminId }) {
    const out = {};
    const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const asked = async (data) => {
      try {
        return await FinancialService.createVoucher(data, adminId, session, { req });
      } catch (err) {
        // A person over their approval limit cannot leave this waiting for an approver (it is inside a transaction).
        if (err.code === "APPROVAL_LIMIT_EXCEEDED") err.message = `The cheque was not marked bounced, because its charge needs an approver: ${err.message}`;
        throw err;
      }
    };
    const { bankCharge, recharge } = dishonour;
    if (bankCharge) {
      let net = bankCharge.amount;
      let tax = {};
      if (bankCharge.taxCodeId) {
        const TaxCode = require("../../models/modules/financial/taxCodeModel");
        const code = await TaxCode.findOne({ _id: bankCharge.taxCodeId, isActive: true }).session(session).lean();
        if (!code) throw new AppError("Tax code not found or inactive", 400, "INVALID_TAX_CODE");
        const rate = require("../financial/taxCodeService").rateOn(code, when);
        const split = require("../../utils/bankStatement").splitGross(bankCharge.amount, rate);
        net = split.net;
        tax = rate > 0 ? { taxCodeId: code._id, vatAmount: split.vat } : { taxCodeId: code._id };
      }
      const v = await asked({
        voucherType: "expense", ledgerBased: true, date: when, expenseAccountId: feeAccountId, amount: net, ...tax,
        description: `Returned cheque ${cheque.chequeNo} - bank charge`, narration: `Cheque ${cheque.chequeNo} (${cheque.voucherNo}) returned by the bank`,
        paymentMode: "bank", paymentDetails: { accountId: cheque.bankAccountId, reference: `Cheque ${cheque.chequeNo}` },
      });
      out.expenseVoucherId = v._id;
      out.expenseVoucherNo = v.voucherNo;
      out.amount = money(bankCharge.amount);
    }
    if (recharge) {
      const v = await asked({
        voucherType: "debit_note", ledgerBased: true, date: when, partyId: cheque.partyId, partyType: "Customer",
        lines: [{ accountId: recharge.accountId, amount: recharge.amount, ...(recharge.taxCodeId ? { taxCodeId: recharge.taxCodeId } : {}), description: recharge.description || `Charge for returned cheque ${cheque.chequeNo}` }],
        narration: `Charge for returned cheque ${cheque.chequeNo} (${cheque.voucherNo})`,
      });
      out.rechargeVoucherId = v._id;
      out.rechargeVoucherNo = v.voucherNo;
      out.rechargeAmount = money(recharge.amount);
    }
    return out;
  }

  // The cheque did not honour, was handed back, or was withdrawn: the voucher is reversed as if it had not been taken, so
  // the invoices it settled are open again, and the voucher is marked. `to` is bounced | returned | cancelled.
  //   bounced   the bank sent it back: a reason (words or the list), optionally the bank's memo, the part it paid, and
  //             the bank's charge and what to charge the customer - those post inside this same transaction
  //   returned  handed back to the party unpresented: a reason is all it needs
  //   cancelled withdrawn or replaced
  // The voucher reads "bounced" or "cancelled" - no new voucher status: a returned cheque's voucher is cancelled.
  static async void(id, to, input = {}, req, adminId) {
    const action = { bounced: "bounce", returned: "return", cancelled: "cancel" }[to];
    const when = input.on ? new Date(input.on) : new Date();
    if (Number.isNaN(when.getTime())) throw new AppError("Enter a valid date", 400, "INVALID_DATE");

    // What was asked for is judged before anything is opened. A cheque's amount, direction and party never change, so
    // this read is safe to use for that; its STATE is read again inside the transaction.
    const peek = await this.get(id, req);
    let dishonour;
    if (to === "bounced") {
      dishonour = dishonourRules.normaliseBounce(input, { amount: peek.amount, direction: peek.direction, partyIsCustomer: peek.partyType === "Customer", now: new Date() });
    } else if (to === "returned") {
      dishonour = dishonourRules.normaliseReturn(input);
    } else {
      dishonour = { ok: true, value: { reason: String(input.reason || "").trim().slice(0, 250) } };
    }
    if (!dishonour.ok) throw new AppError(dishonour.message, dishonour.status || 400, dishonour.code);
    const d = dishonour.value;
    const feeAccountId = d.bankCharge ? await this.bankChargesAccount(req) : null;

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const cheque = await this.get(id, req, session);
        const step = rules.canTransition(cheque.status, action);
        if (!step.ok) throw new AppError(step.message, 409, step.code);
        const voucher = await Voucher.findById(cheque.voucherId).session(session);
        if (!voucher) throw new AppError("The voucher for this cheque no longer exists", 404);
        await FiscalYearService.assertPostingAllowed(voucher.date, { session });
        await FiscalYearService.assertPostingAllowed(when, { session });
        if (voucher.status === "approved") await FinancialService.reverseVoucherEffects(voucher, session);
        voucher.status = to === "bounced" ? "bounced" : "cancelled";
        voucher.updatedBy = asAdmin(adminId);
        await voucher.save({ session });
        cheque.status = to;
        if (to === "bounced") {
          cheque.bouncedOn = when;
          cheque.returnMemo = d.returnMemo;
          if (d.certificateRef) cheque.certificateRef = d.certificateRef;
          if (d.partialPayment) cheque.partialPayment = d.partialPayment;
          if (d.bankCharge || d.recharge) cheque.charges = await this.postDishonourCharges({ cheque, dishonour: d, feeAccountId, when, session, req, adminId });
        }
        if (to === "returned") cheque.returnedOn = when;
        cheque.reason = d.reason || "";
        cheque.history.push({ status: to, at: new Date(), by: adminId ? String(adminId) : null, note: d.reason || "" });
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
    const cheques = await Cheque.find({ companyId, voucherId: voucher._id, status: { $in: rules.OPEN } }).session(session);
    for (const c of cheques) {
      // One already at the bank is not ours to cancel: editing or deleting its voucher would orphan it.
      if (c.status === "deposited") {
        throw new AppError("This cheque has been deposited at the bank. Wait for it to clear, or mark it bounced if it comes back, before changing its voucher.", 409, "CHEQUE_WITH_BANK");
      }
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
