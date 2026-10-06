// Quotations and delivery notes: the rules that need no database.
//
// Neither document posts to the ledger or moves stock. A quotation is an offer; a delivery note
// is the paper that goes with the goods. Stock leaves, cost of sales is booked and the receivable
// is raised only when the SALES ORDER (the invoice) is approved - see services/orderPurchase/
// transactionService.js. These documents therefore live in their own collections: nothing that
// reads Transaction (VAT return, ageing, dashboards, e-invoicing) can ever pick them up.

const { addDays, diffDays, dubaiDay, todayInDubai, toExpiryDay, isCalendarDay } = require("./documentExpiry");

// ---- quotation ---------------------------------------------------------------------------

const QUOTATION_STATUS = Object.freeze({
  DRAFT: "DRAFT", // being written; the only state that can be edited or deleted
  SENT: "SENT", // with the customer; expires on validUntil
  ACCEPTED: "ACCEPTED", // the customer said yes
  REJECTED: "REJECTED", // the customer said no
  CONVERTED: "CONVERTED", // became a sales order (or a delivery note)
  SUPERSEDED: "SUPERSEDED", // replaced by a newer revision
});

// action -> the states it can start from and the state it leaves the quotation in.
const QUOTATION_ACTIONS = Object.freeze({
  send: { from: ["DRAFT"], to: "SENT" },
  accept: { from: ["SENT"], to: "ACCEPTED" },
  reject: { from: ["SENT", "ACCEPTED"], to: "REJECTED" },
});

// Converting needs a quotation the customer can still hold us to. Revising is how a lapsed or
// declined offer is put back in play: it copies the lines into a new draft at today's validity.
const QUOTATION_CONVERTIBLE = Object.freeze(["SENT", "ACCEPTED"]);
const QUOTATION_REVISABLE = Object.freeze(["SENT", "ACCEPTED", "REJECTED"]);
const QUOTATION_EDITABLE = Object.freeze(["DRAFT"]);

const DEFAULT_VALIDITY_DAYS = 30;

// Where a quotation stands against its validity. Only a SENT quotation can lapse: a draft has not
// been offered yet, and an accepted one is a commitment made inside its validity.
function quotationExpiry(quotation, now = new Date()) {
  const validDay = toExpiryDay(quotation?.validUntil);
  const today = todayInDubai(now);
  const daysLeft = validDay ? diffDays(today, validDay) : null;
  return { validDay, daysLeft, expired: quotation?.status === "SENT" && daysLeft !== null && daysLeft < 0 };
}

const defaultValidUntil = (fromDay, days = DEFAULT_VALIDITY_DAYS) => addDays(fromDay, days);

// A revision keeps the number of the quotation it started from: QT-2026-0007, QT-2026-0007-R1, -R2.
// The base comes from the number series; only the suffix is derived, so no number is ever invented.
const baseNumber = (no) => String(no || "").replace(/-R\d+$/, "");
const revisionNumber = (no, revision) => `${baseNumber(no)}-R${revision}`;

// ---- delivery note -----------------------------------------------------------------------

const DELIVERY_STATUS = Object.freeze({
  DRAFT: "DRAFT", // prepared, still editable
  DISPATCHED: "DISPATCHED", // left the warehouse
  DELIVERED: "DELIVERED", // the customer signed for it
  CANCELLED: "CANCELLED",
});

// Whether the invoice for the goods exists. Kept on the note (and refreshed whenever the sales
// order changes state) so "delivered but not invoiced" is an indexed query, not a join.
const INVOICE_STATE = Object.freeze({
  NONE: "NONE", // no invoice, or the invoice was deleted / rejected / cancelled
  DRAFT: "DRAFT", // a sales order exists but is not approved yet
  INVOICED: "INVOICED", // the sales order is approved: stock and ledger have moved
});

const DELIVERY_ACTIONS = Object.freeze({
  dispatch: { from: ["DRAFT"], to: "DISPATCHED" },
  // A counter pick-up or a van sale is handed over the moment it is prepared.
  deliver: { from: ["DRAFT", "DISPATCHED"], to: "DELIVERED" },
  cancel: { from: ["DRAFT", "DISPATCHED"], to: "CANCELLED" },
});
const DELIVERY_EDITABLE = Object.freeze(["DRAFT"]);

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

// How much of a sales order has been, or is about to be, delivered.
//   orderLines:    [{ _id, qty }]
//   deliveryLines: [{ sourceLineId, status, qty, deliveredQty }] from every note against the order
// A note that is still in the warehouse (DRAFT, DISPATCHED) holds its whole quantity; a delivered
// one counts what the customer actually accepted; a cancelled one counts for nothing.
function fulfilment(orderLines, deliveryLines) {
  const out = {};
  for (const l of orderLines || []) {
    out[String(l._id)] = { ordered: Number(l.qty) || 0, pending: 0, delivered: 0, remaining: 0, over: false };
  }
  for (const d of deliveryLines || []) {
    const row = out[String(d.sourceLineId)];
    if (!row || d.status === "CANCELLED") continue;
    if (d.status === "DELIVERED") row.delivered += Number(d.deliveredQty ?? d.qty) || 0;
    else row.pending += Number(d.qty) || 0;
  }
  for (const row of Object.values(out)) {
    row.pending = round3(row.pending);
    row.delivered = round3(row.delivered);
    row.remaining = Math.max(0, round3(row.ordered - row.pending - row.delivered));
    row.over = round3(row.pending + row.delivered) > row.ordered;
  }
  return out;
}

// Confirming a delivery: what the customer actually took, line by line. A line that is not whole
// needs a reason, because that gap is what the invoice will not charge for.
//   lines: the note's lines; input: [{ lineId, deliveredQty, shortReason }] (a missing line = in full)
function settleDelivery(lines, input = []) {
  const byId = new Map((input || []).map((i) => [String(i.lineId), i]));
  const errors = [];
  const settled = lines.map((line, index) => {
    const given = byId.get(String(line._id));
    const qty = Number(line.qty) || 0;
    const deliveredQty = given && given.deliveredQty !== undefined && given.deliveredQty !== "" ? Number(given.deliveredQty) : qty;
    if (!Number.isFinite(deliveredQty) || deliveredQty < 0) {
      errors.push({ index, message: `Line ${index + 1}: delivered quantity must be zero or more` });
    } else if (round3(deliveredQty) > qty) {
      errors.push({ index, message: `Line ${index + 1}: delivered ${deliveredQty} is more than the ${qty} sent` });
    }
    const short = round3(qty - deliveredQty) > 0;
    const shortReason = short ? String(given?.shortReason || "").trim() : "";
    if (short && !shortReason) errors.push({ index, message: `Line ${index + 1}: say why ${round3(qty - deliveredQty)} was not delivered` });
    return { lineId: line._id, deliveredQty: round3(deliveredQty), shortReason };
  });
  if (!errors.length && settled.every((s) => s.deliveredQty === 0)) {
    errors.push({ index: -1, message: "Nothing was delivered. Cancel the delivery note instead." });
  }
  return { lines: settled, errors };
}

// ---- the VAT clock -----------------------------------------------------------------------

// A tax invoice is due within 14 days of the supply, which for goods is the day they are delivered.
// A supplier that makes several supplies to one customer in a month may instead issue one summary
// invoice, delivered within 14 days of the END of that month.
// (UAE VAT Executive Regulation, Article 67 - check the current text before relying on this for advice.)
const INVOICE_WINDOW_DAYS = 14;
const DUE_SOON_DAYS = 3;

const lastDayOfMonth = (day) => {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of the next month = last day of this one
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

// clock: "within" (comfortably inside 14 days), "dueSoon" (3 days or fewer left), "pastStandard"
// (the 14 days are gone but a summary invoice is still in time), "overdue" (both have passed).
function invoiceClock(deliveredAt, now = new Date()) {
  const deliveredDay = typeof deliveredAt === "string" && isCalendarDay(deliveredAt) ? deliveredAt : dubaiDay(deliveredAt);
  if (!deliveredDay) return null;
  const today = todayInDubai(now);
  const standardDue = addDays(deliveredDay, INVOICE_WINDOW_DAYS);
  const summaryDue = addDays(lastDayOfMonth(deliveredDay), INVOICE_WINDOW_DAYS);
  const toStandard = diffDays(today, standardDue);
  const toSummary = diffDays(today, summaryDue);
  let clock = "within";
  if (toSummary < 0) clock = "overdue";
  else if (toStandard < 0) clock = "pastStandard";
  else if (toStandard <= DUE_SOON_DAYS) clock = "dueSoon";
  return { deliveredDay, daysSince: diffDays(deliveredDay, today), standardDue, summaryDue, daysToStandard: toStandard, daysToSummary: toSummary, clock };
}

module.exports = {
  QUOTATION_STATUS, QUOTATION_ACTIONS, QUOTATION_CONVERTIBLE, QUOTATION_REVISABLE, QUOTATION_EDITABLE, DEFAULT_VALIDITY_DAYS,
  quotationExpiry, defaultValidUntil, baseNumber, revisionNumber,
  DELIVERY_STATUS, INVOICE_STATE, DELIVERY_ACTIONS, DELIVERY_EDITABLE,
  fulfilment, settleDelivery,
  INVOICE_WINDOW_DAYS, DUE_SOON_DAYS, lastDayOfMonth, invoiceClock,
};
