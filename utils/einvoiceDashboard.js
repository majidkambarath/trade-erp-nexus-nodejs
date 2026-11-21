// Pure rules behind the e-invoicing dashboard: which leg of the journey a submission is on, what needs a person, and the shapes
// the screen draws. No database here, so every rule can be tested alone.

const DELIVERED = new Set(["sent", "received_by_ap", "forwarded", "delivered_confirmed", "delivered"]);
const IN_PROGRESS = new Set(["queued", "sending", "retrying"]);

/** The buyer-delivery leg: delivered | inProgress | ftaOnly | failed | rejected | pending (not sent to the provider yet). */
function deliveryLeg(sub) {
  if (!sub) return "pending";
  if (sub.status === "QUEUED") return "pending";
  const d = String(sub.deliveryStatus || "").toLowerCase();
  if (sub.route === "reporting_only") return "ftaOnly";
  if (d === "rejected" || sub.status === "REJECTED") return "rejected";
  if (d === "failed" || d === "attention_required" || sub.status === "FAILED") return "failed";
  if (DELIVERED.has(d)) return "delivered";
  if (IN_PROGRESS.has(d)) return "inProgress";
  if (sub.status === "ACKNOWLEDGED" || sub.status === "REPORTED") return "delivered"; // the built-in sandbox names no delivery leg
  return "inProgress";
}

/** The tax-authority leg: reported | reporting | notReported | rejected | withdrawn | unresolved | pending. */
function ftaLeg(sub) {
  if (!sub || sub.status === "QUEUED" || sub.status === "FAILED") return "pending";
  const t = String(sub.taxStatus || "").toLowerCase();
  if (t === "reported" || sub.status === "REPORTED") return "reported";
  if (t === "rejected") return "rejected";
  if (t === "withdrawn") return "withdrawn";
  if (t === "unresolved") return "unresolved";
  if (t === "not_reported") return "notReported";
  if (sub.status === "REJECTED" && sub.rejectedBy !== "fta") return "withdrawn";
  return "reporting";
}

const emptyCounts = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const DELIVERY_KEYS = ["delivered", "inProgress", "ftaOnly", "failed", "rejected", "pending"];
const FTA_KEYS = ["reported", "reporting", "notReported", "rejected", "withdrawn", "unresolved", "pending"];

/** Counts of each leg over a list of submissions. */
function legs(subs) {
  const delivery = emptyCounts(DELIVERY_KEYS);
  const fta = emptyCounts(FTA_KEYS);
  for (const s of subs) { delivery[deliveryLeg(s)] += 1; fta[ftaLeg(s)] += 1; }
  return { delivery, fta };
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Invoices (380) and credit notes (381) counted apart; net is invoices less credit notes. */
function totalsByType(subs) {
  const blank = () => ({ count: 0, net: 0, tax: 0, payable: 0 });
  const invoices = blank();
  const creditNotes = blank();
  for (const s of subs) {
    if (!["SUBMITTED", "ACKNOWLEDGED", "REPORTED"].includes(s.status)) continue;
    const t = s.invoiceTypeCode === "381" ? creditNotes : invoices;
    t.count += 1; t.net += s.totals?.net || 0; t.tax += s.totals?.tax || 0; t.payable += s.totals?.payable || 0;
  }
  for (const t of [invoices, creditNotes]) { t.net = r2(t.net); t.tax = r2(t.tax); t.payable = r2(t.payable); }
  return { invoices, creditNotes, net: { net: r2(invoices.net - creditNotes.net), tax: r2(invoices.tax - creditNotes.tax), payable: r2(invoices.payable - creditNotes.payable) } };
}

/** The last `n` calendar months ending in the month of `today` ("YYYY-MM-DD"), oldest first, as "YYYY-MM". */
function lastMonths(today, n = 6) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i < n; i += 1) { out.unshift(`${y}-${String(m).padStart(2, "0")}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return out;
}

/** Sent and received per month, every month present even when quiet. `sent` / `received` are { "YYYY-MM": { count, amount } }. */
function monthly(months, sent, received) {
  return months.map((month) => ({
    month,
    sent: sent[month]?.count || 0, sentAmount: r2(sent[month]?.amount),
    received: received[month]?.count || 0, receivedAmount: r2(received[month]?.amount),
  }));
}

/** What a person should do about a submission that needs them, in words. null when nothing is asked of them. */
function attentionOf(sub) {
  if (sub.status === "FAILED") return { action: "retry", reason: sub.lastError || "Could not be sent" };
  if (sub.status === "REJECTED") {
    if (sub.rejectedBy === "fta") return { action: "credit_note", reason: sub.deliveryReasonText || "Rejected by the tax authority: issue a credit note and a new invoice" };
    const code = String(sub.deliveryReasonCode || "").toUpperCase();
    if (code === "BV" || code === "SV") return { action: "correct", reason: sub.deliveryReasonText || "The buyer rejected the details: fix the customer and resend" };
    return { action: "credit_note", reason: sub.deliveryReasonText || "Rejected by the buyer: issue a credit note and a new invoice" };
  }
  return null;
}

/** A submission still SUBMITTED with no answer for more than `hours`. */
function isStuck(sub, now = new Date(), hours = 24) {
  if (sub.status !== "SUBMITTED") return false;
  const at = new Date(sub.submittedAt || sub.updatedAt || 0).getTime();
  return at > 0 && now.getTime() - at > hours * 3600 * 1000;
}

/** The worklist tiles. Each has a count, an optional amount and the screen to open. Tiles at zero are kept (the screen mutes them). */
function todoItems(c) {
  const out = "/e-invoicing/outbound";
  const inb = "/e-invoicing/inbound";
  return [
    { key: "notSent", label: "Not sent", count: c.notSent?.count || 0, amount: c.notSent?.amount || 0, link: `${out}?status=NOT_SENT`, tone: "warning" },
    { key: "overdue", label: "Overdue to send", count: c.overdue?.count || 0, amount: c.overdue?.amount || 0, link: `${out}?status=NOT_SENT&overdue=1`, tone: "danger" },
    { key: "failed", label: "Failed", count: c.failed || 0, link: `${out}?status=FAILED`, tone: "danger" },
    { key: "rejectedByBuyer", label: "Rejected by buyer", hint: "fix and resend", count: c.rejectedByBuyer || 0, link: `${out}?status=REJECTED`, tone: "danger" },
    { key: "rejectedByFta", label: "Rejected by the tax authority", hint: "credit note", count: c.rejectedByFta || 0, link: `${out}?status=REJECTED`, tone: "danger" },
    { key: "stuck", label: "No answer for 24 hours", count: c.stuck || 0, link: `${out}?status=SUBMITTED`, tone: "warning" },
    { key: "inboundToReview", label: "Supplier invoices to review", count: c.inboundToReview || 0, link: `${inb}?status=RECEIVED`, tone: "warning" },
    { key: "inboundNotRecorded", label: "Accepted, not recorded as purchase", count: c.inboundNotRecorded || 0, link: `${inb}?status=ACCEPTED&recorded=0`, tone: "warning" },
  ];
}

/**
 * The period to compare with, for days "YYYY-MM-DD". A period starting on the 1st and ending in the same month is compared with
 * the same days of the month before (1-21 Nov against 1-21 Oct, a short month clamped); anything else with the same number of
 * days just before it.
 */
function previousRange(start, end) {
  const d = (s) => new Date(`${s}T00:00:00.000Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const DAY = 86400000;
  if (start.endsWith("-01") && start.slice(0, 7) === end.slice(0, 7)) {
    const y = Number(start.slice(0, 4));
    const m = Number(start.slice(5, 7));
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const day = Math.min(Number(end.slice(8, 10)), last);
    const mm = String(pm).padStart(2, "0");
    return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(day).padStart(2, "0")}` };
  }
  const days = Math.round((d(end) - d(start)) / DAY) + 1;
  return { from: iso(new Date(d(start).getTime() - days * DAY)), to: iso(new Date(d(start).getTime() - DAY)) };
}

/** Change against the previous period, in percent with one decimal; null when there was nothing to compare with. */
function change(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
}

/** Compare a taxpayer profile held by the provider with our own company profile. */
function profileMismatches(wafeq, ours) {
  const out = [];
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (ours.trn && wafeq.vatNumber && digits(ours.trn) !== digits(wafeq.vatNumber)) out.push({ field: "TRN", wafeq: wafeq.vatNumber, ours: ours.trn });
  if (ours.name && wafeq.legalName && norm(ours.name) !== norm(wafeq.legalName)) out.push({ field: "Legal name", wafeq: wafeq.legalName, ours: ours.name });
  return out;
}

module.exports = { previousRange, change, deliveryLeg, ftaLeg, legs, totalsByType, lastMonths, monthly, attentionOf, isStuck, todoItems, profileMismatches, DELIVERY_KEYS, FTA_KEYS };
