// Pure rules of process orders (utils/processOrders.js): validation, steps one after another, and the owner's board.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../processOrders");

const F = "f".repeat(24), R = "a".repeat(24), V = "c".repeat(24);
const input = (over = {}) => ({
  finished: { stockId: F, qty: 100 },
  materials: [{ stockId: R, qty: 100 }],
  steps: [{ name: "Cutting", mode: "in_house" }, { name: "Painting", mode: "job_work", jobWorkerId: V }, { name: "Packing", mode: "in_house" }],
  ...over,
});
const codes = (i) => P.validateOrder(i).map((e) => e.code);

test("validateOrder: a product, a quantity, and named steps; a job-work step needs a job worker and a material", () => {
  assert.deepEqual(codes(input()), []);
  assert.deepEqual(codes(input({ steps: [] })), ["STEPS_REQUIRED"]);
  assert.deepEqual(codes(input({ steps: [{ name: "", mode: "in_house" }] })), ["STEP_NAME_REQUIRED"]);
  assert.deepEqual(codes(input({ steps: [{ name: "Painting", mode: "job_work" }] })), ["JOB_WORKER_REQUIRED"]);
  assert.deepEqual(codes(input({ materials: [], steps: [{ name: "Painting", mode: "job_work", jobWorkerId: V }] })), ["MATERIAL_REQUIRED"]);
  assert.deepEqual(codes(input({ materials: [{ stockId: F, qty: 1 }] })), ["MATERIAL_IS_FINISHED_ITEM"]);
  assert.deepEqual(codes(input({ finished: { stockId: F, qty: 0 } })), ["INVALID_QTY"]);
});

test("steps go one after another, each with what came out of the one before", () => {
  let steps = P.release(input().steps, 100);
  assert.deepEqual(steps.map((s) => [s.seq, s.status, s.plannedQty]), [[1, "READY", 100], [2, "WAITING", 100], [3, "WAITING", 100]]);
  assert.equal(P.checkCompletion(steps[0], { qtyDone: 96, qtyRejected: 5 }).code, "MORE_THAN_PLANNED");
  assert.equal(P.checkCompletion(steps[0], { qtyDone: 0 }).code, "INVALID_QTY");
  assert.equal(P.checkCompletion(steps[0], { qtyDone: 96, qtyRejected: 4 }), null);
  steps[0] = { ...steps[0], status: "DONE", qtyDone: 96, qtyRejected: 4 };
  steps = P.advance(steps, 0);
  assert.deepEqual(steps.map((s) => [s.status, s.plannedQty]), [["DONE", 100], ["READY", 96], ["WAITING", 100]]);
  const order = { status: "OPEN", steps };
  assert.equal(P.currentStep(order).name, "Painting");
  assert.equal(P.allDone(order), false);
  const done = { status: "OPEN", steps: steps.map((s) => ({ ...s, status: "DONE", qtyDone: 90 })) };
  assert.equal(P.allDone(done), true);
  assert.equal(P.currentStep(done), null);
  assert.equal(P.finishedQty(done), 90, "the good units out of the last step");
});

test("dueState: overdue, today, tomorrow, later", () => {
  assert.equal(P.dueState("2026-10-17", "2026-10-18", "2026-10-19"), "overdue");
  assert.equal(P.dueState("2026-10-18", "2026-10-18", "2026-10-19"), "today");
  assert.equal(P.dueState("2026-10-19", "2026-10-18", "2026-10-19"), "tomorrow");
  assert.equal(P.dueState("2026-10-25", "2026-10-18", "2026-10-19"), "later");
  assert.equal(P.dueState(null, "2026-10-18", "2026-10-19"), "none");
});

test("the board: counts, a column per step where each open order is, the late and the due, and my own list", () => {
  const day = (d) => d;
  const st = (name, status, due, extra = {}) => ({ _id: name + status, seq: extra.seq || 1, name, status, dueDate: due, mode: "in_house", plannedQty: 10, ...extra });
  const orders = [
    { _id: "o1", processNo: "PRO-1", status: "OPEN", finished: { itemName: "Holder", qty: 10 }, steps: [st("Cutting", "DONE", "2026-10-15", { doneAt: "2026-10-18" }), st("Bending", "IN_PROGRESS", "2026-10-17", { seq: 2, assigneeId: "me", assigneeName: "Ravi" })] },
    { _id: "o2", processNo: "PRO-2", status: "OPEN", finished: { itemName: "Holder", qty: 5 }, steps: [st("Cutting", "READY", "2026-10-18")] },
    { _id: "o3", processNo: "PRO-3", status: "OPEN", finished: { itemName: "Bracket", qty: 5 }, steps: [st("Painting", "IN_PROGRESS", "2026-10-19", { mode: "job_work", jobWorkerName: "Shine" })] },
    { _id: "o4", processNo: "PRO-4", status: "OPEN", finished: { itemName: "Bracket", qty: 5 }, steps: [st("Packing", "DONE", null, { qtyDone: 5 })] },
    { _id: "o5", processNo: "PRO-5", status: "COMPLETED", steps: [] },
  ];
  const b = P.board(orders, { today: "2026-10-18", tomorrow: "2026-10-19", dayOf: day, me: "me" });
  assert.deepEqual(b.counts, { orders: 4, pending: 1, inProgress: 2, doneToday: 1, overdue: 1, dueToday: 1, dueTomorrow: 1, readyToFinish: 1 });
  assert.deepEqual(b.columns.map((c) => [c.name, c.cards.map((x) => x.processNo)]), [["Cutting", ["PRO-2"]], ["Painting", ["PRO-3"]], ["Bending", ["PRO-1"]], ["Ready to finish", ["PRO-4"]]]);
  assert.deepEqual(b.overdue.map((c) => c.processNo), ["PRO-1"]);
  assert.deepEqual(b.dueToday.map((c) => c.processNo), ["PRO-2"]);
  assert.deepEqual(b.dueTomorrow.map((c) => [c.processNo, c.who]), [["PRO-3", "Shine"]]);
  assert.deepEqual(b.mine.map((c) => c.processNo), ["PRO-1"]);
});

test("a route: days are whole numbers from 0 to 365, and it is checked like an order", () => {
  const route = { finished: { stockId: F }, batchQty: 10, materials: [{ stockId: R, qty: 10 }], steps: [{ name: "Cutting", mode: "in_house", days: 1 }, { name: "Painting", mode: "job_work", jobWorkerId: V, days: 3 }] };
  assert.deepEqual(P.validateRoute(route), []);
  assert.deepEqual(P.validateRoute({ ...route, batchQty: 0 }).map((e) => [e.field, e.code]), [["batchQty", "INVALID_QTY"]]);
  assert.deepEqual(P.validateRoute({ ...route, steps: [{ name: "Cutting", mode: "in_house", days: 1.5 }] }).map((e) => e.code), ["INVALID_DAYS"]);
  assert.deepEqual(P.validateRoute({ ...route, steps: [{ name: "Cutting", mode: "in_house", days: 400 }] }).map((e) => e.code), ["INVALID_DAYS"]);
});

test("an order planned from a route: materials scaled, each step due its days after the one before", () => {
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const route = { finished: { stockId: F }, batchQty: 10, materials: [{ stockId: R, itemName: "Raw", qty: 12 }],
    steps: [{ name: "Cutting", mode: "in_house", assigneeId: "u1", days: 1 }, { name: "Inspection", mode: "in_house", days: 0 }, { name: "Painting", mode: "job_work", jobWorkerId: V, days: 3 }] };
  const o = P.orderFromRoute(route, { qty: 25, startDay: "2026-10-30", addDays });
  assert.deepEqual(o.materials, [{ stockId: R, itemName: "Raw", qty: 30 }]);
  assert.deepEqual(o.steps.map((s) => [s.name, s.dueDate]), [["Cutting", "2026-10-31"], ["Inspection", "2026-10-31"], ["Painting", "2026-11-03"]]);
  assert.equal(o.dueDate, "2026-11-03");
  assert.equal(o.steps[0].assigneeId, "u1");
  const undated = P.orderFromRoute({ ...route, steps: route.steps.map((s) => ({ ...s, days: 0 })) }, { qty: 10, startDay: "2026-10-30", addDays });
  assert.equal(undated.dueDate, undefined, "a route without days plans no dates");
  assert.equal(undated.steps[0].dueDate, undefined);
});

test("release and advance stamp when a step became ready", () => {
  const now = new Date("2026-10-19T08:00:00Z");
  const steps = P.release(input().steps, 10, now);
  assert.equal(steps[0].readyAt, now);
  assert.equal(steps[1].readyAt, undefined);
  const later = new Date("2026-10-19T12:00:00Z");
  const next = P.advance([{ ...steps[0], status: "DONE", qtyDone: 9 }, ...steps.slice(1)], 0, later);
  assert.equal(next[1].readyAt, later);
});

test("analysis: lead time, on time and yield of finished orders; each step and worker's time, lateness and rejects", () => {
  const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
  const at = (s) => new Date(s);
  const orders = [
    { status: "COMPLETED", finished: { qty: 100 }, releasedAt: at("2026-10-01T08:00Z"), completedAt: at("2026-10-05T08:00Z"), dueDate: at("2026-10-06T00:00Z"),
      steps: [
        { name: "Bending", mode: "in_house", assigneeId: "u1", assigneeName: "Ravi", status: "DONE", readyAt: at("2026-10-01T08:00Z"), startedAt: at("2026-10-01T10:00Z"), doneAt: at("2026-10-02T10:00Z"), dueDate: at("2026-10-01T00:00Z"), qtyDone: 96, qtyRejected: 4, rejectReason: "Bent or cracked" },
        { name: "Painting", mode: "job_work", jobWorkerId: V, jobWorkerName: "Shine", status: "DONE", readyAt: at("2026-10-02T10:00Z"), startedAt: at("2026-10-02T10:00Z"), doneAt: at("2026-10-04T10:00Z"), dueDate: at("2026-10-05T00:00Z"), qtyDone: 95, qtyRejected: 1 },
      ] },
    { status: "COMPLETED", finished: { qty: 50 }, releasedAt: at("2026-10-03T08:00Z"), completedAt: at("2026-10-09T08:00Z"), dueDate: at("2026-10-07T00:00Z"),
      steps: [{ name: "Bending", mode: "in_house", assigneeId: "u1", assigneeName: "Ravi", status: "DONE", readyAt: at("2026-10-03T08:00Z"), startedAt: at("2026-10-04T08:00Z"), doneAt: at("2026-10-04T20:00Z"), qtyDone: 50, qtyRejected: 0 }] },
    { status: "COMPLETED", finished: { qty: 10 }, releasedAt: at("2026-09-01T08:00Z"), completedAt: at("2026-09-20T08:00Z"), steps: [] },
  ];
  const a = P.analysis(orders, { from: "2026-10-01", to: "2026-10-31", dayOf });
  assert.deepEqual(a.orders, { finished: 2, unitsOrdered: 150, unitsMade: 145, yieldPct: 96.7, avgLeadDays: 5, withDue: 2, onTime: 1, onTimePct: 50 });
  const bending = a.steps.find((s) => s.label === "Bending");
  assert.deepEqual([bending.done, bending.good, bending.rejected, bending.rejectPct, bending.waitHours, bending.workHours, bending.late, bending.withDue], [2, 146, 4, 2.7, 13, 18, 1, 1]);
  assert.deepEqual(a.people.map((p) => [p.label, p.mode, p.done]), [["Ravi", "in_house", 2], ["Shine", "job_work", 1]]);
  assert.deepEqual(a.reasons, [{ reason: "Bent or cracked", qty: 4 }, { reason: "Not given", qty: 1 }]);
  assert.deepEqual(a.daily.map((d) => [d.day, d.stepsDone, d.unitsFinished]), [["2026-10-02", 1, 0], ["2026-10-04", 2, 0], ["2026-10-05", 0, 95], ["2026-10-09", 0, 50]]);
  assert.equal(P.analysis([], { from: "2026-10-01", to: "2026-10-31", dayOf }).orders.yieldPct, null, "nothing finished: no rate, not 0");
});
