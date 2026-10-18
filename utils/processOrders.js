// Pure rules of a process order (no Mongoose): one product made through steps in order (cutting -> bending ->
// painting -> packing), each in-house (a person) or job work (a vendor, on a challan), each with a due date. The service
// (services/stock/processOrderService.js) reads and writes; the board (what is pending, in progress, late, due today or
// tomorrow) is worked out here from the orders, never stored.
//
// A step is WAITING (an earlier step is not done), READY, IN_PROGRESS (started; a job-work step: sent) or DONE. Steps go
// one after another: finishing one makes the next READY with the quantity that came out of it. The order is DRAFT, OPEN,
// COMPLETED (its Production posted) or CANCELLED; "ready to finish" (every step done) is worked out, not stored.
const EPS = 1e-9;
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const idOf = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v == null ? "" : String(v));
const MODES = ["in_house", "job_work"];
const OPEN_STEP = new Set(["READY", "IN_PROGRESS"]);

function validateOrder(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  if (!idOf(input.finished?.stockId)) add("finished.stockId", "FINISHED_ITEM_REQUIRED", "Choose the product this order makes");
  if (!(num(input.finished?.qty) > 0)) add("finished.qty", "INVALID_QTY", "Enter how many to make");
  const materials = Array.isArray(input.materials) ? input.materials : [];
  materials.forEach((m, i) => {
    if (!idOf(m?.stockId)) add(`materials.${i}.stockId`, "MATERIAL_ITEM_REQUIRED", `Material ${i + 1}: choose the item`);
    else if (idOf(m.stockId) === idOf(input.finished?.stockId)) add(`materials.${i}.stockId`, "MATERIAL_IS_FINISHED_ITEM", `Material ${i + 1}: a product cannot be made from itself`);
    if (!(num(m?.qty) > 0)) add(`materials.${i}.qty`, "INVALID_QTY", `Material ${i + 1}: enter the quantity`);
  });
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) add("steps", "STEPS_REQUIRED", "Add the steps the product goes through (e.g. Cutting, Bending, Painting)");
  steps.forEach((s, i) => {
    const n = `Step ${i + 1}`;
    if (!String(s?.name || "").trim()) add(`steps.${i}.name`, "STEP_NAME_REQUIRED", `${n}: give it a name`);
    if (!MODES.includes(s?.mode)) add(`steps.${i}.mode`, "INVALID_MODE", `${n}: in-house or job work`);
    if (s?.mode === "job_work" && !idOf(s?.jobWorkerId)) add(`steps.${i}.jobWorkerId`, "JOB_WORKER_REQUIRED", `${n}: choose the job worker`);
    if (s?.mode === "job_work" && !materials.length) add(`steps.${i}.mode`, "MATERIAL_REQUIRED", `${n}: a job-work step sends the material out, so add the material first`);
  });
  return errors;
}

// Releasing: the first step is READY, the rest WAIT, each planned for the order's quantity.
function release(steps, qty) {
  return steps.map((s, i) => ({ ...s, seq: i + 1, plannedQty: round3(qty), status: i === 0 ? "READY" : "WAITING" }));
}

// The step after `index` becomes READY with what came out of this one (good units only).
function advance(steps, index) {
  const done = steps[index];
  return steps.map((s, i) => (i === index + 1 && s.status === "WAITING" ? { ...s, status: "READY", plannedQty: round3(Number(done.qtyDone) || 0) } : s));
}

// Finishing an in-house step: the good quantity and the rejected; together no more than came in.
function checkCompletion(step, { qtyDone, qtyRejected = 0 } = {}) {
  const good = num(qtyDone), bad = num(qtyRejected) || 0;
  if (!(good >= 0) || !(bad >= 0)) return { code: "INVALID_QTY", message: "Quantities cannot be negative" };
  if (!(good > 0)) return { code: "INVALID_QTY", message: "Enter how many came out of this step" };
  if (good + bad > Number(step.plannedQty) + EPS) return { code: "MORE_THAN_PLANNED", message: `Only ${step.plannedQty} came into this step; ${round3(good + bad)} entered` };
  return null;
}

// The step an order is at: its first step not done (or null when every step is done).
const currentStep = (order) => (order.steps || []).find((s) => s.status !== "DONE") || null;
const allDone = (order) => (order.steps || []).length > 0 && (order.steps || []).every((s) => s.status === "DONE");
// What the order makes: the good units out of its last step.
const finishedQty = (order) => {
  const steps = order.steps || [];
  return steps.length ? round3(Number(steps[steps.length - 1].qtyDone) || 0) : 0;
};

// When a step is due, against the organisation's day ("YYYY-MM-DD" strings).
function dueState(dueDay, today, tomorrow) {
  if (!dueDay) return "none";
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";
  if (dueDay === tomorrow) return "tomorrow";
  return "later";
}

// The board over open orders: counts, where each order is (a column per step name, plus "Ready to finish"), and the
// lists the owner reads first. `dayOf(date)` turns a stored date into the organisation's "YYYY-MM-DD".
function board(orders = [], { today, tomorrow, dayOf, me = null } = {}) {
  const counts = { orders: 0, pending: 0, inProgress: 0, doneToday: 0, overdue: 0, dueToday: 0, dueTomorrow: 0, readyToFinish: 0 };
  const columns = new Map();
  const cards = [];
  const mine = [];
  for (const o of orders) {
    if (o.status !== "OPEN") continue;
    counts.orders += 1;
    for (const s of o.steps || []) {
      if (s.status === "DONE" && s.doneAt && dayOf(s.doneAt) === today) counts.doneToday += 1;
    }
    const step = currentStep(o);
    const card = {
      orderId: idOf(o._id), processNo: o.processNo, itemName: o.finished?.itemName, qty: o.finished?.qty,
      orderDue: o.dueDate ? dayOf(o.dueDate) : null,
      stepId: step ? idOf(step._id) : null, stepName: step ? step.name : "Ready to finish", stepSeq: step ? step.seq : null,
      stepCount: (o.steps || []).length, status: step ? step.status : "READY_TO_FINISH", mode: step?.mode || null,
      who: step ? (step.mode === "job_work" ? step.jobWorkerName : step.assigneeName) || "" : "",
      assigneeId: step?.assigneeId ? String(step.assigneeId) : null,
      plannedQty: step ? step.plannedQty : finishedQty(o), jobWorkNo: step?.jobWorkNo || null,
      due: step?.dueDate ? dayOf(step.dueDate) : o.dueDate ? dayOf(o.dueDate) : null,
    };
    card.dueState = step ? dueState(card.due, today, tomorrow) : "none";
    if (!step) counts.readyToFinish += 1;
    else if (step.status === "IN_PROGRESS") counts.inProgress += 1;
    else counts.pending += 1;
    if (card.dueState === "overdue") counts.overdue += 1;
    if (card.dueState === "today") counts.dueToday += 1;
    if (card.dueState === "tomorrow") counts.dueTomorrow += 1;
    cards.push(card);
    const key = card.stepName;
    if (!columns.has(key)) columns.set(key, { name: key, order: step ? step.seq : 999, cards: [] });
    const col = columns.get(key);
    col.order = Math.min(col.order, step ? step.seq : 999);
    col.cards.push(card);
    if (me && card.assigneeId === String(me) && OPEN_STEP.has(card.status)) mine.push(card);
  }
  const byDue = (a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999"));
  return {
    counts,
    columns: [...columns.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((c) => ({ ...c, cards: c.cards.sort(byDue) })),
    overdue: cards.filter((c) => c.dueState === "overdue").sort(byDue),
    dueToday: cards.filter((c) => c.dueState === "today"),
    dueTomorrow: cards.filter((c) => c.dueState === "tomorrow"),
    mine: mine.sort(byDue),
  };
}

module.exports = { MODES, OPEN_STEP, validateOrder, release, advance, checkCompletion, currentStep, allDone, finishedQty, dueState, board };
