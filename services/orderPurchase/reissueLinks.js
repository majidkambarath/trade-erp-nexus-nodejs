// Credit and re-issue keeps three documents together (EInvoiceService.reissue): the OLD invoice (priced before 18 Nov 2026, its discount taken
// off after VAT), the CREDIT NOTE that cancels it exactly, and the NEW invoice that replaces it with the discount shared over its lines. Each
// carries `reissue` (models/modules/transactionModel.js). The rules here are called from TransactionService at the moments that matter:
//   - the two paper documents cannot be turned into something else (their lines are fixed: the credit note mirrors the old invoice and neither
//     moves stock, so an added line would never leave stock);
//   - the new invoice is approved only after its credit note, and takes over what the credit note could not use on the old invoice (a paid
//     old invoice's payment follows the new one, so it does not read unpaid and nobody is reminded to pay it twice);
//   - an approved credit note is not undone under an approved new invoice;
//   - breaking the pair puts the documents back as they were (the old invoice and the credit note are e-invoiced like any other again),
//     except that an approved credit note still cancels the old invoice, so those two stay out of e-invoicing.
// No HTTP, no request: plain functions of the documents, inside the caller's transaction.
const Transaction = require("../../models/modules/transactionModel");
const AppError = require("../../utils/AppError");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const roleOf = (tx) => tx?.reissue?.role || null;
const paper = (tx) => ["credit", "invoice"].includes(roleOf(tx));
const read = (id, session, fields) => (id ? Transaction.findById(id).select(fields).session(session || null).lean() : null);

// what of a line decides what the document is: a change to any of these is a different document
const lineKey = (l) => [String(l.itemId?._id || l.itemId || ""), round2(l.qty), round2(l.price ?? l.rate), round2(l.discountPercent || 0), String(l.taxCodeId || "")].join("|");
const sameLines = (stored, sent) => stored.length === sent.length && stored.every((l, i) => lineKey(l) === lineKey(sent[i]));
const chargeKey = (c) => [String(c.code || ""), round2(c.amount)].join("|");
const sameCharges = (stored, sent) => {
  const a = (stored || []).filter((c) => Number(c.amount) > 0).map(chargeKey);
  const b = (sent || []).filter((c) => Number(c.amount) > 0).map(chargeKey);
  return a.length === b.length && a.every((k, i) => k === b[i]);
};
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// An edit of one of the two paper documents may change its words (notes, terms, LPO, serial no.) and nothing that prices it. The order form
// sends every field back on a save, so an unchanged value is simply dropped; a changed one is refused.
function assertEditable(transaction, data) {
  if (!paper(transaction)) return;
  const changed = [];
  if (Array.isArray(data.items)) { if (!sameLines(transaction.items || [], data.items)) changed.push("lines"); delete data.items; }
  if (data.charges !== undefined) { if (!sameCharges(transaction.charges, data.charges)) changed.push("charges"); delete data.charges; }
  if (data.discount !== undefined) { if (round2(data.discount) !== round2(transaction.discount)) changed.push("discount"); delete data.discount; }
  if (data.partyId !== undefined) { if (String(data.partyId) !== String(transaction.partyId)) changed.push("customer"); delete data.partyId; }
  if (data.date !== undefined) { if (day(data.date) !== day(transaction.date)) changed.push("date"); delete data.date; }
  for (const k of ["currency", "exchangeRate", "rateOverrideReason"]) if (data[k] !== undefined) { changed.push("currency"); delete data[k]; }
  if (changed.length) {
    const what = roleOf(transaction) === "credit" ? "This credit note cancels" : "This invoice replaces";
    throw new AppError(
      `${what} ${transaction.reissue.originalNo} exactly, so its ${[...new Set(changed)].join(", ")} cannot be changed. Delete both drafts and use Credit and re-issue again, or approve them and correct with an ordinary invoice or credit note.`,
      409, "REISSUE_DRAFT_LOCKED", { changed: [...new Set(changed)] }
    );
  }
}

// Before the new invoice is approved: its credit note must be approved first, or for a moment the customer would owe both invoices.
async function assertMayApprove(transaction, { session } = {}) {
  if (roleOf(transaction) !== "invoice") return;
  const credit = await read(transaction.reissue.creditNoteId, session, "status transactionNo");
  if (!credit || credit.status !== "APPROVED") {
    throw new AppError(`Approve credit note ${transaction.reissue.creditNoteNo} first: it cancels ${transaction.reissue.originalNo}, which this invoice replaces.`, 409, "REISSUE_CREDIT_FIRST");
  }
}

// The new invoice has just been approved (the document is saved by the caller afterwards, whose save works out what is still owed). What the
// credit note could not use on the old invoice (because the old one had been paid) is taken off this one.
async function settle(transaction, { session } = {}) {
  if (roleOf(transaction) !== "invoice") return 0;
  const credit = await read(transaction.reissue.creditNoteId, session, "totalAmount appliedToInvoice");
  if (!credit) return 0;
  const left = Math.max(0, round2(Number(credit.totalAmount) - Number(credit.appliedToInvoice || 0)));
  const open = Math.max(0, round2(Number(transaction.totalAmount) - Number(transaction.paidAmount || 0) - Number(transaction.creditedAmount || 0)));
  const take = round2(Math.min(left, open));
  transaction.creditedAmount = round2(Number(transaction.creditedAmount || 0) + take);
  // the save hook works out what is owed only when the total or the paid amount changes, so it is set here (a later receipt's save keeps it:
  // it reads total - paid - credited)
  transaction.outstandingAmount = round2(open - take);
  transaction.reissue.appliedCredit = take;
  transaction.markModified("reissue");
  return take;
}

// The approved new invoice is deleted or cancelled: what it took from the credit note is no longer taken (it is the customer's credit again).
function unsettle(transaction) {
  if (roleOf(transaction) !== "invoice" || !(transaction.reissue.appliedCredit > 0)) return 0;
  const give = round2(transaction.reissue.appliedCredit);
  transaction.creditedAmount = Math.max(0, round2(Number(transaction.creditedAmount || 0) - give));
  transaction.outstandingAmount = round2(Number(transaction.outstandingAmount || 0) + give);
  transaction.reissue.appliedCredit = 0;
  transaction.markModified("reissue");
  return give;
}

// An approved credit note is not undone (deleted or cancelled) while the invoice that replaces its invoice is approved: the customer would owe both.
async function assertMayUndoCredit(transaction, { session } = {}) {
  if (roleOf(transaction) !== "credit" || transaction.status !== "APPROVED") return;
  const invoice = await read(transaction.reissue.invoiceId, session, "status transactionNo");
  if (invoice?.status === "APPROVED") {
    throw new AppError(`${invoice.transactionNo} replaces ${transaction.reissue.originalNo} and is approved: undo it first, then this credit note.`, 409, "REISSUE_INVOICE_APPROVED");
  }
}

// One of the paper documents is gone for good (rejected, cancelled or deleted). The pair is broken:
//   - the credit note gone: nothing cancels the old invoice, so all three read as ordinary documents again;
//   - the new invoice gone while the credit note is APPROVED: the old invoice stays cancelled (it and its credit note are still not to be
//     e-invoiced), only the link to the replacement is dropped; with the credit note still a draft, all three read as ordinary again.
async function release(transaction, { session } = {}) {
  const role = roleOf(transaction);
  if (!paper(transaction)) return;
  const r = transaction.reissue;
  const opts = session ? { session } : {};
  const ids = [r.originalId, r.creditNoteId, r.invoiceId].filter(Boolean);
  if (role === "invoice") {
    const credit = await read(r.creditNoteId, session, "status");
    if (credit?.status === "APPROVED") {
      await Transaction.updateMany({ _id: { $in: [r.originalId, r.creditNoteId].filter(Boolean) } }, { $unset: { "reissue.invoiceId": "", "reissue.invoiceNo": "" } }, opts);
      await Transaction.updateOne({ _id: transaction._id }, { $unset: { reissue: "" } }, opts);
      return;
    }
  }
  await Transaction.updateMany({ _id: { $in: ids } }, { $unset: { reissue: "" } }, opts);
}

// Which of these document ids are the credit note of a re-issue (a ledger row's voucherId is its document's id), as strings. One read.
async function correctionsAmong(ids, session) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return new Set();
  const { CORRECTIONS } = require("../../utils/reissue");
  const found = await Transaction.find({ _id: { $in: list }, ...CORRECTIONS }).select("_id").session(session || null).lean();
  return new Set(found.map((d) => String(d._id)));
}

module.exports = { assertEditable, assertMayApprove, settle, unsettle, assertMayUndoCredit, release, paper, roleOf, correctionsAmong };
