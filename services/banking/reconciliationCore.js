const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const R = require("../../models/modules/banking/reconciliationModels");
const { groupFamily } = require("./cardService");
const ChequeService = require("./chequeService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { orgDay } = require("../../utils/documentExpiry");
const orgLocale = require("../../utils/orgLocale");
const { round2 } = require("../../utils/accounting");
const M = require("../../utils/bankMatching");

// What the reconciliation services share: finding the bank account, reading the books' entries on it
// in the shape the matching code wants, and writing a match that always adds up to the fils.

const { cents, fromCents } = M;
const toId = (v) => new mongoose.Types.ObjectId(String(v));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const dayStart = (day) => orgLocale.dayStart(day); // 00:00 on the organisation's wall clock
const dayEnd = (day) => orgLocale.endOfDay(day); // 23:59:59.999 there
const inSession = (query, session) => (session ? query.session(session) : query);

// The ledger account must sit under the Bank group: reconciling a cash or customer account is not a thing.
async function bankAccount(accountId, { req, session } = {}) {
  if (!mongoose.isValidObjectId(accountId)) throw new AppError("Choose a bank account", 400, "ACCOUNT_REQUIRED");
  const { ids } = await groupFamily("bank-account-group", req);
  const account = await inSession(LedgerAccount.findOne({ _id: accountId, groupId: { $in: ids } }).select("accountName accountCode isActive bank").lean(), session);
  if (!account) throw new AppError("That is not a bank account", 400, "NOT_A_BANK_ACCOUNT");
  return account;
}

async function getSetup(accountId, { req, session } = {}) {
  const { companyId } = getTenant(req);
  return inSession(R.BankReconSetup.findOne({ companyId, accountId }).lean(), session);
}

// One book entry as the matching code reads it. `v` is the voucher it came from, when there is one.
function entryRow(e, v) {
  const card = v?.paymentMode === "card" && v.paymentDetails?.cardId
    ? { cardId: v.paymentDetails.cardId, cardLabel: v.paymentDetails.cardLabel || "", feeBooked: round2(v.paymentDetails.cardFee || 0), gross: round2(v.totalAmount || 0) }
    : null;
  return {
    id: String(e._id), type: "ledger", ledgerEntryId: e._id, voucherId: e.voucherId, voucherNo: e.voucherNo, voucherType: e.voucherType,
    day: orgDay(e.date), amount: round2((e.debitAmount || 0) - (e.creditAmount || 0)),
    narration: e.narration || "", party: v?.partyName || "",
    reference: v?.paymentDetails?.reference || "",
    chequeNo: e.referenceType === "cheque" ? String(e.referenceNo || "") : String(v?.paymentDetails?.chequeDetails?.chequeNumber || ""),
    card, groupId: null,
  };
}

// A cheque that has not cleared is not in the bank ledger yet, but a statement line can be the proof
// it cleared, so it is offered as a candidate (matching clears it).
function chequeRow(c) {
  return {
    id: `cheque:${c._id}`, type: "cheque", chequeId: c._id, voucherId: c.voucherId, voucherNo: c.voucherNo, voucherType: "cheque",
    day: orgDay(c.chequeDate), amount: round2(c.direction === "receipt" ? c.amount : -c.amount),
    narration: `Cheque ${c.chequeNo} ${c.direction === "receipt" ? "received" : "issued"}${c.isPDC ? " (post-dated)" : ""}`,
    party: c.partyName || "", reference: "", chequeNo: c.chequeNo, card: null, groupId: null, pending: true,
  };
}

// The books' entries on the account that the reconciliation covers (from the start day, plus the
// entries listed as outstanding at the start), with the match each belongs to.
async function loadBook(accountId, setup, { req, session, upTo } = {}) {
  const { companyId } = getTenant(req);
  const acc = toId(accountId);
  const filter = { accountId: acc, isReversed: { $ne: true } };
  if (upTo) filter.date = { $lte: dayEnd(upTo) };
  if (setup) filter.$or = [{ date: { $gte: dayStart(setup.startDay) } }, { _id: { $in: setup.outstandingEntryIds || [] } }];
  const [docs, matches] = await Promise.all([
    inSession(LedgerEntry.find(filter).select("voucherId voucherNo voucherType date debitAmount creditAmount narration referenceType referenceNo").sort({ date: 1, _id: 1 }).lean(), session),
    inSession(R.BankMatch.find({ companyId, accountId: acc, status: "active" }).select("entries.ledgerEntryId reconciliationId").lean(), session),
  ]);
  const groupOf = new Map();
  for (const m of matches) for (const e of m.entries) if (e.ledgerEntryId) groupOf.set(String(e.ledgerEntryId), String(m._id));
  const ids = [...new Set(docs.map((d) => String(d.voucherId)))];
  const vouchers = ids.length
    ? await inSession(Voucher.find({ _id: { $in: ids } }).select("partyName paymentMode totalAmount paymentDetails.reference paymentDetails.cardId paymentDetails.cardLabel paymentDetails.cardFee paymentDetails.chequeDetails.chequeNumber").lean(), session)
    : [];
  const byId = new Map(vouchers.map((v) => [String(v._id), v]));
  const entries = docs.map((d) => ({ ...entryRow(d, byId.get(String(d.voucherId))), groupId: groupOf.get(String(d._id)) || null }));
  return { entries, matches };
}

async function loadPendingCheques(accountId, { req, session } = {}) {
  const { companyId } = getTenant(req);
  const cheques = await inSession(Cheque.find({ companyId, bankAccountId: accountId, status: "pending" }).sort({ chequeDate: 1 }).lean(), session);
  return cheques.map(chequeRow);
}

// The ledger balance of the account at the end of a day (debit minus credit; the books' side).
async function balanceAt(accountId, day, { session } = {}) {
  const [row] = await inSession(
    LedgerEntry.aggregate([
      { $match: { accountId: toId(accountId), isReversed: { $ne: true }, date: { $lte: dayEnd(day) } } },
      { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
    ]),
    session
  );
  return round2((row?.d || 0) - (row?.c || 0));
}

const refOf = (e) => ({
  type: "ledger", ledgerEntryId: e.ledgerEntryId, voucherId: e.voucherId, voucherNo: e.voucherNo, voucherType: e.voucherType,
  chequeId: e.chequeId || null, day: e.day, amount: e.amount, narration: String(e.narration || "").slice(0, 200), clearedByMatch: Boolean(e.clearedByMatch),
});

// Turns what a person picked (ledger entries, pending cheques) into book entries, inside the
// caller's transaction. A pending cheque is cleared on the day of the statement line: the statement
// is the proof it cleared.
async function resolveEntryRefs(refs, { accountId, clearOn, session, req, adminId }) {
  const { companyId } = getTenant(req);
  const out = [];
  for (const ref of refs) {
    if (ref.type === "cheque") {
      const cheque = await inSession(Cheque.findOne({ _id: ref.chequeId, companyId, bankAccountId: accountId, status: "pending" }).lean(), session);
      if (!cheque) throw new AppError("That cheque is no longer pending", 409, "CHEQUE_NOT_PENDING");
      await ChequeService.clear(cheque._id, { clearedOn: clearOn, note: "Cleared from the bank statement" }, req, adminId, session);
      const e = await inSession(LedgerEntry.findOne({ accountId, referenceType: "cheque", referenceId: cheque._id, isReversed: { $ne: true } }).lean(), session);
      if (!e) throw new AppError("The cheque cleared but its bank entry was not found", 500, "CLEARANCE_NOT_FOUND");
      out.push({ ...entryRow(e, null), chequeId: cheque._id, clearedByMatch: true });
    } else {
      if (!mongoose.isValidObjectId(ref.ledgerEntryId)) throw new AppError("Choose valid book entries", 400, "INVALID_ENTRY");
      const e = await inSession(LedgerEntry.findOne({ _id: ref.ledgerEntryId, accountId, isReversed: { $ne: true } }).lean(), session);
      if (!e) throw new AppError("A book entry in this match no longer exists", 409, "ENTRY_NOT_FOUND");
      if (await inSession(R.BankMatch.exists({ companyId, status: "active", "entries.ledgerEntryId": e._id }), session)) {
        throw new AppError("A book entry in this match is already matched to another statement line", 409, "ALREADY_MATCHED");
      }
      const v = await inSession(Voucher.findById(e.voucherId).select("partyName paymentMode totalAmount paymentDetails").lean(), session);
      out.push(entryRow(e, v));
    }
  }
  return out;
}

// Writes one match: lines and entries that add up exactly (a difference is posted as an entry of
// its own, never carried inside a match). Inside the caller's transaction.
async function createMatch({ accountId, lines, entries, kind = "match", method = "manual", note = "", by = null, createdVouchers = [], session, req }) {
  const { companyId, branchId } = getTenant(req);
  if (!lines.length) throw new AppError("Choose the statement lines", 400, "LINES_REQUIRED");
  const lineSum = lines.reduce((t, l) => t + cents(l.amount), 0);
  const entrySum = entries.reduce((t, e) => t + cents(e.amount), 0);
  // lines with nothing to match them to are only allowed when they cancel each other out
  if (!entries.length && !(lines.length >= 2 && lineSum === 0)) {
    throw new AppError("Choose the book entries these lines belong to", 400, "ENTRIES_REQUIRED");
  }
  if (lineSum !== entrySum) {
    throw new AppError(
      `The statement lines add up to ${fromCents(lineSum).toFixed(2)} but the book entries add up to ${fromCents(entrySum).toFixed(2)}`,
      409, "AMOUNTS_DIFFER", { difference: fromCents(lineSum - entrySum) }
    );
  }
  let match;
  try {
    [match] = await R.BankMatch.create([{
      companyId, branchId, accountId, kind: entries.length ? kind : "offset", method, lineIds: lines.map((l) => l._id),
      entries: entries.map(refOf), createdVouchers, note, matchedBy: by,
    }], { session });
  } catch (err) {
    if (err.code === 11000) throw new AppError("A statement line or book entry in this match is already matched", 409, "ALREADY_MATCHED");
    throw err;
  }
  const done = await R.BankStatementLine.updateMany({ _id: { $in: lines.map((l) => l._id) }, state: "open" }, { $set: { state: "matched", matchId: match._id } }, { session });
  if (done.modifiedCount !== lines.length) throw new AppError("A statement line changed while it was being matched. Reload and try again.", 409, "LINE_CHANGED");
  return match;
}

// The bank-side entry a voucher just posted to this account.
async function bankEntryOf(voucherId, accountId, { session }) {
  const entries = await LedgerEntry.find({ voucherId, accountId, isReversed: { $ne: true } }).session(session).lean();
  if (entries.length !== 1) throw new AppError(`Expected one bank entry for the voucher, found ${entries.length}`, 500, "BANK_ENTRY_NOT_FOUND");
  const v = await Voucher.findById(voucherId).select("partyName paymentMode totalAmount paymentDetails").session(session).lean();
  return entryRow(entries[0], v);
}

module.exports = {
  toId, isDay, dayStart, dayEnd, inSession, cents, fromCents,
  bankAccount, getSetup, entryRow, chequeRow, loadBook, loadPendingCheques, balanceAt, resolveEntryRefs, createMatch, bankEntryOf, refOf,
};
