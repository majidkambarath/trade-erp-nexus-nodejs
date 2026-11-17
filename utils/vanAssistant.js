// What Zarvia AI says about a van, built from the van's own figures (pure: no Mongoose, no clock). The same rule as
// every lookup: the server writes the sentence and the table, the model only chose the question.
const { money, round2 } = require("./assistantData");

const MAX_ROWS = 15;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// a salesman asking about their own van goes to My van; a supervisor asking about another goes to that trip
const tripLink = (trip) => (trip?.mine === false ? { path: `/van-sales/trips?open=${trip.id}`, label: `Open ${trip.tripNo}` } : { path: "/van-sales/my-van", label: "Open my van" });

/** What is on the van now. trip: as vanTripService.present() gives it. */
function vanStockTable(trip) {
  if (!trip) return { reply: "No van trip is open for you today.", table: null };
  const rows = (trip.sellable || []).slice().sort((a, b) => b.qty - a.qty);
  const damaged = trip.damaged || [];
  if (!rows.length && !damaged.length) return { reply: `Nothing is left on ${trip.vanCode} (${trip.tripNo}).`, table: null };
  const shown = rows.slice(0, MAX_ROWS);
  return {
    reply: `${trip.vanCode} has ${plural(rows.length, "item")} to sell${damaged.length ? ` and ${plural(damaged.length, "damaged item")} brought back` : ""}.`,
    table: {
      title: `On ${trip.vanCode}`,
      rows: [
        ...shown.map((l) => ({ label: l.itemName, sub: "", value: String(l.qty), tone: "" })),
        ...damaged.slice(0, 5).map((l) => ({ label: l.itemName, sub: "Damaged", value: String(l.qty), tone: "danger" })),
      ],
      total: null,
      more: rows.length - shown.length,
      link: tripLink(trip),
    },
  };
}

/** Who on the route still owes money. open: AgeingService rows for the route's customers. */
function routeOwingTable(trip, open = [], currency = "") {
  if (!trip) return { reply: "No van trip is open for you today.", table: null };
  const by = new Map();
  for (const r of open) {
    const k = String(r.partyId);
    const a = by.get(k) || { name: r.partyName || "Customer", owed: 0, overdue: 0, invoices: 0 };
    a.owed = round2(a.owed + Number(r.outstanding || 0));
    if (Number(r.daysPastDue) > 0) a.overdue = round2(a.overdue + Number(r.outstanding || 0));
    a.invoices += 1;
    by.set(k, a);
  }
  const rows = [...by.values()].sort((a, b) => b.owed - a.owed);
  if (!rows.length) return { reply: `Nobody on ${trip.routeName || "this route"} owes anything.`, table: null };
  const total = round2(rows.reduce((t, r) => t + r.owed, 0));
  const shown = rows.slice(0, MAX_ROWS);
  return {
    reply: `${plural(rows.length, "customer")} on ${trip.routeName || "this route"} owe ${money(total, currency)}${rows.some((r) => r.overdue) ? `, ${money(round2(rows.reduce((t, r) => t + r.overdue, 0)), currency)} of it overdue` : ""}.`,
    table: {
      title: `Owed on ${trip.routeName || "the route"}`,
      rows: shown.map((r) => ({ label: r.name, sub: r.overdue ? `${money(r.overdue, currency)} overdue` : plural(r.invoices, "invoice"), value: money(r.owed, currency), tone: r.overdue ? "danger" : "" })),
      total: { label: "Total", value: money(total, currency) },
      more: rows.length - shown.length,
      link: tripLink(trip),
    },
  };
}

/** The stops not served yet today, in visit order. */
function notVisitedTable(trip) {
  if (!trip) return { reply: "No van trip is open for you today.", table: null };
  const left = (trip.route || []).filter((s) => !s.sold && !s.collected && !s.visit);
  if (!(trip.route || []).length) return { reply: "This trip has no route.", table: null };
  if (!left.length) return { reply: `Every stop on ${trip.routeName || "the route"} has been called on today.`, table: null };
  const shown = left.slice(0, MAX_ROWS);
  return {
    reply: `${plural(left.length, "stop")} of ${trip.route.length} still to call on.`,
    table: { title: "Still to visit", rows: shown.map((s) => ({ label: s.name, sub: `Stop ${s.seq + 1}`, value: "", tone: "" })), total: null, more: left.length - shown.length, link: tripLink(trip) },
  };
}

/** The suggested load with its reasons. s: vanPlanningService.suggestedLoad(). */
function suggestedLoadTable(trip, s) {
  if (!trip) return { reply: "No van trip is open for you today.", table: null };
  const lines = s?.lines || [];
  if (!lines.length) return { reply: s?.note || "Nothing to suggest yet: no orders for this route and no past runs to learn from.", table: null };
  const shown = lines.slice(0, MAX_ROWS);
  const why = (w) => [w.preorder ? `${w.preorder} ordered` : "", w.runs ? `about ${Math.ceil(w.average)} a run` : "", w.onVan ? `${w.onVan} on van` : "", w.capped ? "depot short" : ""].filter(Boolean).join(", ");
  return {
    reply: `From the orders and the last ${plural(s.runs || 0, "run")} of ${trip.routeName || "the route"}, load ${plural(lines.length, "item")}.`,
    table: { title: "Suggested load", rows: shown.map((l) => ({ label: l.itemName, sub: why(l.why || {}), value: String(l.qty), tone: l.why?.capped ? "danger" : "" })), total: null, more: lines.length - shown.length, link: { path: `/van-sales/trips?open=${trip.id}`, label: `Open ${trip.tripNo}` } },
  };
}

module.exports = { vanStockTable, routeOwingTable, notVisitedTable, suggestedLoadTable };
