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

// Releasing: the first step is READY, the rest WAIT, each planned for the order's quantity. `now` stamps when the first
// step became ready (the analysis measures waiting from it).
function release(steps, qty, now = undefined) {
  return steps.map((s, i) => ({ ...s, seq: i + 1, plannedQty: round3(qty), status: i === 0 ? "READY" : "WAITING", ...(i === 0 && now ? { readyAt: now } : {}) }));
}

// The step after `index` becomes READY with what came out of this one (good units only), stamped `now`.
function advance(steps, index, now = undefined) {
  const done = steps[index];
  return steps.map((s, i) => (i === index + 1 && s.status === "WAITING" ? { ...s, status: "READY", plannedQty: round3(Number(done.qtyDone) || 0), ...(now ? { readyAt: now } : {}) } : s));
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

// ---- saved routes ------------------------------------------------------------------------------------------
// A route is a product's recipe and way through the shop, saved once: the materials for `batchQty` units and the
// steps in order, each with who usually does it and how many days it usually takes. A new order is planned from it.
const MAX_STEP_DAYS = 365;

function validateRoute(input = {}) {
  const errors = validateOrder({ finished: { stockId: input.finished?.stockId, qty: input.batchQty }, materials: input.materials, steps: input.steps })
    .map((e) => (e.field === "finished.qty" ? { field: "batchQty", code: "INVALID_QTY", message: "Enter the quantity the materials are for" } : e));
  (Array.isArray(input.steps) ? input.steps : []).forEach((s, i) => {
    const d = s?.days === "" || s?.days == null ? 0 : num(s.days);
    if (!(d >= 0 && d <= MAX_STEP_DAYS && Number.isInteger(d))) errors.push({ field: `steps.${i}.days`, code: "INVALID_DAYS", message: `Step ${i + 1}: days must be a whole number from 0 to ${MAX_STEP_DAYS}` });
  });
  return errors;
}

// An order planned from a route: the materials scaled to the quantity, each step due `days` after the one before
// (calendar days from the order's day; a step of 0 days is due with the one before), the order due with its last step.
// A route with no days at all plans no dates.
function orderFromRoute(route, { qty, startDay, addDays }) {
  const factor = Number(qty) / (Number(route.batchQty) || 1);
  const anyDays = (route.steps || []).some((s) => Number(s.days) > 0);
  let day = startDay;
  const steps = (route.steps || []).map((s) => {
    const d = Number(s.days) || 0;
    day = addDays(day, d);
    return {
      name: s.name, mode: s.mode, days: d, dueDate: anyDays ? day : undefined,
      assigneeId: s.assigneeId || undefined, assigneeName: s.assigneeName || undefined,
      jobWorkerId: s.jobWorkerId ? idOf(s.jobWorkerId) : undefined, jobWorkerName: s.jobWorkerName || undefined,
    };
  });
  return {
    finished: { stockId: idOf(route.finished?.stockId), qty: round3(qty) },
    materials: (route.materials || []).map((m) => ({ stockId: idOf(m.stockId), itemName: m.itemName, qty: round3(Number(m.qty) * factor) })),
    steps,
    dueDate: anyDays ? day : undefined,
  };
}

// Why units were rejected at a step: offered as quick picks; anything else may be typed.
const REJECT_REASONS = ["Dimension out of tolerance", "Surface defect", "Coating defect", "Bent or cracked", "Wrong material", "Damaged in handling", "Other"];

// ---- analysis ------------------------------------------------------------------------------------------------
// Over a period ("YYYY-MM-DD" from / to, the organisation's days): orders finished (lead time, on time, yield), every
// step done (by step and by who did it: count, waiting and working time, late, rejects) and why units were rejected.
// `dayOf(instant)` gives the organisation's day of a moment; `dueDayOf(date)` the day of a stored due date.
const hoursBetween = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 3.6e6) : null);
const avg = (list) => (list.length ? Math.round((list.reduce((t, x) => t + x, 0) / list.length) * 10) / 10 : null);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function analysis(orders = [], { from, to, dayOf, dueDayOf = dayOf } = {}) {
  const inPeriod = (instant) => {
    if (!instant) return false;
    const d = dayOf(instant);
    return (!from || d >= from) && (!to || d <= to);
  };
  const finished = orders.filter((o) => o.status === "COMPLETED" && inPeriod(o.completedAt));
  const lead = finished.map((o) => hoursBetween(o.releasedAt, o.completedAt)).filter((h) => h != null).map((h) => h / 24);
  const withDue = finished.filter((o) => o.dueDate);
  const onTime = withDue.filter((o) => dayOf(o.completedAt) <= dueDayOf(o.dueDate));
  const ordered = finished.reduce((t, o) => t + (Number(o.finished?.qty) || 0), 0);
  const made = finished.reduce((t, o) => t + finishedQty(o), 0);

  const groups = { step: new Map(), who: new Map() };
  const reasons = new Map();
  const daily = new Map();
  const bucket = (map, key, label, extra) => {
    if (!map.has(key)) map.set(key, { key, label, ...extra, done: 0, good: 0, rejected: 0, wait: [], work: [], late: 0, withDue: 0 });
    return map.get(key);
  };
  const dayRow = (d) => {
    if (!daily.has(d)) daily.set(d, { day: d, stepsDone: 0, unitsFinished: 0 });
    return daily.get(d);
  };
  for (const o of orders) {
    for (const s of o.steps || []) {
      if (s.status !== "DONE" || !inPeriod(s.doneAt)) continue;
      const who = s.mode === "job_work" ? s.jobWorkerName || "Job worker" : s.assigneeName || "Not assigned";
      const whoKey = `${s.mode}:${s.mode === "job_work" ? idOf(s.jobWorkerId) || who : s.assigneeId || who}`;
      const rows = [bucket(groups.step, s.name, s.name, {}), bucket(groups.who, whoKey, who, { mode: s.mode })];
      const wait = hoursBetween(s.readyAt, s.startedAt);
      const work = hoursBetween(s.startedAt, s.doneAt);
      const late = s.dueDate ? dayOf(s.doneAt) > dueDayOf(s.dueDate) : null;
      for (const r of rows) {
        r.done += 1;
        r.good += Number(s.qtyDone) || 0;
        r.rejected += Number(s.qtyRejected) || 0;
        if (wait != null) r.wait.push(wait);
        if (work != null) r.work.push(work);
        if (late != null) {
          r.withDue += 1;
          if (late) r.late += 1;
        }
      }
      if (Number(s.qtyRejected) > 0) {
        const why = s.rejectReason || "Not given";
        reasons.set(why, round3((reasons.get(why) || 0) + Number(s.qtyRejected)));
      }
      dayRow(dayOf(s.doneAt)).stepsDone += 1;
    }
  }
  for (const o of finished) {
    const row = dayRow(dayOf(o.completedAt));
    row.unitsFinished = round3(row.unitsFinished + finishedQty(o));
  }
  const shape = (r) => ({
    key: r.key, label: r.label, ...(r.mode ? { mode: r.mode } : {}), done: r.done, good: round3(r.good), rejected: round3(r.rejected),
    rejectPct: pct(r.rejected, r.good + r.rejected), waitHours: avg(r.wait), workHours: avg(r.work),
    late: r.late, withDue: r.withDue, latePct: pct(r.late, r.withDue),
  });
  const byDone = (a, b) => b.done - a.done || a.label.localeCompare(b.label);
  return {
    period: { from: from || null, to: to || null },
    orders: {
      finished: finished.length, unitsOrdered: round3(ordered), unitsMade: round3(made), yieldPct: pct(made, ordered),
      avgLeadDays: avg(lead), withDue: withDue.length, onTime: onTime.length, onTimePct: pct(onTime.length, withDue.length),
    },
    steps: [...groups.step.values()].map(shape).sort(byDone),
    people: [...groups.who.values()].map(shape).sort(byDone),
    reasons: [...reasons.entries()].map(([reason, qty]) => ({ reason, qty })).sort((a, b) => b.qty - a.qty),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

module.exports = {
  MODES, OPEN_STEP, MAX_STEP_DAYS, REJECT_REASONS, validateOrder, validateRoute, orderFromRoute, release, advance, checkCompletion,
  currentStep, allDone, finishedQty, dueState, board, analysis,
};
