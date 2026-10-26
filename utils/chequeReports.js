// Reports over the cheques still in the air: what falls due and when (the maturity report), and what it does to the bank
// (the forward view). Pure: rows in, figures out - services/banking/chequeReportService.js reads the rows.
//
// A "live" cheque is one not yet cleared or written off (utils/chequeRules.js LIVE): pending, on hold, or at the bank.
// Money, in these reports, is only ever shown as three things kept apart: what is coming IN (cheques we hold), what is
// going OUT (cheques we issued), and what is ON HOLD - which is not expected on its date, because it will not be banked
// on its date, so counting it as expected cash would flatter the plan. It is shown beside the figures, never in them.

const rules = require("./chequeRules");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How far away a cheque is, in the buckets a person plans by.
const BUCKETS = Object.freeze([
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "Next 7 days" },
  { key: "month", label: "8 to 30 days" },
  { key: "quarter", label: "31 to 90 days" },
  { key: "later", label: "Over 90 days" },
].map(Object.freeze));

function bucketOf(days) {
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  if (days <= 90) return "quarter";
  return "later";
}

const empty = () => ({ count: 0, amount: 0 });
const add = (acc, amount) => { acc.count += 1; acc.amount = round2(acc.amount + amount); };
const blank = (key, label) => ({ key, label, receivable: empty(), payable: empty(), onHold: empty(), net: 0 });

// Where a cheque's money sits in these figures: coming in, going out, or on hold (either direction).
function place(group, row) {
  if (row.status === "hold") add(group.onHold, row.amount);
  else if (row.direction === "receipt") add(group.receivable, row.amount);
  else add(group.payable, row.amount);
}
const settle = (g) => { g.net = round2(g.receivable.amount - g.payable.amount); return g; };

const GROUPINGS = Object.freeze(["bucket", "party", "bank", "month"]);

// The maturity report. `rows`: { _id, direction, status, chequeNo, chequeDay, partyId, partyName, bankAccountId, bankName,
// amount, voucherNo }. Returns the groups, the totals, and every cheque with how far away it is.
function maturity(rows, today, { groupBy = "bucket" } = {}) {
  const by = GROUPINGS.includes(groupBy) ? groupBy : "bucket";
  const groups = new Map();
  const totals = blank("total", "Total");
  const detail = [];
  for (const row of rows) {
    const days = rules.daysBetween(today, row.chequeDay);
    const bucket = bucketOf(days);
    const [key, label] = by === "bucket" ? [bucket, BUCKETS.find((b) => b.key === bucket).label]
      : by === "party" ? [String(row.partyId || row.partyName || "none"), row.partyName || "No party"]
      : by === "bank" ? [String(row.bankAccountId || "none"), row.bankName || "No account"]
      : [row.chequeDay.slice(0, 7), row.chequeDay.slice(0, 7)];
    if (!groups.has(key)) groups.set(key, blank(key, label));
    place(groups.get(key), row);
    place(totals, row);
    detail.push({ ...row, days, bucket });
  }
  const list = [...groups.values()].map(settle);
  const weight = (g) => g.receivable.amount + g.payable.amount + g.onHold.amount;
  if (by === "bucket") list.sort((a, b) => BUCKETS.findIndex((x) => x.key === a.key) - BUCKETS.findIndex((x) => x.key === b.key));
  else if (by === "month") list.sort((a, b) => a.key.localeCompare(b.key));
  else list.sort((a, b) => weight(b) - weight(a) || a.label.localeCompare(b.label));
  detail.sort((a, b) => a.days - b.days || String(a.chequeNo).localeCompare(String(b.chequeNo)));
  const atBank = rows.filter((r) => r.status === "deposited");
  return {
    asOn: today, groupBy: by, groups: list, totals: settle(totals), rows: detail,
    atBank: { count: atBank.length, amount: round2(atBank.reduce((t, r) => t + r.amount, 0)) },
  };
}

// The periods the forward view is drawn in. Weeks are rolling from the day asked for; months are calendar months, the
// first starting on that day. -> [{ key, label, from, to }]
function forwardPeriods(asOn, unit = "week", count = 12) {
  const n = Math.max(1, Math.min(Number(count) || 12, 52));
  const out = [];
  if (unit === "month") {
    let y = Number(asOn.slice(0, 4));
    let m = Number(asOn.slice(5, 7)) - 1;
    for (let i = 0; i < n; i += 1) {
      const first = `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
      out.push({ key: first.slice(0, 7), label: `${MONTHS[m]} ${y}`, from: i === 0 ? asOn : first, to: last });
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return out;
  }
  const fmt = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
  for (let i = 0; i < n; i += 1) {
    const from = rules.addDays(asOn, i * 7);
    const to = rules.addDays(asOn, i * 7 + 6);
    out.push({ key: from, label: `${fmt(from)} - ${fmt(to)}`, from, to });
  }
  return out;
}

// What the cheques do to the bank, period by period. `opening` is what the bank accounts hold now. Cheques already due are
// assumed to clear at once, so they are taken off the opening position before the first period starts - the cautious
// reading, and the one that matches a cheque we issued, which the bank may honour any day after its date.
function forward(rows, asOn, { unit = "week", count = 12, opening = 0 } = {}) {
  const periods = forwardPeriods(asOn, unit, count).map((p) => ({ ...p, receipts: empty(), payments: empty(), onHold: empty(), net: 0, closing: 0 }));
  const slot = () => ({ receipts: empty(), payments: empty(), onHold: empty(), net: 0 });
  const due = slot();
  const later = slot();
  const put = (s, row) => {
    if (row.status === "hold") add(s.onHold, row.amount);
    else if (row.direction === "receipt") add(s.receipts, row.amount);
    else add(s.payments, row.amount);
  };
  for (const row of rows) {
    if (row.chequeDay < asOn) put(due, row);
    else put(periods.find((x) => row.chequeDay >= x.from && row.chequeDay <= x.to) || later, row);
  }
  due.net = round2(due.receipts.amount - due.payments.amount);
  later.net = round2(later.receipts.amount - later.payments.amount);
  const afterDue = round2(opening + due.net);
  let running = afterDue;
  for (const p of periods) {
    p.net = round2(p.receipts.amount - p.payments.amount);
    running = round2(running + p.net);
    p.closing = running;
  }
  const sum = (key) => round2(periods.reduce((t, p) => t + p[key].amount, 0) + due[key].amount + later[key].amount);
  return {
    asOn, unit, opening: round2(opening), due, afterDue, periods, later,
    totals: { receipts: sum("receipts"), payments: sum("payments"), onHold: sum("onHold"), closing: round2(running + later.net) },
  };
}

module.exports = { BUCKETS, GROUPINGS, bucketOf, maturity, forwardPeriods, forward };
