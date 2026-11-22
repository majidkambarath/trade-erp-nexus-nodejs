// What the notification feed says about money owed, bills falling due and paper that is running out. Pure: rows in, one notice (or none)
// out - the service reads the rows, raises the notice and closes it when it stops being true (services/core/notificationChecksService.js).
//
// A notice is { severity, title, body }. Two things matter in how they are shaped:
//   - ONE ROW PER KIND, never one per invoice. NotificationService.forPerson reads only the newest 300 unresolved rows of the whole
//     organisation, so a ledger with a row per overdue invoice would push every stock, cheque and CRM alert out of everybody's bell.
//     A grouped row says how many and how much, and links to the report that names them. No customer is named on a money row: the
//     audience is "may see sales", not "may see every customer's balance".
//   - It is KEYED BY WEEK (`overdue_receivables:2026-11-16`, the Monday). Within the week the figures are updated in place and a notice
//     somebody has read stays read; a new week is a new row, so a condition that is still true is told again - once a week, not every
//     few minutes - and last week's row is closed by the check.

const days = require("./documentExpiry");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const money = (amount, currency) => `${currency ? `${currency} ` : ""}${Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (rows, field) => Math.round(rows.reduce((t, r) => t + (Number(r[field]) || 0), 0) * 100) / 100;

/** The Monday on or before a calendar day ("YYYY-MM-DD"): what a weekly notice is keyed on. null for anything that is not a day. */
function weekKey(day) {
  if (!days.isCalendarDay(day)) return null;
  const sinceMonday = (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7; // Sunday is 0 in JavaScript; Monday must be 0 here
  return days.addDays(day, -sinceMonday);
}

/**
 * Customer invoices past their due day. `invoices`: { partyId, outstanding, dueDay } (dueDay as the organisation's calendar day).
 * An invoice due today is not late yet. Serious (critical) once the oldest is past `seriousDays`.
 */
function overdueReceivables(invoices, today, { currency = "", seriousDays = 60 } = {}) {
  const late = [];
  for (const i of invoices || []) {
    const by = days.diffDays(i.dueDay, today);
    if (by !== null && by >= 1) late.push({ ...i, by });
  }
  if (!late.length) return null;
  const customers = new Set(late.map((i) => String(i.partyId ?? i.partyName ?? "")));
  const oldest = Math.max(...late.map((i) => i.by));
  return {
    severity: oldest > seriousDays ? "critical" : "warning",
    title: `${plural(late.length, "invoice")} overdue: ${money(sum(late, "outstanding"), currency)} owed by ${plural(customers.size, "customer")}`,
    body: `The oldest is ${plural(oldest, "day")} past its due date. The ageing report names who to chase.`,
  };
}

/** Supplier bills past their due day, and those falling due within `soonDays` (today counts as falling due). */
function payablesDue(bills, today, { currency = "", soonDays = 7 } = {}) {
  const overdue = [];
  const soon = [];
  for (const b of bills || []) {
    const by = days.diffDays(b.dueDay, today);
    if (by === null) continue;
    if (by >= 1) overdue.push(b);
    else if (-by <= soonDays) soon.push(b);
  }
  if (!overdue.length && !soon.length) return null;
  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue (${money(sum(overdue, "outstanding"), currency)})`);
  if (soon.length) parts.push(`${soon.length} due within ${plural(soonDays, "day")} (${money(sum(soon, "outstanding"), currency)})`);
  return {
    severity: overdue.length ? "warning" : "info",
    title: `Supplier bills: ${parts.join(", ")}`,
    body: "Pay the overdue ones first. The payables ageing report lists every bill.",
  };
}

const KIND_WORDS = { customer: "Customer", vendor: "Supplier", staff: "Staff" };

/**
 * Documents (a trade licence, a visa) that have expired or expire soon: the answer of DocumentExpiryService.list, soonest first.
 * A customer's or supplier's are named, up to three, because the screen they open shows exactly that. An employee's are NOT: an
 * employee's documents are HR's, so the row says how many and when the first runs out, and the HR screen names them.
 */
function documentsExpiring(result, kind, { withinDays = 30 } = {}) {
  const rows = result?.rows || [];
  if (!rows.length) return null;
  const expired = rows.filter((r) => r.daysLeft < 0).length;
  const soon = rows.length - expired;
  const parts = [];
  if (expired) parts.push(`${expired} expired`);
  if (soon) parts.push(`${soon} expiring within ${plural(withinDays, "day")}`);
  const first = rows[0];
  let body;
  if (kind === "staff") {
    body = `${first.daysLeft < 0 ? "The oldest ran out" : "The next runs out"} on ${first.expiryDate}.`;
  } else {
    const named = rows.slice(0, 3).map((r) => `${r.documentType || "Document"} of ${r.partyName} (${days.daysLeftLabel(r.daysLeft).toLowerCase()})`);
    body = `${named.join("; ")}${rows.length > 3 ? `; and ${rows.length - 3} more` : ""}.`;
  }
  return { severity: expired ? "warning" : "info", title: `${KIND_WORDS[kind] || "Party"} documents: ${parts.join(", ")}`, body };
}

/** Batches of goods that have expired or expire soon (BatchService.list, soonest first; it returns at most `cap`). */
function batchesExpiring(batches, { withinDays = 30, cap = 500 } = {}) {
  const rows = (batches || []).filter((b) => b.expiryDate);
  if (!rows.length) return null;
  const left = (b) => (b.expired ? "expired" : b.daysToExpiry <= 0 ? "expires today" : `${plural(b.daysToExpiry, "day")} left`);
  const named = rows.slice(0, 3).map((b) => `${b.itemName || b.sku || "An item"}, ${b.qtyOnHand} left (${left(b)})`);
  const more = rows.length > 3 ? `; and ${rows.length - 3} more` : "";
  if (rows.length >= cap) {
    return { severity: "warning", title: `Batches: ${cap} or more expired or expiring within ${plural(withinDays, "day")}`, body: `${named.join("; ")}${more}.` };
  }
  const expired = rows.filter((b) => b.expired).length;
  const soon = rows.length - expired;
  const parts = [];
  if (expired) parts.push(`${expired} expired`);
  if (soon) parts.push(`${soon} expiring within ${plural(withinDays, "day")}`);
  return { severity: expired ? "warning" : "info", title: `Batches: ${parts.join(", ")}`, body: `${named.join("; ")}${more}.` };
}

/** Whether a submission needs a PERSON: rejected, or failed with no automatic retry left (a failure that will retry on its own does not). */
const needsAttention = (s) => s?.status === "REJECTED" || (s?.status === "FAILED" && !s?.nextRetryAt);

/** E-invoices that need a person: `subs` are { status, rejectedBy, nextRetryAt }. Rejected by the tax authority is the serious one. */
function einvoiceAttention(subs) {
  const need = (subs || []).filter(needsAttention);
  if (!need.length) return null;
  const byFta = need.filter((s) => s.status === "REJECTED" && s.rejectedBy === "fta").length;
  const byBuyer = need.filter((s) => s.status === "REJECTED" && s.rejectedBy !== "fta").length;
  const failed = need.length - byFta - byBuyer;
  const parts = [];
  if (byFta) parts.push(`${byFta} rejected by the tax authority`);
  if (byBuyer) parts.push(`${byBuyer} rejected by the buyer`);
  if (failed) parts.push(`${failed} failed and will not be tried again on their own`);
  return {
    severity: byFta ? "critical" : "warning",
    title: `${plural(need.length, "e-invoice")} ${need.length === 1 ? "needs" : "need"} attention`,
    body: `${parts.join(", ")}. Open e-invoicing to fix and send again, or to issue a credit note.`,
  };
}

module.exports = { weekKey, overdueReceivables, payablesDue, documentsExpiring, batchesExpiring, einvoiceAttention, needsAttention };
