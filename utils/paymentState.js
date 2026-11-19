// Whether an invoice has been paid, read from its amounts, and the figures the invoice pages' cards show. Pure: no Mongoose, no clock
// but the `now` you pass in.
//
// This is the SERVER twin of trade erp/src/lib/paymentStatus.js (paymentStatus, termDays, dueDateOf, isPastDue): the pages used to
// work these out in the browser over a whole period; now the server filters and counts, so the rule lives here too. Keep the two in
// step. `Transaction.status` is never a payment state (see CLAUDE.md "Never overwrite Transaction.status"): it is derived here.

const POSTED = new Set(["APPROVED", "INVOICED", "PAID", "PARTIAL", "UNPAID"]);
const LEGACY_WORD = { PAID: "PAID", PARTIAL: "PARTIAL", UNPAID: "UNPAID" };
const TOLERANCE = 0.005;
const DAY = 86400000;

const amountOf = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));

function paymentStatus(doc) {
  if (!doc) return null;
  const status = String(doc.status ?? "").trim().toUpperCase();
  if (!POSTED.has(status)) return null;
  const total = amountOf(doc.totalAmount);
  let paid = amountOf(doc.paidAmount);
  let outstanding = amountOf(doc.outstandingAmount);
  if (Number.isNaN(paid) && Number.isNaN(outstanding)) {
    const key = LEGACY_WORD[status];
    return key ? { key, total: Number.isNaN(total) ? null : total, paid: null, outstanding: null } : null;
  }
  if (Number.isNaN(total) || total <= TOLERANCE) return null;
  if (Number.isNaN(outstanding)) outstanding = total - paid;
  if (Number.isNaN(paid)) paid = total - outstanding;
  const creditedRaw = amountOf(doc.creditedAmount);
  const credited = Number.isNaN(creditedRaw) ? 0 : Math.max(0, creditedRaw);
  const key = outstanding <= TOLERANCE ? "PAID" : paid > TOLERANCE || credited > TOLERANCE ? "PARTIAL" : "UNPAID";
  return { key, total, paid: Math.max(0, paid), credited, outstanding: Math.max(0, outstanding) };
}

const termDays = (terms) => {
  const m = /(\d+)/.exec(String(terms || ""));
  return m ? Number(m[1]) : 0;
};

function dueDateOf(doc) {
  if (!doc) return null;
  if (doc.dueDate) return new Date(doc.dueDate);
  if (!doc.date) return null;
  return new Date(new Date(doc.date).getTime() + termDays(doc.paymentTerms) * DAY);
}

function isPastDue(doc, now = Date.now()) {
  const p = paymentStatus(doc);
  const due = dueDateOf(doc);
  return Boolean(p && p.key !== "PAID" && due && Math.floor((now - due.getTime()) / DAY) > 0);
}

/**
 * The cards of an invoice list, for the documents a filter leaves (each row: status, totalAmount, paidAmount, outstandingAmount,
 * creditedAmount, dueDate, date, paymentTerms, isOpening). Same arithmetic the pages did in the browser.
 */
function summarise(rows, { now = Date.now() } = {}) {
  const list = rows || [];
  const isInvoiced = (r) => r.status === "INVOICED" || (r.status === "APPROVED" && !r.isOpening);
  const money = (r) => (Number.isFinite(Number(r.totalAmount)) ? Number(r.totalAmount) : 0);
  const out = {
    count: list.length,
    draft: list.filter((r) => r.status === "DRAFT").length,
    confirmed: list.filter((r) => r.status === "APPROVED").length,
    invoiced: 0,
    paid: 0,
    partial: 0,
    unpaid: 0,
    open: 0,
    overdue: 0,
    overdueValue: 0,
    totalValue: 0,
    invoicedValue: 0,
    // by the document's own status (the pages that count pending / rejected / invoiced returns read these)
    byStatus: {},
    valueByStatus: {},
  };
  for (const r of list) {
    const st = String(r.status || "");
    out.byStatus[st] = (out.byStatus[st] || 0) + 1;
    out.valueByStatus[st] = (out.valueByStatus[st] || 0) + money(r);
    out.totalValue += money(r);
    if (isInvoiced(r)) {
      out.invoiced += 1;
      out.invoicedValue += money(r);
    }
    const p = paymentStatus(r);
    if (!p) continue;
    if (p.key === "PAID") out.paid += 1;
    else if (p.key === "PARTIAL") out.partial += 1;
    else out.unpaid += 1;
    out.open += p.outstanding ?? 0;
    if (isPastDue(r, now)) {
      out.overdue += 1;
      out.overdueValue += p.outstanding ?? 0;
    }
  }
  return out;
}

module.exports = { POSTED, TOLERANCE, paymentStatus, termDays, dueDateOf, isPastDue, summarise };
