// Pure rules of the garage's REPORTS (utils/garageReports.js): work in progress, profit by stream, people
// and bays, customers, vehicles, insurers. Each test hands the function plain data, the way the service
// will after its own query, so these run with no database at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../garageReports");

const L = (n) => String(n).repeat(24).slice(0, 24);
const dayOf = (instant) => new Date(instant).toISOString().slice(0, 10);
const addMonths = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(d, last));
  return date.toISOString().slice(0, 10);
};

// ---- the previous period --------------------------------------------------------------------------------

test("the previous period is the same number of days just before", () => {
  // October is 31 days; the 31 days just before 1 October straddle August too - this is the deliberately
  // simple fallback rule (not the quarter/year calendar-aligned special-casing dashboardService also has).
  assert.deepEqual(R.previousPeriod("2026-10-01", "2026-10-31"), { from: "2026-08-31", to: "2026-09-30" });
  // A single day compares with the single day before.
  assert.deepEqual(R.previousPeriod("2026-10-15", "2026-10-15"), { from: "2026-10-14", to: "2026-10-14" });
  assert.equal(R.previousPeriod(null, null), null);
});

test("a trend is null when there is nothing to compare against, never zero", () => {
  assert.deepEqual(R.trend(500, 0), { value: 500, previous: 0, changePct: null });
  assert.deepEqual(R.trend(500, null), { value: 500, previous: null, changePct: null });
  assert.deepEqual(R.trend(550, 500), { value: 550, previous: 500, changePct: 10 });
  assert.deepEqual(R.trend(0, 100), { value: 0, previous: 100, changePct: -100 });
});

// ---- work in progress ------------------------------------------------------------------------------------

test("work in progress: value on the floor by stage and age, money owed, jobs on hold", () => {
  const cards = [
    // In progress, received 12 days ago (band b10_14), one approved part line, a held task.
    {
      _id: L(1), jobNo: "JC-1", status: "IN_PROGRESS", jobType: "retail",
      vehicle: { plateNumber: "A 11111", make: "Toyota", model: "Hilux" }, customer: { name: "Ali" },
      receivedAt: "2026-10-20T08:00:00Z",
      lines: [{ kind: "part", qty: 1, price: 400, approved: true, invoiced: false }],
      tasks: [{ name: "Brakes", status: "IN_PROGRESS", holdReason: "Waiting for a part" }],
      invoiceStatus: "NONE",
    },
    // Delivered, not invoiced - the "money goes missing" case the board's own comment names.
    {
      _id: L(2), jobNo: "JC-2", status: "DELIVERED", jobType: "retail",
      vehicle: { plateNumber: "B 22222", make: "Nissan", model: "Patrol" }, customer: { name: "Sara" },
      receivedAt: "2026-10-30T08:00:00Z",
      lines: [{ kind: "labour", qty: 1, price: 300, approved: true, invoiced: false }],
      tasks: [], invoiceStatus: "NONE",
    },
  ];
  const owedByCard = new Map([[L(2), 150]]);
  const wip = R.workInProgress(cards, { today: "2026-11-01", dayOf, owedByCard });
  assert.equal(wip.asAt, "2026-11-01");
  assert.equal(wip.value.estimated, 700); // 400 + 300
  assert.equal(wip.value.approvedNotBilled, 700); // billableValue falls back to lineValue when no VAT stamped
  assert.deepEqual(wip.value.deliveredNotInvoiced, { count: 1, value: 300 });
  assert.equal(wip.value.owed, 150);
  assert.deepEqual(wip.byStage.map((s) => [s.status, s.count, s.value]), [["IN_PROGRESS", 1, 400], ["DELIVERED", 1, 300]]);
  assert.equal(wip.byAge.find((a) => a.band === "b10_14").count, 1); // card 1: 12 days
  assert.equal(wip.byAge.find((a) => a.band === "u5").count, 1); // card 2: 2 days
  assert.equal(wip.onHold.length, 1);
  assert.deepEqual([wip.onHold[0].jobNo, wip.onHold[0].holdReason], ["JC-1", "Waiting for a part"]);
  const row2 = wip.rows.find((r) => r.jobNo === "JC-2");
  assert.deepEqual([row2.value, row2.owed, row2.ageBand], [300, 150, "u5"]);
});

test("work in progress: a declined line is never counted, an empty workshop reports honest zeros", () => {
  const cards = [{
    _id: L(3), jobNo: "JC-3", status: "AWAITING_APPROVAL", jobType: "retail",
    vehicle: {}, customer: {}, receivedAt: "2026-11-01T08:00:00Z",
    lines: [{ kind: "part", qty: 1, price: 999, approved: false }],
    tasks: [], invoiceStatus: "NONE",
  }];
  const wip = R.workInProgress(cards, { today: "2026-11-01", dayOf });
  assert.equal(wip.value.estimated, 0);
  assert.equal(wip.value.approvedNotBilled, 0);
  const empty = R.workInProgress([], { today: "2026-11-01", dayOf });
  assert.deepEqual(empty.value, { estimated: 0, approvedNotBilled: 0, deliveredNotInvoiced: { count: 0, value: 0 }, owed: 0 });
  assert.deepEqual(empty.byStage, []);
  assert.deepEqual(empty.onHold, []);
});

// ---- profit -----------------------------------------------------------------------------------------------

test("profit: revenue against cost per stream, margin split back by revenue share", () => {
  const cards = [{
    _id: L(4),
    lines: [
      { kind: "part", itemId: L(10), qty: 2, price: 100, approved: true }, // revenue 200
      { kind: "consumable", itemId: L(11), qty: 1, price: 50, approved: true }, // revenue 50
      { kind: "labour", itemId: L(12), qty: 1, price: 300, approved: true }, // revenue 300
      { kind: "sublet", itemId: L(13), qty: 1, price: 150, approved: true }, // revenue 150
      { kind: "part", itemId: L(10), qty: 1, price: 100, approved: false }, // declined - must not count
    ],
  }];
  const costOf = new Map([[L(10), 60], [L(11), 20]]); // part cost 2x60=120, consumable cost 1x20=20 -> total 140
  const profit = R.profit(cards, { costOf, labour: { total: 180, uncostedHours: 0 } });
  assert.equal(profit.revenue.part, 200);
  assert.equal(profit.revenue.consumable, 50);
  assert.equal(profit.revenue.labour, 300);
  assert.equal(profit.revenue.sublet, 150);
  assert.equal(profit.revenue.total, 700);
  assert.equal(profit.cost.parts, 140);
  assert.equal(profit.cost.labour, 180);
  assert.equal(profit.margin.parts, 110); // 250 revenue (part+consumable) - 140 cost
  assert.equal(profit.margin.labour, 120); // 300 - 180
  assert.equal(profit.margin.total, 230); // 110 + 120, sublet excluded
  // Sublet carries no cost or margin at all - it is unknown, not zero.
  const sublet = profit.streams.find((s) => s.kind === "sublet");
  assert.equal(sublet.cost, null);
  assert.equal(sublet.margin, null);
  // The combined parts cost (140) splits back across part/consumable by their own revenue share (200:50).
  const part = profit.streams.find((s) => s.kind === "part");
  const consumable = profit.streams.find((s) => s.kind === "consumable");
  assert.equal(part.cost, 112); // 140 * 200/250
  assert.equal(consumable.cost, 28); // 140 * 50/250
});

test("profit: an unpriced part makes the parts margin null, never a wrong number", () => {
  const cards = [{ _id: L(5), lines: [{ kind: "part", itemId: L(99), qty: 1, price: 500, approved: true }] }];
  const profit = R.profit(cards, { costOf: new Map(), labour: { total: 0, uncostedHours: 0 } }); // no cost known for L(99)
  assert.equal(profit.cost.parts, null);
  assert.equal(profit.margin.parts, null);
  assert.equal(profit.margin.total, null); // the whole total is honest-unknown, not a partial guess
  const part = profit.streams.find((s) => s.kind === "part");
  assert.equal(part.cost, null);
});

test("profit: uncosted labour hours are named, never silently absorbed as free", () => {
  const cards = [{ _id: L(6), lines: [{ kind: "labour", itemId: L(1), qty: 1, price: 100, approved: true }] }];
  const profit = R.profit(cards, { labour: { total: 60, uncostedHours: 3 } });
  assert.equal(profit.uncostedLabourHours, 3);
  const labour = profit.streams.find((s) => s.kind === "labour");
  assert.match(labour.basis, /3 h with no contract rate/);
});

// ---- people & bays ----------------------------------------------------------------------------------------

test("people and bays: the same DONE tasks grouped two ways, by technician and by bay", () => {
  const cards = [
    {
      tasks: [
        { status: "DONE", doneAt: "2026-10-05T08:00:00Z", mode: "in_house", staffId: L(1), staffName: "Raj", standardHours: 2, actualHours: 2, bayId: L(20), bayName: "Ramp 1", readyAt: "2026-10-05T07:00:00Z", startedAt: "2026-10-05T07:30:00Z" },
        { status: "DONE", doneAt: "2026-10-06T08:00:00Z", mode: "sublet", vendorName: "ABC Paint", standardHours: 4, actualHours: 5, bayName: "Paint booth" },
        { status: "IN_PROGRESS", doneAt: null, mode: "in_house", staffId: L(1), standardHours: 1, actualHours: 1 }, // not DONE: excluded
      ],
    },
  ];
  const bayKindOf = new Map([[L(20), "mechanical"]]);
  const r = R.peopleAndBays(cards, { from: "2026-10-01", to: "2026-10-31", dayOf, bayKindOf });
  assert.equal(r.people.length, 2);
  const raj = r.people.find((p) => p.label === "Raj");
  assert.deepEqual([raj.done, raj.hoursSold, raj.hoursTaken, raj.efficiencyPct, raj.waitHours], [1, 2, 2, 100, 0.5]);
  const bays = r.bays;
  assert.equal(bays.length, 2);
  const ramp1 = bays.find((b) => b.name === "Ramp 1");
  assert.deepEqual([ramp1.kind, ramp1.jobsDone, ramp1.hoursTaken], ["mechanical", 1, 2]);
  const booth = bays.find((b) => b.name === "Paint booth");
  assert.equal(booth.kind, null); // no bayId on a sublet task - kind unknown, not guessed
});

// ---- customers ----------------------------------------------------------------------------------------

test("customers: spend, repeat visits, average repair order - from delivered cards only", () => {
  const cards = [
    { customerId: L(1), customer: { name: "Ali" }, lines: [{ kind: "part", qty: 1, price: 400, approved: true }], invoices: [{ status: "APPROVED", amount: 420 }], delivery: { gatePassAt: "2026-10-21T08:00:00Z" } },
    { customerId: L(1), customer: { name: "Ali" }, lines: [{ kind: "labour", qty: 1, price: 100, approved: true }], invoices: [{ status: "APPROVED", amount: 105 }], delivery: { gatePassAt: "2026-10-25T08:00:00Z" } },
    { customerId: L(2), customer: { name: "Sara" }, lines: [{ kind: "part", qty: 1, price: 1000, approved: true }], invoices: [{ status: "DRAFT", amount: 1050 }], delivery: { gatePassAt: "2026-10-20T08:00:00Z" } },
  ];
  const r = R.customerSummary(cards);
  assert.equal(r.summary.customers, 2);
  assert.equal(r.summary.repeatCustomers, 1); // Ali has two visits
  const ali = r.rows.find((c) => c.name === "Ali");
  assert.deepEqual([ali.jobs, ali.estimated, ali.invoiced, ali.first, ali.last], [2, 500, 525, "2026-10-21", "2026-10-25"]);
  const sara = r.rows.find((c) => c.name === "Sara");
  assert.equal(sara.invoiced, 0); // a draft invoice is not yet revenue
  // ARO is total invoiced / total jobs across every customer, not an average of per-customer averages.
  assert.equal(r.summary.averageRepairOrder, 175); // 525 invoiced over 3 jobs
});

// ---- vehicles -----------------------------------------------------------------------------------------

test("vehicles: registration and policy expiring, service due, fleet composition", () => {
  const vehicles = [
    { _id: L(1), plateNumber: "A 1", make: "Toyota", model: "Hilux", registrationExpiry: "2026-11-15T00:00:00Z", status: "active" },
    { _id: L(2), plateNumber: "B 2", make: "Toyota", model: "Corolla", policyExpiry: "2026-11-05T00:00:00Z", status: "active" },
    { _id: L(3), plateNumber: "C 3", make: "Nissan", model: "Patrol", serviceInterval: { km: 5000, months: 0 }, lastServiceOdometer: 10000, odometer: 15500, status: "active" },
  ];
  const r = R.vehicleReport(vehicles, { today: "2026-11-01", addMonths, dueWindowDays: 30 });
  assert.deepEqual(r.fleet.byMake, [{ make: "Toyota", count: 2 }, { make: "Nissan", count: 1 }]);
  assert.equal(r.registrationExpiring.length, 1);
  assert.equal(r.registrationExpiring[0].plate, "A 1");
  assert.equal(r.policyExpiring.length, 1);
  assert.equal(r.policyExpiring[0].plate, "B 2");
  // The Nissan is 500 km past its own due reading (10000 + 5000 = 15000, odometer is 15500) - overdue.
  assert.equal(r.serviceDue.length, 1);
  assert.deepEqual([r.serviceDue[0].plate, r.serviceDue[0].overdue], ["C 3", true]);
});

test("vehicles: a car with no interval set is never reported as service due", () => {
  const r = R.vehicleReport([{ _id: L(1), make: "Kia", model: "Rio", status: "active" }], { today: "2026-11-01", addMonths });
  assert.deepEqual(r.serviceDue, []);
});

// ---- insurers -----------------------------------------------------------------------------------------

const splitBill = require("../insuranceClaims").splitBill;

test("insurers: claimed vs approved, the shortfall, excess and depreciation, and rejection - visible, not filtered out", () => {
  const claims = [
    {
      _id: L(1), insurerId: L(90), insurer: { name: "Orient" }, jobCardId: L(1), status: "APPROVED",
      submittedAt: "2026-10-01T08:00:00Z",
      approval: { approvedAt: "2026-10-05T08:00:00Z", approvedAmount: 2000 },
      deductions: { excess: 500, partsDepreciationPct: 10, depreciablePartsAmount: 1000 },
    },
    {
      _id: L(2), insurerId: L(90), insurer: { name: "Orient" }, jobCardId: L(2), status: "REJECTED",
      submittedAt: "2026-10-10T08:00:00Z", rejectedAt: "2026-10-12T08:00:00Z",
    },
  ];
  const jobByClaim = new Map([[L(1), { estimate: { total: 3000 } }], [L(2), { estimate: { total: 800 } }]]);
  const r = R.insurerSummary(claims, { jobByClaim, splitBill });
  assert.equal(r.rows.length, 1);
  const orient = r.rows[0];
  assert.equal(orient.claims, 2);
  assert.equal(orient.claimed, 3000); // only the decided-with-money claim
  assert.equal(orient.approved, 2000);
  assert.equal(orient.shortfall, 1000);
  assert.equal(orient.excess, 500);
  assert.equal(orient.depreciation, 100); // 1000 * 10%
  // THE GAP CLOSED HERE: the rejected claim is counted and its value is visible, unlike claimAgeing.
  assert.equal(orient.rejected, 1);
  assert.equal(orient.rejectedPct, 50);
  assert.equal(orient.rejectedValue, 800);
  // Both claims had a decision: the approval took 4 days, the rejection took 2 - averaged across both,
  // because "how long did a decision take" is true of a rejection as much as an approval.
  assert.equal(orient.avgDaysToDecide, 3);
  assert.deepEqual(r.totals, { claims: 2, claimed: 3000, approved: 2000, rejected: 1, outstanding: 0 });
});

test("insurers: a claim not yet decided contributes no money, only a count", () => {
  const claims = [{ _id: L(1), insurerId: L(90), insurer: { name: "Orient" }, jobCardId: L(1), status: "SUBMITTED", submittedAt: "2026-10-01T08:00:00Z" }];
  const r = R.insurerSummary(claims, { jobByClaim: new Map([[L(1), { estimate: { total: 3000 } }]]), splitBill });
  assert.deepEqual([r.rows[0].claims, r.rows[0].claimed, r.rows[0].approved], [1, 0, 0]);
});
