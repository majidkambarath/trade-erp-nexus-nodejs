// Pure rules of the garage's REPORTS - many cards, many claims, many vehicles at once (no Mongoose, no clock).
// Kept apart from utils/garage.js on purpose: that file is about ONE job card (the estimate, the tasks, the
// board); this one is about the workshop's whole book - the aggregates an owner reads to run the place.
// Everything here takes plain arrays the service has already fetched and returns a report shape; no query
// lives in this file.
//
// THE FINDING THAT STARTED THIS FILE: before it existed, the module had exactly one report
// (JobCardService.analysis), and it answered only "what happened to cars that have ALREADY LEFT" - it reads
// JobCard.find({ "delivery.gatePassAt": {...} }), so a car still on the floor never enters its figures at
// all, and its "Revenue" tile is the pre-VAT value of APPROVED ESTIMATE LINES (rules.jobTotals), never
// reconciled against what was actually invoiced. Every report below is built to answer one honest question,
// and none of them silently treats "not costed" or "not yet invoiced" as zero.
const G = require("./garage");

const round2 = G.round2;
const idOf = G.idOf;
// A day out of whatever this field actually is: a real Date (a .lean() read gives one for every Date-typed
// schema field, Mongo's own $max included), or already a "YYYY-MM-DD" string (rules.serviceDue's own
// dueDay). String(aDate).slice(0,10) looks plausible and is wrong - it reads the JS Date's LOCALE string
// ("Sat Nov 14 2026 ...") and slices garbage out of it, which this file did at first and a database test
// caught (a registration due in 5 days was never listed; the pure tests fed it strings and never noticed).
const isoDay = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
// pct/avg are private to utils/garage.js (not exported), so they are repeated here verbatim - the same
// small-local-copy pattern used throughout this module set (e.g. useGarageReveal is a deliberate copy of
// useReveal). A rate with nothing to measure is null, never 0 - a shop must never be told it is "0%" of
// something it has not done yet.
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const avg = (list) => (list.length ? Math.round((list.reduce((t, x) => t + x, 0) / list.length) * 10) / 10 : null);

// ---- the previous period ---------------------------------------------------------------------------------
// The general rule services/reports/dashboardService.js's own previousOf falls back to when the range is not
// a whole calendar quarter or year: the same number of days just before. Deliberately NOT the quarter/year
// special-casing that function also does - a garage report comparing "this month" to "last month" is the
// common case, and the extra cases there exist for the home dashboard's own year-over-year framing, which
// this module does not need. Day-string arithmetic, UTC midnight, the same convention daysSince/ageBand use.
function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}
function previousPeriod(from, to) {
  if (!from || !to) return null;
  const span = daysBetween(from, to) + 1;
  const previousTo = addDays(from, -1);
  return { from: addDays(previousTo, -(span - 1)), to: previousTo };
}

// A figure beside the one before it, the way the Dashboard's own StatCard trend prop expects it: the change
// is null, never 0, when there is nothing to compare against (a shop that sold nothing last period is not
// "down 100%" from nothing - it is simply not comparable).
function trend(value, previous) {
  const v = Number(value) || 0;
  const p = previous == null ? null : Number(previous) || 0;
  return { value: v, previous: p, changePct: p ? round2(((v - p) / p) * 100) : null };
}

// ---- work in progress -------------------------------------------------------------------------------------
// What is on the floor RIGHT NOW, and what money is tangled up in it - the number bodyshop sources call the
// single most important one, because WIP drives scheduling and scheduling drives speed, and the one report
// the module never had at all (the old `analysis` only ever saw cars that had already left).
//
// `cards` is every LIVE job card (the same LIVE_STATUS set board() reads). `owedByCard` is a Map of
// jobCardId -> the REAL outstanding of its approved invoices (read from Transaction.outstandingAmount by the
// service - card.invoices[].amount is the invoice's GROSS total, not what is still owed on it).
function workInProgress(cards = [], { today, dayOf, owedByCard = new Map() } = {}) {
  const byStage = new Map();
  const byAge = new Map();
  const onHold = [];
  const rows = [];
  let estimated = 0;
  let approvedNotBilled = 0;
  let deliveredValue = 0;
  let deliveredCount = 0;
  let owed = 0;

  const stage = (status) => {
    if (!byStage.has(status)) byStage.set(status, { status, count: 0, value: 0 });
    return byStage.get(status);
  };
  const age = (band) => {
    if (!byAge.has(band)) byAge.set(band, { band, count: 0, value: 0 });
    return byAge.get(band);
  };

  for (const c of cards) {
    const totals = G.jobTotals(c); // approved lines only, pre-VAT - the estimate's own value
    const day = c.receivedAt ? dayOf(c.receivedAt) : null;
    const days = G.daysSince(day, today);
    const band = G.ageBand(days);

    estimated = round2(estimated + totals.total);
    approvedNotBilled = round2(approvedNotBilled + G.billableValue(c));
    if (c.status === "DELIVERED") {
      deliveredCount += 1;
      deliveredValue = round2(deliveredValue + totals.total);
    }

    const sRow = stage(c.status);
    sRow.count += 1;
    sRow.value = round2(sRow.value + totals.total);
    if (band) {
      const aRow = age(band);
      aRow.count += 1;
      aRow.value = round2(aRow.value + totals.total);
    }

    const open = G.currentTasks(c);
    const task = open[0] || null;
    if (task?.holdReason) {
      onHold.push({ jobCardId: idOf(c._id), jobNo: c.jobNo, taskName: task.name, holdReason: task.holdReason, daysIn: days });
    }

    const cardOwed = owedByCard.get(idOf(c._id)) || 0;
    owed = round2(owed + cardOwed);

    rows.push({
      jobCardId: idOf(c._id), jobNo: c.jobNo, status: c.status, jobType: c.jobType,
      plate: c.vehicle?.plateNumber || "", vehicle: [c.vehicle?.make, c.vehicle?.model].filter(Boolean).join(" "),
      customer: c.customer?.name || "", daysIn: days, ageBand: band, value: totals.total,
      invoiceStatus: c.invoiceStatus || "NONE", owed: round2(cardOwed),
    });
  }

  const STAGE_ORDER = ["DRAFT", "AWAITING_APPROVAL", "IN_PROGRESS", "READY", "DELIVERED"];
  const AGE_ORDER = ["u5", "b5_9", "b10_14", "o15"];
  return {
    asAt: today,
    value: {
      estimated, approvedNotBilled,
      deliveredNotInvoiced: { count: deliveredCount, value: deliveredValue },
      owed,
    },
    byStage: STAGE_ORDER.map((s) => byStage.get(s)).filter(Boolean),
    byAge: AGE_ORDER.map((a) => byAge.get(a)).filter(Boolean),
    onHold: onHold.sort((a, b) => b.daysIn - a.daysIn),
    rows: rows.sort((a, b) => b.daysIn - a.daysIn),
  };
}

// ---- profit -------------------------------------------------------------------------------------------
// Revenue against cost, per stream - the first question any workshop owner actually asks, and one the module
// could not answer at all before this: `analysis` has always had revenue by stream with no cost beside it.
//
// `costOf` is a Map of itemId -> the item's current weighted-average unit cost (Stock.purchasePrice), read
// by the service for every part/consumable line in the period. THIS IS THE HONEST LIMIT, STATED PLAINLY:
// it is the cost TODAY, not the cost at the moment of sale (the exact figure would need a join to each
// invoice's own InventoryMovement.cogsAmount, a second query path for a report whose whole point is one
// number people can trust at a glance) - so a part bought cheaper last month and still in a job this month
// reads at today's average, which is usually close but is a basis, not a ledger figure, and is labelled so.
// `labour` is `{ total, uncostedHours }` from the organisation's own labour rates (LabourCostService),
// AGGREGATE ONLY - this function is never handed a per-technician cost, which would publish one person's
// pay rate next to their name. Sublet has NO cost field anywhere in the schema (a sublet line stores only
// what we charge, never what the vendor charged us), so its cost is always null, never guessed at zero.
const STREAM_LABEL = { part: "Parts", labour: "Labour", sublet: "Sublet", consumable: "Consumables" };

function profit(cards = [], { costOf = new Map(), labour = { total: 0, uncostedHours: 0 } } = {}) {
  const revenue = Object.fromEntries(G.LINE_KINDS.map((k) => [k, 0]));
  let partsCostKnown = true;
  let partsCost = 0;
  for (const c of cards) {
    for (const l of G.approvedLines(c)) {
      const v = G.lineValue(l);
      revenue[l.kind] = round2((revenue[l.kind] || 0) + v);
      if (l.kind === "part" || l.kind === "consumable") {
        const unit = costOf.has(idOf(l.itemId)) ? Number(costOf.get(idOf(l.itemId))) || 0 : null;
        if (unit == null) partsCostKnown = false;
        partsCost = round2(partsCost + (Number(l.qty) || 0) * (unit || 0));
      }
    }
  }
  const revenueTotal = round2(G.LINE_KINDS.reduce((t, k) => t + (revenue[k] || 0), 0));
  const partsRevenue = round2((revenue.part || 0) + (revenue.consumable || 0));
  const partsMargin = partsCostKnown ? round2(partsRevenue - partsCost) : null;
  const labourCost = round2(Number(labour.total) || 0);
  const labourMargin = round2((revenue.labour || 0) - labourCost);
  const knownMargin = round2((partsCostKnown ? partsMargin : 0) + labourMargin);

  const streams = G.LINE_KINDS.map((k) => {
    if (k === "sublet") return { kind: k, label: STREAM_LABEL[k], revenue: revenue[k] || 0, cost: null, margin: null, basis: "not costed - no vendor cost is stored on a sublet line" };
    if (k === "labour") return { kind: k, label: STREAM_LABEL[k], revenue: revenue[k] || 0, cost: labourCost, margin: labourMargin, basis: labour.uncostedHours > 0 ? `${labour.uncostedHours} h with no contract rate not included in cost` : "the organisation's own labour rates" };
    // part / consumable: cost and margin are filled in below, once the combined parts cost is split
    // back across the two streams by revenue share - left null here only if that cost is unknown.
    return { kind: k, label: STREAM_LABEL[k], revenue: revenue[k] || 0, cost: null, margin: null, basis: "current average cost" };
  });
  // Parts and consumables share one cost figure (both are STOCKED_KINDS, costed the same way); split the
  // combined partsCost back across the two streams by their own share of parts+consumable revenue, so each
  // row's own cost/margin still reads sensibly without a second cost pass.
  if (partsCostKnown && partsRevenue > 0) {
    for (const row of streams) {
      if (row.kind !== "part" && row.kind !== "consumable") continue;
      const share = (revenue[row.kind] || 0) / partsRevenue;
      row.cost = round2(partsCost * share);
      row.margin = round2((revenue[row.kind] || 0) - row.cost);
    }
  } else if (partsCostKnown) {
    for (const row of streams) if (row.kind === "part" || row.kind === "consumable") { row.cost = 0; row.margin = 0; }
  }

  return {
    revenue: { ...revenue, total: revenueTotal },
    cost: { parts: partsCostKnown ? partsCost : null, labour: labourCost, sublet: null, basis: "current average cost for parts; the organisation's own labour rates for labour" },
    margin: { parts: partsMargin, labour: labourMargin, total: partsCostKnown ? knownMargin : null, marginPct: partsCostKnown && revenueTotal > 0 ? round2((knownMargin / revenueTotal) * 100) : null },
    uncostedLabourHours: Number(labour.uncostedHours) || 0,
    streams,
  };
}

// ---- people & bays --------------------------------------------------------------------------------------
// Hours sold against hours taken, by technician AND by bay - the board already stamps a task with bayId/
// bayName (bayModel.js's own comment claims this is how bay utilisation is worked out) and nothing ever read
// it back. One pass over the same DONE-task set analysis()'s own people map scans, grouped two ways at once
// so the two halves cannot disagree about which tasks counted.
function peopleAndBays(cards = [], { from, to, dayOf, bayKindOf = new Map() } = {}) {
  const inPeriod = (instant) => {
    if (!instant) return false;
    const d = dayOf(instant);
    return (!from || d >= from) && (!to || d <= to);
  };
  const people = new Map();
  const bays = new Map();
  const personOf = (t) => {
    const key = `${t.mode}:${idOf(t.staffId) || idOf(t.vendorId) || t.assigneeId || (t.mode === "sublet" ? t.vendorName : t.staffName) || "?"}`;
    const label = t.mode === "sublet" ? t.vendorName || "Job worker" : t.staffName || t.assigneeName || "Not assigned";
    if (!people.has(key)) people.set(key, { key, label, done: 0, standard: 0, actual: 0, wait: [] });
    return people.get(key);
  };
  const bayOf = (t) => {
    const key = idOf(t.bayId) || t.bayName || "unassigned";
    if (!bays.has(key)) bays.set(key, { bayId: idOf(t.bayId) || null, name: t.bayName || "No bay recorded", kind: bayKindOf.get(idOf(t.bayId)) || null, done: 0, standard: 0, actual: 0 });
    return bays.get(key);
  };
  for (const c of cards) {
    for (const t of c.tasks || []) {
      if (t.status !== "DONE" || !inPeriod(t.doneAt)) continue;
      const p = personOf(t);
      p.done += 1;
      p.standard = round2(p.standard + (Number(t.standardHours) || 0));
      p.actual = round2(p.actual + (Number(t.actualHours) || 0));
      const wait = t.readyAt && t.startedAt ? Math.max(0, (new Date(t.startedAt) - new Date(t.readyAt)) / 3.6e6) : null;
      if (wait != null) p.wait.push(wait);
      const b = bayOf(t);
      b.done += 1;
      b.standard = round2(b.standard + (Number(t.standardHours) || 0));
      b.actual = round2(b.actual + (Number(t.actualHours) || 0));
    }
  }
  return {
    period: { from: from || null, to: to || null },
    people: [...people.values()]
      .map((r) => ({ key: r.key, label: r.label, done: r.done, hoursSold: r.standard, hoursTaken: r.actual, efficiencyPct: pct(r.standard, r.actual), waitHours: avg(r.wait) }))
      .sort((a, b) => b.done - a.done || a.label.localeCompare(b.label)),
    bays: [...bays.values()]
      .map((r) => ({ bayId: r.bayId, name: r.name, kind: r.kind, jobsDone: r.done, hoursSold: r.standard, hoursTaken: r.actual, efficiencyPct: pct(r.standard, r.actual) }))
      .sort((a, b) => b.hoursTaken - a.hoursTaken || a.name.localeCompare(b.name)),
  };
}

// ---- customers -----------------------------------------------------------------------------------------
// Spend, visits and the average repair order per customer - built from the cards DELIVERED in the period
// (the same `finished` set `analysis` already defines, so the two reports' "delivered" count always agrees).
// `invoiced` reads card.invoices[] directly: jobCardLinks.js keeps `amount`/`status` on that array current
// with the real Transaction every time it changes, so no extra Transaction query is needed here at all.
function customerSummary(cards = []) {
  const map = new Map();
  for (const c of cards) {
    const key = idOf(c.customerId);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { customerId: key, name: c.customer?.name || "", jobs: 0, estimated: 0, invoiced: 0, first: null, last: null });
    const row = map.get(key);
    row.jobs += 1;
    row.estimated = round2(row.estimated + G.jobTotals(c).total);
    const invoicedHere = (c.invoices || []).filter((i) => i.status === "APPROVED").reduce((t, i) => t + (Number(i.amount) || 0), 0);
    row.invoiced = round2(row.invoiced + invoicedHere);
    const day = c.delivery?.gatePassAt ? isoDay(c.delivery.gatePassAt) : null;
    if (day && (!row.first || day < row.first)) row.first = day;
    if (day && (!row.last || day > row.last)) row.last = day;
  }
  const rows = [...map.values()]
    .map((r) => ({ ...r, avgInvoice: r.jobs ? round2(r.invoiced / r.jobs) : null, repeat: r.jobs > 1 }))
    .sort((a, b) => b.invoiced - a.invoiced || b.estimated - a.estimated);
  const totalJobs = rows.reduce((t, r) => t + r.jobs, 0);
  const totalInvoiced = round2(rows.reduce((t, r) => t + r.invoiced, 0));
  const repeatCustomers = rows.filter((r) => r.repeat).length;
  return {
    rows,
    summary: {
      customers: rows.length,
      repeatCustomers, repeatPct: pct(repeatCustomers, rows.length),
      averageRepairOrder: totalJobs ? round2(totalInvoiced / totalJobs) : null,
    },
  };
}

// ---- vehicles -------------------------------------------------------------------------------------------
// As at today - the fleet itself, what is due or expiring, and which cars come back the most. The registry
// (Vehicle) carries registrationExpiry and policyExpiry, both indexed and READ BY NOTHING until this report.
// `visits` is a Map of vehicleId -> { jobs, value, lastVisit } from one bounded aggregate the service runs
// over DELIVERED/CLOSED job cards - never computed per vehicle, which would be one query per car in the fleet.
function vehicleReport(vehicles = [], { today, visits = new Map(), insurerNameOf = new Map(), addMonths, dueWindowDays = 30 } = {}) {
  const dueBy = (day) => {
    if (!day) return null;
    const d = isoDay(day);
    const days = Math.round((new Date(`${d}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
    return { day: d, daysLeft: days, state: days < 0 ? "overdue" : days <= dueWindowDays ? "soon" : "later" };
  };
  const byMake = new Map();
  const registrationExpiring = [];
  const policyExpiring = [];
  const serviceDueList = [];
  const rows = [];
  for (const v of vehicles) {
    const make = v.make || "Unknown";
    byMake.set(make, (byMake.get(make) || 0) + 1);
    const visit = visits.get(idOf(v._id)) || { jobs: 0, value: 0, lastVisit: null };
    rows.push({ vehicleId: idOf(v._id), plate: v.plateNumber || "", make: v.make || "", model: v.model || "", customer: v.customerName || "", jobs: visit.jobs, value: visit.value, lastVisit: visit.lastVisit });

    const reg = dueBy(v.registrationExpiry);
    if (reg && reg.state !== "later") registrationExpiring.push({ vehicleId: idOf(v._id), plate: v.plateNumber || "", customer: v.customerName || "", ...reg });
    const pol = dueBy(v.policyExpiry);
    if (pol && pol.state !== "later") policyExpiring.push({ vehicleId: idOf(v._id), plate: v.plateNumber || "", customer: v.customerName || "", insurer: insurerNameOf.get(idOf(v.insurerId)) || "", ...pol });

    const km = Number(v.serviceInterval?.km) || 0;
    const months = Number(v.serviceInterval?.months) || 0;
    if (km > 0 || months > 0) {
      const due = G.serviceDue(v, { intervalKm: km, intervalMonths: months, lastServiceDay: v.lastServiceDay, lastServiceOdometer: v.lastServiceOdometer, addMonths });
      const dueDayState = due.dueDay ? dueBy(due.dueDay) : null;
      if ((dueDayState && dueDayState.state !== "later") || (due.dueOdometer && Number(v.odometer) >= due.dueOdometer)) {
        serviceDueList.push({ vehicleId: idOf(v._id), plate: v.plateNumber || "", customer: v.customerName || "", dueDay: due.dueDay, dueOdometer: due.dueOdometer, odometer: v.odometer || 0, overdue: Boolean((dueDayState && dueDayState.state === "overdue") || (due.dueOdometer && Number(v.odometer) >= due.dueOdometer)) });
      }
    }
  }
  return {
    asAt: today,
    fleet: {
      total: vehicles.length, active: vehicles.filter((v) => v.status !== "inactive").length,
      byMake: [...byMake.entries()].map(([make, count]) => ({ make, count })).sort((a, b) => b.count - a.count),
    },
    registrationExpiring: registrationExpiring.sort((a, b) => a.daysLeft - b.daysLeft),
    policyExpiring: policyExpiring.sort((a, b) => a.daysLeft - b.daysLeft),
    serviceDue: serviceDueList.sort((a, b) => Number(b.overdue) - Number(a.overdue)),
    topVisited: rows.filter((r) => r.jobs > 0).sort((a, b) => b.jobs - a.jobs || b.value - a.value).slice(0, 20),
  };
}

// ---- insurers -------------------------------------------------------------------------------------------
// Per insurer: what was claimed, what was approved, the shortfall the CUSTOMER ends up paying, the excess
// and depreciation borne, how long a decision took, and - the gap closed here - the REJECTION rate, which
// claimAgeing can never show because it deliberately filters rejected claims out (they are settled, not
// ageing). `claims` must therefore be EVERY claim of the period, status included, not insuranceClaimService
// .ageing's own LIVE_STATUS-only read. `jobByClaim` is the same job-card join claimAgeing's own caller
// already does (jobNo, estimate.total); `owedByClaim` is a Map of claimId -> real Transaction.outstanding
// for the insurer-billed invoices on claims that reached INVOICED.
function insurerSummary(claims = [], { jobByClaim = new Map(), owedByClaim = new Map(), splitBill } = {}) {
  const DECIDED = new Set(["APPROVED", "PARTLY_APPROVED", "REJECTED"]);
  const map = new Map();
  const row = (id, name) => {
    if (!map.has(id)) map.set(id, { insurerId: id, insurer: name, claims: 0, claimed: 0, approved: 0, rejected: 0, rejectedValue: 0, excess: 0, depreciation: 0, outstanding: 0, decideDays: [] });
    return map.get(id);
  };
  for (const c of claims) {
    const id = idOf(c.insurerId);
    if (!id) continue;
    const r = row(id, c.insurer?.name || "");
    const job = jobByClaim.get(idOf(c.jobCardId));
    const jobTotal = Number(job?.estimate?.total) || 0;
    r.claims += 1;
    if (c.status === "REJECTED") {
      r.rejected += 1;
      r.rejectedValue = round2(r.rejectedValue + jobTotal);
    } else if (DECIDED.has(c.status) || c.status === "INVOICED") {
      const split = splitBill(jobTotal, { approvedAmount: c.approval?.approvedAmount, excess: c.deductions?.excess, depreciationPct: c.deductions?.partsDepreciationPct, depreciablePartsAmount: c.deductions?.depreciablePartsAmount });
      r.claimed = round2(r.claimed + jobTotal);
      r.approved = round2(r.approved + split.approved);
      r.excess = round2(r.excess + (Number(c.deductions?.excess) || 0));
      r.depreciation = round2(r.depreciation + split.depreciationAmount);
    } else {
      // Not yet decided (DRAFT/SUBMITTED/SURVEYED): counted in `claims`, but has no money to add to
      // claimed/approved yet - the job's estimate is not a claim figure until the insurer has seen it.
    }
    if (c.submittedAt && (c.approval?.approvedAt || c.rejectedAt)) {
      const decided = c.approval?.approvedAt || c.rejectedAt;
      r.decideDays.push(Math.max(0, (new Date(decided) - new Date(c.submittedAt)) / 86400000));
    }
    r.outstanding = round2(r.outstanding + (owedByClaim.get(idOf(c._id)) || 0));
  }
  const rows = [...map.values()]
    .map((r) => ({
      insurerId: r.insurerId, insurer: r.insurer, claims: r.claims,
      claimed: r.claimed, approved: r.approved, shortfall: round2(r.claimed - r.approved),
      rejected: r.rejected, rejectedPct: pct(r.rejected, r.claims), rejectedValue: r.rejectedValue,
      excess: r.excess, depreciation: r.depreciation, outstanding: r.outstanding,
      avgDaysToDecide: avg(r.decideDays),
    }))
    .sort((a, b) => b.claimed - a.claimed);
  return {
    rows,
    totals: rows.reduce((t, r) => ({
      claims: t.claims + r.claims, claimed: round2(t.claimed + r.claimed), approved: round2(t.approved + r.approved),
      rejected: t.rejected + r.rejected, outstanding: round2(t.outstanding + r.outstanding),
    }), { claims: 0, claimed: 0, approved: 0, rejected: 0, outstanding: 0 }),
  };
}

module.exports = {
  STREAM_LABEL,
  addDays, daysBetween, previousPeriod, trend, isoDay,
  workInProgress, profit, peopleAndBays, customerSummary, vehicleReport, insurerSummary,
};
