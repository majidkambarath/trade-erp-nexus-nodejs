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
