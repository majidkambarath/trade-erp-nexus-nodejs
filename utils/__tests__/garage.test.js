// Pure rules of the garage job card (utils/garage.js): validation, the estimate and what was approved, tasks in
// parallel stages, handing the car back, warranty and comebacks, the board and the workshop's own numbers.
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../garage");

const V = "a".repeat(24), C = "b".repeat(24), I = "c".repeat(24), S = "d".repeat(24);
const L = (n) => String(n).repeat(24).slice(0, 24);

// Calendar helpers injected the way the service injects the organisation's own: no clock in the rules.
const addMonths = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(d, last));
  return date.toISOString().slice(0, 10);
};
const dayOf = (instant) => new Date(instant).toISOString().slice(0, 10);

const card = (over = {}) => ({
  vehicleId: V,
  customerId: C,
  jobType: "retail",
  complaints: [{ concern: "Wiper not working" }],
  lines: [],
  tasks: [],
  ...over,
});
const codes = (c) => G.validateJobCard(c).map((e) => e.code);
const vcodes = (v) => G.validateVehicle(v).map((e) => e.code);

// ---- the vehicle ---------------------------------------------------------------------------------------

test("a plate is matched on its letters and digits alone, however it was typed", () => {
  assert.equal(G.plateKey("A 12345"), "A12345");
  assert.equal(G.plateKey("a-12345"), "A12345");
  assert.equal(G.plateKey(" A12345 "), "A12345");
  assert.equal(G.plateKey(null), "");
  // The three spellings a UAE workshop will really receive for one car all find each other.
  const typed = ["A 12345", "A-12345", "a12345"];
  assert.equal(new Set(typed.map(G.plateKey)).size, 1);
  assert.equal(G.chassisKey("jtdbr32e-x70123456"), "JTDBR32EX70123456");
});

test("validateVehicle: a plate or a chassis, a make and a model; a year and an odometer must be real", () => {
  const ok = { plateNumber: "A 12345", make: "Toyota", model: "Hilux", year: 2019, odometer: 84000 };
  assert.deepEqual(vcodes(ok), []);
  // A brand-new car with no plate yet is identified by its chassis instead - a real case at a dealership.
  assert.deepEqual(vcodes({ ...ok, plateNumber: "", chassisNo: "JTDBR32E870123456" }), []);
  assert.deepEqual(vcodes({ ...ok, plateNumber: "", chassisNo: "" }), ["PLATE_OR_CHASSIS_REQUIRED"]);
  assert.deepEqual(vcodes({ ...ok, make: "" }), ["MAKE_REQUIRED"]);
  assert.deepEqual(vcodes({ ...ok, model: "" }), ["MODEL_REQUIRED"]);
  assert.deepEqual(vcodes({ ...ok, year: 19 }), ["INVALID_YEAR"]);
  assert.deepEqual(vcodes({ ...ok, odometer: -1 }), ["INVALID_ODOMETER"]);
  // Blank is not wrong: a workshop often does not know the year of an old car.
  assert.deepEqual(vcodes({ ...ok, year: "", odometer: "" }), []);
});

// ---- the job card --------------------------------------------------------------------------------------

test("validateJobCard: a vehicle, a customer and the customer's own words", () => {
  assert.deepEqual(codes(card()), []);
  assert.deepEqual(codes(card({ vehicleId: "" })), ["VEHICLE_REQUIRED"]);
  assert.deepEqual(codes(card({ customerId: "" })), ["CUSTOMER_REQUIRED"]);
  // The complaint is the one thing a job card may not be opened without: it is what the customer asked for.
  assert.deepEqual(codes(card({ complaints: [] })), ["COMPLAINTS_REQUIRED"]);
  assert.deepEqual(codes(card({ complaints: [{ concern: "   " }] })), ["CONCERN_REQUIRED"]);
  assert.deepEqual(codes(card({ jobType: "barter" })), ["INVALID_JOB_TYPE"]);
});

test("validateJobCard: lines need a kind, an item, a quantity and a price; sublet needs who it goes to", () => {
  const line = { kind: "part", itemId: I, qty: 1, price: 50 };
  assert.deepEqual(codes(card({ lines: [line] })), []);
  assert.deepEqual(codes(card({ lines: [{ ...line, kind: "misc" }] })), ["INVALID_LINE_KIND"]);
  assert.deepEqual(codes(card({ lines: [{ ...line, itemId: "" }] })), ["LINE_ITEM_REQUIRED"]);
  assert.deepEqual(codes(card({ lines: [{ ...line, qty: 0 }] })), ["INVALID_QTY"]);
  assert.deepEqual(codes(card({ lines: [{ ...line, price: -1 }] })), ["INVALID_PRICE"]);
  assert.deepEqual(codes(card({ lines: [{ ...line, kind: "sublet" }] })), ["SUBLET_VENDOR_REQUIRED"]);
  // A price of zero is allowed: goodwill work and warranty jobs are billed at nothing.
  assert.deepEqual(codes(card({ lines: [{ ...line, price: 0 }] })), []);
});

test("validateJobCard: a task needs a name, a mode and a whole-numbered stage", () => {
  const task = { name: "Replace wiper motor", mode: "in_house", stage: 1, standardHours: 1.5 };
  assert.deepEqual(codes(card({ tasks: [task] })), []);
  assert.deepEqual(codes(card({ tasks: [{ ...task, name: "" }] })), ["TASK_NAME_REQUIRED"]);
  assert.deepEqual(codes(card({ tasks: [{ ...task, mode: "magic" }] })), ["INVALID_MODE"]);
  assert.deepEqual(codes(card({ tasks: [{ ...task, mode: "sublet" }] })), ["SUBLET_VENDOR_REQUIRED"]);
  assert.deepEqual(codes(card({ tasks: [{ ...task, stage: 1.5 }] })), ["INVALID_STAGE"]);
  assert.deepEqual(codes(card({ tasks: [{ ...task, standardHours: -1 }] })), ["INVALID_HOURS"]);
  // No stage given means stage 1, which is the mechanical case: everything can start at once.
  assert.deepEqual(codes(card({ tasks: [{ name: "Oil change", mode: "in_house" }] })), []);
});

// ---- the estimate --------------------------------------------------------------------------------------

test("a line's value is quantity x price less its discount, by percent or by amount", () => {
  assert.equal(G.lineValue({ qty: 2, price: 150 }), 300);
  assert.equal(G.lineValue({ qty: 2, price: 150, discountPercent: 10 }), 270);
  assert.equal(G.lineValue({ qty: 2, price: 150, discountAmount: 50 }), 250);
  // A percentage wins over an amount, so a form that leaves a stale amount behind cannot discount twice.
  assert.equal(G.lineValue({ qty: 2, price: 150, discountPercent: 10, discountAmount: 50 }), 270);
  // A discount bigger than the line cannot turn into income.
  assert.equal(G.lineValue({ qty: 1, price: 100, discountAmount: 500 }), 0);
});

test("the total splits into the four streams the owner reads, and counts only what was approved", () => {
  const c = {
    lines: [
      { kind: "part", qty: 1, price: 400 },
      { kind: "part", qty: 2, price: 50 },
      { kind: "labour", qty: 2, price: 120 },
      { kind: "sublet", qty: 1, price: 300 },
      { kind: "consumable", qty: 1, price: 25 },
      { kind: "labour", qty: 1, price: 900, approved: false },
    ],
  };
  const t = G.jobTotals(c);
  assert.deepEqual([t.part, t.labour, t.sublet, t.consumable], [500, 240, 300, 25]);
  assert.equal(t.total, 1065);
  assert.equal(t.declined, 1);
  // The declined air-conditioning job is on the card and out of the money, which is the whole point.
  assert.equal(G.jobTotals(c, { approvedOnly: false }).total, 1965);
});

test("a line with no approval flag counts as approved: a whole estimate is not twenty ticks", () => {
  const c = { lines: [{ kind: "part", qty: 1, price: 100 }, { kind: "labour", qty: 1, price: 100 }] };
  assert.equal(G.approvedLines(c).length, 2);
  assert.equal(G.jobTotals(c).total, 200);
});

test("a supplementary estimate is a new VERSION of the same card, and stamps the lines it added", () => {
  const first = G.planEstimate({ lines: [{ kind: "part", qty: 1, price: 100 }] }, { now: "2026-10-26T08:00:00Z", by: "u1" });
  assert.equal(first.version, 1);
  assert.equal(first.lines[0].addedInVersion, 1);
  assert.equal(first.estimate.total, 100);

  // Teardown finds more. The old line keeps the version it came in on; only the new one is stamped 2.
  const second = G.planEstimate(
    { estimate: { version: 1 }, lines: [...first.lines, { kind: "part", qty: 1, price: 250 }] },
    { now: "2026-10-27T08:00:00Z", by: "u1" }
  );
  assert.equal(second.version, 2);
  assert.deepEqual(second.lines.map((l) => l.addedInVersion), [1, 2]);
  assert.equal(second.estimate.total, 350);
  // A new version has not been decided yet, whatever the old one said.
  assert.equal(second.estimate.decidedAt, null);
});

test("an approval says how it was given; an insurer's LPO number is never blank", () => {
  const c = { lines: [{ _id: L(1) }, { _id: L(2) }] };
  assert.equal(G.checkApproval({ method: "whatsapp" }, c), null);
  assert.equal(G.checkApproval({ method: "shouted" }, c).code, "INVALID_APPROVAL_METHOD");
  assert.equal(G.checkApproval({ method: "lpo" }, c).code, "APPROVAL_REFERENCE_REQUIRED");
  assert.equal(G.checkApproval({ method: "lpo", reference: "LPO-99112" }, c), null);
  // Partial approval: only lines that are really on this card.
  assert.equal(G.checkApproval({ method: "call", lineIds: [L(1)] }, c), null);
  assert.equal(G.checkApproval({ method: "call", lineIds: [L(9)] }, c).code, "LINE_NOT_ON_CARD");
  assert.equal(G.checkApproval({ method: "call", lineIds: [] }, c).code, "NOTHING_APPROVED");
});

// ---- tasks in parallel stages --------------------------------------------------------------------------

test("tasks in one stage run together: everything is ready at once when nobody set a stage", () => {
  const tasks = G.release([{ name: "Brakes", mode: "in_house" }, { name: "Air conditioning", mode: "in_house" }], "T0");
  assert.deepEqual(tasks.map((t) => [t.seq, t.stage, t.status]), [[1, 1, "READY"], [2, 1, "READY"]]);
  assert.equal(tasks[0].readyAt, "T0");
});

test("a body job is a chain: the next stage opens only when every task in this one is settled", () => {
  let tasks = G.release([
    { name: "Strip", mode: "in_house", stage: 1 },
    { name: "Panel", mode: "in_house", stage: 2 },
    { name: "Paint", mode: "sublet", stage: 2 },
    { name: "Rebuild", mode: "in_house", stage: 3 },
  ], "T0");
  assert.deepEqual(tasks.map((t) => t.status), ["READY", "WAITING", "WAITING", "WAITING"]);

  tasks[0].status = "DONE";
  tasks = G.advance(tasks, "T1");
  // Both stage-2 tasks open together - the panel beater and the painter are not made to queue.
  assert.deepEqual(tasks.map((t) => t.status), ["DONE", "READY", "READY", "WAITING"]);
  assert.equal(tasks[1].readyAt, "T1");

  // One of the two finishing does NOT open stage 3.
  tasks[1].status = "DONE";
  tasks = G.advance(tasks, "T2");
  assert.deepEqual(tasks.map((t) => t.status), ["DONE", "DONE", "READY", "WAITING"]);

  tasks[2].status = "DONE";
  tasks = G.advance(tasks, "T3");
  assert.deepEqual(tasks.map((t) => t.status), ["DONE", "DONE", "DONE", "READY"]);
});

test("a skipped task does not wedge its stage: a declined job must not hold the car", () => {
  let tasks = G.release([{ name: "Brakes", mode: "in_house", stage: 1 }, { name: "AC", mode: "in_house", stage: 1 }, { name: "Road test", mode: "in_house", stage: 2 }], "T0");
  tasks[0].status = "DONE";
  tasks[1].status = "SKIPPED"; // the customer declined the air conditioning after the card was released
  tasks = G.advance(tasks, "T1");
  assert.equal(tasks[2].status, "READY");
  assert.equal(G.allTasksSettled({ tasks }), false); // the road test is still open
  tasks[2].status = "DONE";
  assert.equal(G.allTasksSettled({ tasks }), true);
});

test("completing a task: it must be open, and the hours must be a real number", () => {
  assert.equal(G.checkCompletion({ status: "READY" }, { actualHours: 2 }), null);
  assert.equal(G.checkCompletion({ status: "IN_PROGRESS" }, {}), null);
  assert.equal(G.checkCompletion({ status: "WAITING" }, {}).code, "TASK_NOT_OPEN");
  assert.equal(G.checkCompletion({ status: "DONE" }, {}).code, "TASK_NOT_OPEN");
  assert.equal(G.checkCompletion(null, {}).code, "TASK_NOT_FOUND");
  assert.equal(G.checkCompletion({ status: "READY" }, { actualHours: -2 }).code, "INVALID_HOURS");
});

test("hours promised against hours taken", () => {
  const c = { tasks: [{ standardHours: 2, actualHours: 1.5 }, { standardHours: 1, actualHours: 2 }] };
  assert.deepEqual(G.taskHours(c), { standard: 3, actual: 3.5 });
});

// ---- handing the car back ------------------------------------------------------------------------------

test("the gate pass is refused while money is owed, unless it is on account or overridden", () => {
  const done = { status: "READY", tasks: [{ status: "DONE" }] };
  assert.deepEqual(G.mayRelease(done, { outstanding: 0 }), { ok: true });
  const owed = G.mayRelease(done, { outstanding: 1065 });
  assert.equal(owed.code, "PAYMENT_DUE");
  assert.equal(owed.details.outstanding, 1065);
  // A fleet customer on credit, and a manager's override, both get the car out.
  assert.equal(G.mayRelease(done, { outstanding: 1065, onAccount: true }).ok, true);
  assert.equal(G.mayRelease(done, { outstanding: 1065, mayOverride: true }).ok, true);
});

test("the gate pass is refused while work is open, when cancelled, and twice", () => {
  assert.equal(G.mayRelease({ status: "IN_PROGRESS", tasks: [{ status: "READY" }] }, {}).code, "WORK_NOT_FINISHED");
  assert.equal(G.mayRelease({ status: "CANCELLED", tasks: [] }, {}).code, "JOB_CANCELLED");
  assert.equal(G.mayRelease({ status: "DELIVERED", tasks: [{ status: "DONE" }], delivery: { gatePassAt: "X" } }, {}).code, "ALREADY_RELEASED");
  // A card with no tasks at all (a pure parts sale over the counter) is releasable.
  assert.equal(G.mayRelease({ status: "READY", tasks: [] }, {}).ok, true);
});

// ---- warranty and comebacks ----------------------------------------------------------------------------

test("a repair's warranty runs on months and kilometres together", () => {
  const w = G.warrantyUntil({ deliveredDay: "2026-10-26", odometerOut: 84000, months: 3, kilometres: 5000 }, { addMonths });
  assert.deepEqual(w, { until: "2027-01-26", untilOdometer: 89000 });
  // Either half alone is allowed; neither means no warranty, not a warranty of zero.
  assert.deepEqual(G.warrantyUntil({ deliveredDay: "2026-10-26", months: 6 }, { addMonths }), { until: "2027-04-26", untilOdometer: null });
  assert.deepEqual(G.warrantyUntil({ deliveredDay: "2026-10-26" }, { addMonths }), { until: null, untilOdometer: null });
  // 31 January plus one month is 28 February, not 3 March.
  assert.equal(G.warrantyUntil({ deliveredDay: "2027-01-31", months: 1 }, { addMonths }).until, "2027-02-28");
});

test("a comeback is offered, never decided: whichever half of the warranty still holds", () => {
  const jobs = [
    { _id: L(1), jobNo: "JC-2026-0001", warranty: { until: "2027-01-26", untilOdometer: 89000 }, tasks: [{ name: "Replace brake pads" }] },
    { _id: L(2), jobNo: "JC-2026-0002", warranty: { until: "2026-09-01", untilOdometer: 70000 }, tasks: [] },
    { _id: L(3), jobNo: "JC-2026-0003", warranty: {}, tasks: [] },
  ];
  const at = (odometer) => G.comebackCandidates(jobs, { today: "2026-10-26", odometer, dayOf }).map((c) => c.jobNo);
  assert.deepEqual(at(85000), ["JC-2026-0001"]);
  // Past the kilometres but inside the months: still a candidate, because either half holding is enough.
  assert.deepEqual(at(95000), ["JC-2026-0001"]);
  // A job whose warranty has run out both ways, and one that never had one, are not offered.
  assert.equal(at(85000).includes("JC-2026-0002"), false);
  assert.equal(at(85000).includes("JC-2026-0003"), false);
  assert.deepEqual(G.comebackCandidates(jobs, { today: "2026-10-26", odometer: 85000, dayOf })[0].work, ["Replace brake pads"]);
});

test("the next service is due on a date or a reading, whichever comes first", () => {
  const due = G.serviceDue({ odometer: 84000 }, { intervalKm: 10000, intervalMonths: 6, lastServiceDay: "2026-10-26", lastServiceOdometer: 84000, addMonths });
  assert.deepEqual(due, { dueDay: "2027-04-26", dueOdometer: 94000 });
  // The setting being off gives null, never a date that reads as "due now".
  assert.deepEqual(G.serviceDue({ odometer: 84000 }, { addMonths }), { dueDay: null, dueOdometer: null });
});

// ---- the board -----------------------------------------------------------------------------------------

const boardCards = [
  { _id: L(1), jobNo: "JC-1", status: "AWAITING_APPROVAL", vehicle: { plateNumber: "A 11111", make: "Toyota", model: "Hilux" }, customer: { name: "Ali" }, tasks: [], promisedAt: "2026-10-25T00:00:00Z", estimate: { total: 500 } },
  { _id: L(2), jobNo: "JC-2", status: "IN_PROGRESS", vehicle: { plateNumber: "B 22222" }, customer: { name: "Sara" }, promisedAt: "2026-10-26T00:00:00Z", tasks: [{ _id: L(7), name: "Brakes", mode: "in_house", stage: 1, status: "IN_PROGRESS", assigneeId: "tech1", staffName: "Raj" }] },
  { _id: L(3), jobNo: "JC-3", status: "READY", vehicle: { plateNumber: "C 33333" }, customer: { name: "Omar" }, promisedAt: "2026-10-27T00:00:00Z", tasks: [{ name: "Service", mode: "in_house", status: "DONE", doneAt: "2026-10-26T09:00:00Z" }] },
  { _id: L(4), jobNo: "JC-4", status: "DELIVERED", vehicle: { plateNumber: "D 44444" }, customer: { name: "Zayn" }, tasks: [], invoiceStatus: "NONE" },
  { _id: L(5), jobNo: "JC-5", status: "CLOSED", vehicle: { plateNumber: "E 55555" }, customer: { name: "Gone" }, tasks: [] },
];
const B = () => G.board(boardCards, { today: "2026-10-26", tomorrow: "2026-10-27", dayOf, me: "tech1" });

test("the board shows what is in the workshop, and leaves closed jobs out", () => {
  const b = B();
  assert.equal(b.counts.jobs, 4); // the CLOSED one is gone
  assert.deepEqual(
    [b.counts.awaitingApproval, b.counts.inProgress, b.counts.ready, b.counts.deliveredNotInvoiced],
    [1, 1, 1, 1]
  );
  assert.equal(b.counts.doneToday, 1);
  assert.deepEqual([b.counts.overdue, b.counts.dueToday, b.counts.dueTomorrow], [1, 1, 1]);
});

test("the board's columns are what is actually holding each car up", () => {
  const names = B().columns.map((c) => c.name);
  // Waiting for approval comes first (a car sitting untouched), the two end states last.
  assert.equal(names[0], "Waiting for approval");
  assert.deepEqual(names.slice(-2), ["Ready for collection", "Delivered, not invoiced"]);
  assert.ok(names.includes("Brakes"));
});

test("a technician's own work is picked out of the board", () => {
  const mine = B().mine;
  assert.deepEqual(mine.map((c) => c.jobNo), ["JC-2"]);
  assert.equal(mine[0].who, "Raj");
  // Somebody else's board has nothing of theirs on it.
  assert.equal(G.board(boardCards, { today: "2026-10-26", tomorrow: "2026-10-27", dayOf, me: "tech9" }).mine.length, 0);
});

// ---- analysis ------------------------------------------------------------------------------------------

test("the workshop's numbers: revenue by stream, efficiency, effective rate, comebacks", () => {
  const cards = [
    {
      _id: L(1), receivedAt: "2026-10-20T08:00:00Z", promisedAt: "2026-10-21T00:00:00Z",
      delivery: { gatePassAt: "2026-10-21T08:00:00Z" },
      lines: [{ kind: "part", qty: 1, price: 400 }, { kind: "labour", qty: 1, price: 300 }],
      tasks: [{ status: "DONE", doneAt: "2026-10-21T07:00:00Z", mode: "in_house", staffId: S, staffName: "Raj", standardHours: 3, actualHours: 2, readyAt: "2026-10-20T09:00:00Z", startedAt: "2026-10-20T10:00:00Z" }],
    },
    {
      _id: L(2), receivedAt: "2026-10-22T08:00:00Z", promisedAt: "2026-10-22T00:00:00Z",
      delivery: { gatePassAt: "2026-10-23T08:00:00Z" }, comebackOf: L(1),
      lines: [{ kind: "labour", qty: 1, price: 100 }],
      tasks: [{ status: "DONE", doneAt: "2026-10-23T07:00:00Z", mode: "in_house", staffId: S, staffName: "Raj", standardHours: 1, actualHours: 2 }],
    },
  ];
  const a = G.analysis(cards, { from: "2026-10-01", to: "2026-10-31", dayOf });
  assert.equal(a.jobs.delivered, 2);
  assert.deepEqual([a.jobs.revenue.part, a.jobs.revenue.labour, a.jobs.revenue.total], [400, 400, 800]);
  assert.equal(a.jobs.avgInvoice, 400);
  // 4 hours sold against 4 taken.
  assert.deepEqual([a.jobs.hoursSold, a.jobs.hoursTaken, a.jobs.efficiencyPct], [4, 4, 100]);
  // 400 of labour earned over 4 hours actually worked.
  assert.equal(a.jobs.effectiveLabourRate, 100);
  // One of the two was late, and one was a comeback.
  assert.deepEqual([a.jobs.withPromise, a.jobs.onTime, a.jobs.onTimePct], [2, 1, 50]);
  assert.deepEqual([a.jobs.comebacks, a.jobs.comebackPct], [1, 50]);
  assert.equal(a.jobs.avgTurnaroundHours, 24); // both cars took exactly a day
  // Per technician: Raj sold 4 and took 4, and waited an hour to start the first job.
  assert.equal(a.people.length, 1);
  assert.deepEqual([a.people[0].label, a.people[0].done, a.people[0].efficiencyPct, a.people[0].waitHours], ["Raj", 2, 100, 1]);
});

test("a rate with nothing to measure is null, never zero", () => {
  const a = G.analysis([], { from: "2026-10-01", to: "2026-10-31", dayOf });
  assert.equal(a.jobs.delivered, 0);
  assert.equal(a.jobs.efficiencyPct, null);
  assert.equal(a.jobs.effectiveLabourRate, null);
  assert.equal(a.jobs.onTimePct, null);
  assert.equal(a.jobs.comebackPct, null);
  assert.equal(a.jobs.avgTurnaroundHours, null);
  // A shop that sold hours it has not measured is not reported as 0% efficient.
  const unmeasured = G.analysis(
    [{ delivery: { gatePassAt: "2026-10-21T08:00:00Z" }, lines: [], tasks: [{ status: "DONE", doneAt: "2026-10-21T07:00:00Z", mode: "in_house", staffName: "Raj", standardHours: 3 }] }],
    { from: "2026-10-01", to: "2026-10-31", dayOf }
  );
  assert.equal(unmeasured.jobs.hoursTaken, 0);
  assert.equal(unmeasured.jobs.efficiencyPct, null);
});
