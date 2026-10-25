// Pure rules of a garage job card (no Mongoose, no clock): a vehicle comes in with complaints, an estimate is
// built and approved, tasks are worked by technicians, parts and labour are billed. The service
// (services/garage/jobCardService.js) reads and writes; the board (what is in the workshop, late, ready) is
// worked out here from the cards, never stored.
//
// A card is DRAFT, AWAITING_APPROVAL, IN_PROGRESS, READY (work finished, car not yet handed over), DELIVERED,
// CLOSED (invoiced and handed over) or CANCELLED. A task is WAITING (its stage has not come round), READY,
// IN_PROGRESS or DONE.
//
// THE ONE DIFFERENCE FROM A PROCESS ORDER (utils/processOrders.js), and the reason this is its own file: a
// process order's steps are strictly sequential, one product moving down a line. A garage's tasks are usually
// PARALLEL - one technician on the brakes while another does the air conditioning - and only a body job is a
// chain (strip -> panel -> filler -> primer -> paint -> cure -> polish -> rebuild -> QC). So a task carries a
// `stage`: tasks sharing a stage run together, and the next stage opens only when every task in this one is
// done. Everything is stage 1 by default, which is the mechanical case; a body template numbers them 1..9.
const EPS = 1e-9;
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const idOf = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v == null ? "" : String(v));
const text = (v, max) => String(v ?? "").trim().slice(0, max);

// ---- the words ------------------------------------------------------------------------------------------
const JOB_STATUS = ["DRAFT", "AWAITING_APPROVAL", "IN_PROGRESS", "READY", "DELIVERED", "CLOSED", "CANCELLED"];
const LIVE_STATUS = new Set(["DRAFT", "AWAITING_APPROVAL", "IN_PROGRESS", "READY", "DELIVERED"]);
// Who pays, and under what arrangement. It decides which approval the card waits for, not how it posts.
const JOB_TYPES = ["retail", "insurance", "warranty", "internal", "fleet"];
const TASK_MODES = ["in_house", "sublet"];
const TASK_STATUS = ["WAITING", "READY", "IN_PROGRESS", "DONE", "SKIPPED"];
const OPEN_TASK = new Set(["READY", "IN_PROGRESS"]);
// A line is one of four things. `part` and `consumable` are goods and move stock when the invoice is approved;
// `labour` and `sublet` are service items and never move any (utils/itemKinds.js). The split exists so the
// owner can read margin per stream, which is the first question any workshop owner asks.
const LINE_KINDS = ["part", "labour", "sublet", "consumable"];
const STOCKED_KINDS = new Set(["part", "consumable"]);
const COMPLAINT_STATUS = ["OPEN", "DIAGNOSED", "DONE", "NOT_DONE"];
// How the customer's or the insurer's approval was obtained. A UAE workshop almost always gets it on WhatsApp,
// and the record of it is what settles an argument later, so the method and a reference are kept, not a bare flag.
const APPROVAL_METHODS = ["whatsapp", "email", "signed", "call", "counter", "lpo", "portal"];
const FUEL_LEVELS = ["E", "1/4", "1/2", "3/4", "F"];
// What is checked off the car at the gate. Kept here, not in a master, because every workshop checks the same
// handful and a missing spare wheel is the commonest dispute there is.
const CHECK_IN_ITEMS = ["Spare wheel", "Jack and tools", "Wheel spanner", "Stereo / screen", "Floor mats", "First-aid kit", "Fire extinguisher", "Registration card", "Fuel card", "Personal items"];
const DAMAGE_KINDS = ["scratch", "dent", "crack", "chip", "rust", "missing", "broken"];
// Why a technician could not finish, offered as quick picks; anything else may be typed.
const HOLD_REASONS = ["Waiting for a part", "Waiting for approval", "Waiting for the job worker", "Diagnosis incomplete", "Special tool needed", "Other"];

// ---- a vehicle ------------------------------------------------------------------------------------------
// A plate is matched on its letters and digits alone: people type "A 12345", "A-12345" and "a12345" for one car,
// and a workshop that cannot find a returning vehicle by its plate has lost the feature it bought the software
// for. The plate is still STORED as it was typed; only the lookup is normalised.
const plateKey = (plate) => String(plate ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// A chassis (VIN) is 17 characters on any car built since 1981, and never contains I, O or Q - which is exactly
// why those three are the ones people mistype for 1 and 0. We do not correct them (a wrong correction is worse
// than a wrong search); we only strip punctuation and case.
const chassisKey = (vin) => String(vin ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function validateVehicle(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  const plate = plateKey(input.plateNumber);
  const chassis = chassisKey(input.chassisNo);
  if (!plate && !chassis) add("plateNumber", "PLATE_OR_CHASSIS_REQUIRED", "Enter the plate number, or the chassis number if the car has no plate yet");
  if (plate && plate.length > 12) add("plateNumber", "PLATE_TOO_LONG", "A plate number is at most 12 letters and digits");
  if (chassis && (chassis.length < 5 || chassis.length > 20)) add("chassisNo", "INVALID_CHASSIS", "A chassis number is between 5 and 20 letters and digits (17 on a modern car)");
  if (!text(input.make, 60)) add("make", "MAKE_REQUIRED", "Enter the make (Toyota, Nissan, ...)");
  if (!text(input.model, 60)) add("model", "MODEL_REQUIRED", "Enter the model");
  const year = input.year === "" || input.year == null ? null : num(input.year);
  if (year != null && !(Number.isInteger(year) && year >= 1900 && year <= 2100)) add("year", "INVALID_YEAR", "Enter the year as four digits");
  const odo = input.odometer === "" || input.odometer == null ? null : num(input.odometer);
  if (odo != null && !(odo >= 0 && odo < 10000000)) add("odometer", "INVALID_ODOMETER", "Enter the odometer reading in kilometres");
  return errors;
}

// ---- a job card -----------------------------------------------------------------------------------------
function validateJobCard(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  if (!idOf(input.vehicleId)) add("vehicleId", "VEHICLE_REQUIRED", "Choose the vehicle");
  if (!idOf(input.customerId)) add("customerId", "CUSTOMER_REQUIRED", "Choose the customer");
  if (input.jobType && !JOB_TYPES.includes(input.jobType)) add("jobType", "INVALID_JOB_TYPE", "Choose how this job is paid for");
  const odo = input.odometerIn === "" || input.odometerIn == null ? null : num(input.odometerIn);
  if (odo != null && !(odo >= 0 && odo < 10000000)) add("odometerIn", "INVALID_ODOMETER", "Enter the odometer reading in kilometres");
  if (input.fuelLevelIn && !FUEL_LEVELS.includes(input.fuelLevelIn)) add("fuelLevelIn", "INVALID_FUEL_LEVEL", "Choose the fuel level");

  const complaints = Array.isArray(input.complaints) ? input.complaints : [];
  if (!complaints.length) add("complaints", "COMPLAINTS_REQUIRED", "Write down what the customer reported, in their own words");
  complaints.forEach((c, i) => {
    if (!text(c?.concern, 400)) add(`complaints.${i}.concern`, "CONCERN_REQUIRED", `Complaint ${i + 1}: what did the customer say?`);
  });

  (Array.isArray(input.lines) ? input.lines : []).forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!LINE_KINDS.includes(l?.kind)) add(`lines.${i}.kind`, "INVALID_LINE_KIND", `${n}: part, labour, sublet or consumable`);
    if (!idOf(l?.itemId)) add(`lines.${i}.itemId`, "LINE_ITEM_REQUIRED", `${n}: choose the item`);
    if (!(num(l?.qty) > 0)) add(`lines.${i}.qty`, "INVALID_QTY", `${n}: enter the quantity`);
    if (!(num(l?.price) >= 0)) add(`lines.${i}.price`, "INVALID_PRICE", `${n}: enter the price`);
    if (l?.kind === "sublet" && !idOf(l?.vendorId)) add(`lines.${i}.vendorId`, "SUBLET_VENDOR_REQUIRED", `${n}: choose who the work goes out to`);
  });

  (Array.isArray(input.tasks) ? input.tasks : []).forEach((t, i) => {
    const n = `Task ${i + 1}`;
    if (!text(t?.name, 80)) add(`tasks.${i}.name`, "TASK_NAME_REQUIRED", `${n}: give it a name`);
    if (!TASK_MODES.includes(t?.mode)) add(`tasks.${i}.mode`, "INVALID_MODE", `${n}: in-house or sent out`);
    if (t?.mode === "sublet" && !idOf(t?.vendorId)) add(`tasks.${i}.vendorId`, "SUBLET_VENDOR_REQUIRED", `${n}: choose who it goes out to`);
    const stage = t?.stage == null || t?.stage === "" ? 1 : num(t.stage);
    if (!(Number.isInteger(stage) && stage >= 1 && stage <= 50)) add(`tasks.${i}.stage`, "INVALID_STAGE", `${n}: the stage is a whole number from 1 to 50`);
    const hours = t?.standardHours == null || t?.standardHours === "" ? 0 : num(t.standardHours);
    if (!(hours >= 0 && hours <= 1000)) add(`tasks.${i}.standardHours`, "INVALID_HOURS", `${n}: enter the hours as a number`);
  });
  return errors;
}

// ---- the estimate ---------------------------------------------------------------------------------------
// What the customer (or the insurer) said yes to. A line is approved explicitly; a card with nothing marked has
// been approved WHOLE, which is the ordinary case and saves a workshop ticking twenty boxes to say "do it all".
const isApproved = (line) => line?.approved !== false;
const approvedLines = (card) => (card?.lines || []).filter(isApproved);
const declinedLines = (card) => (card?.lines || []).filter((l) => l?.approved === false);

// One line's value before VAT: quantity x price, less its discount. The SERVER prices the real document through
// TransactionService.buildPricing, so this is the estimate's own arithmetic and nothing posts from it.
function lineValue(line) {
  const gross = (Number(line?.qty) || 0) * (Number(line?.price) || 0);
  const pct = Number(line?.discountPercent) || 0;
  const off = pct > 0 ? (gross * pct) / 100 : Number(line?.discountAmount) || 0;
  return round2(Math.max(0, gross - off));
}

// What the card is worth, split the way the owner reads it: parts, labour, sublet, consumables.
function jobTotals(card, { approvedOnly = true } = {}) {
  const lines = approvedOnly ? approvedLines(card) : card?.lines || [];
  const byKind = Object.fromEntries(LINE_KINDS.map((k) => [k, 0]));
  let total = 0;
  for (const l of lines) {
    const v = lineValue(l);
    byKind[l.kind] = round2((byKind[l.kind] || 0) + v);
    total = round2(total + v);
  }
  return { ...byKind, total, lines: lines.length, declined: declinedLines(card).length };
}

// Sending an estimate, or revising one. A supplementary estimate (teardown found more) is a NEW VERSION of the
// same card, never a second document: the customer approved version 2, and which lines were on it has to be
// answerable a year later. Lines added now are stamped with the version they appeared in.
function planEstimate(card, { now, by } = {}) {
  const version = (Number(card?.estimate?.version) || 0) + 1;
  const lines = (card?.lines || []).map((l) => (l.addedInVersion ? l : { ...l, addedInVersion: version }));
  return {
    version,
    lines,
    estimate: { version, sentAt: now || null, sentBy: by || null, decidedAt: null, decidedBy: null, method: null, reference: "", note: "", total: jobTotals({ lines }, { approvedOnly: false }).total },
  };
}

function checkApproval({ method, reference, lineIds } = {}, card) {
  if (!APPROVAL_METHODS.includes(method)) return { code: "INVALID_APPROVAL_METHOD", message: "Say how the approval was given (WhatsApp, email, signed, a call, an LPO)" };
  // An LPO is the insurer's own order number and is the evidence the work was authorised, so it is never blank.
  if (method === "lpo" && !text(reference, 60)) return { code: "APPROVAL_REFERENCE_REQUIRED", message: "Enter the LPO or approval number the insurer gave" };
  if (Array.isArray(lineIds)) {
    const known = new Set((card?.lines || []).map((l) => idOf(l._id)));
    const stray = lineIds.map(idOf).find((id) => !known.has(id));
    if (stray) return { code: "LINE_NOT_ON_CARD", message: "One of the approved lines is not on this job card", details: { lineId: stray } };
    if (!lineIds.length) return { code: "NOTHING_APPROVED", message: "Nothing was approved. Cancel the job instead, or approve at least one line" };
  }
  return null;
}

// ---- tasks ----------------------------------------------------------------------------------------------
const stagesOf = (tasks = []) => [...new Set(tasks.map((t) => Number(t.stage) || 1))].sort((a, b) => a - b);

// Opening the card for work: every task in the FIRST stage is ready at once, the rest wait their stage.
function release(tasks = [], now = undefined) {
  const first = stagesOf(tasks)[0];
  return tasks.map((t, i) => ({
    ...t,
    seq: i + 1,
    stage: Number(t.stage) || 1,
    status: (Number(t.stage) || 1) === first ? "READY" : "WAITING",
    ...((Number(t.stage) || 1) === first && now ? { readyAt: now } : {}),
  }));
}

// A task is done: if every task in its stage is now finished, the next stage opens. A SKIPPED task counts as
// finished - a stage must not wedge because one job was declined after the card was released.
function advance(tasks = [], now = undefined) {
  const settled = (t) => t.status === "DONE" || t.status === "SKIPPED";
  const stages = stagesOf(tasks);
  const openStage = stages.find((s) => tasks.some((t) => (Number(t.stage) || 1) === s && !settled(t)));
  if (openStage == null) return tasks;
  return tasks.map((t) =>
    (Number(t.stage) || 1) === openStage && t.status === "WAITING" ? { ...t, status: "READY", ...(now ? { readyAt: now } : {}) } : t
  );
}

function checkCompletion(task, { actualHours } = {}) {
  if (!task) return { code: "TASK_NOT_FOUND", message: "That task is not on this job card" };
  if (!OPEN_TASK.has(task.status)) return { code: "TASK_NOT_OPEN", message: `This task is ${String(task.status || "").toLowerCase()}` };
  const h = actualHours == null || actualHours === "" ? null : num(actualHours);
  if (h != null && !(h >= 0 && h <= 1000)) return { code: "INVALID_HOURS", message: "Enter the hours worked as a number" };
  return null;
}

const allTasksSettled = (card) => {
  const tasks = card?.tasks || [];
  return tasks.length > 0 && tasks.every((t) => t.status === "DONE" || t.status === "SKIPPED");
};
const currentTasks = (card) => (card?.tasks || []).filter((t) => OPEN_TASK.has(t.status));
// Hours promised against hours taken - the two numbers every productivity report is built from.
function taskHours(card) {
  const tasks = card?.tasks || [];
  const standard = tasks.reduce((t, x) => t + (Number(x.standardHours) || 0), 0);
  const actual = tasks.reduce((t, x) => t + (Number(x.actualHours) || 0), 0);
  return { standard: round2(standard), actual: round2(actual) };
}

// ---- handing the car back -------------------------------------------------------------------------------
// A gate pass is refused while money is owed, unless the person releasing it may override (a fleet customer on
// credit, an insurer paying later). The rule is here so the screen and the server cannot disagree about it.
function mayRelease(card, { outstanding = 0, mayOverride = false, onAccount = false } = {}) {
  if (!card) return { ok: false, code: "JOB_NOT_FOUND", message: "That job card does not exist" };
  if (card.status === "CANCELLED") return { ok: false, code: "JOB_CANCELLED", message: "This job was cancelled" };
  if (card.delivery?.gatePassAt) return { ok: false, code: "ALREADY_RELEASED", message: "This vehicle has already been handed over" };
  if (!allTasksSettled(card) && (card.tasks || []).length) return { ok: false, code: "WORK_NOT_FINISHED", message: "Some work is still open. Finish or skip every task first" };
  if (round2(outstanding) > 0 && !onAccount && !mayOverride) {
    return { ok: false, code: "PAYMENT_DUE", message: `${round2(outstanding)} is still owed on this job. Take the payment, or release it on account`, details: { outstanding: round2(outstanding) } };
  }
  return { ok: true };
}

// ---- warranty and comebacks ----------------------------------------------------------------------------
// The repair's own warranty, from the day the car went out: a number of months, a number of kilometres, or both,
// and whichever runs out first ends it. `addMonths(day, n)` keeps the calendar arithmetic out of here.
function warrantyUntil({ deliveredDay, odometerOut, months, kilometres }, { addMonths }) {
  const m = Number(months) || 0;
  const km = Number(kilometres) || 0;
  return {
    until: m > 0 && deliveredDay ? addMonths(deliveredDay, m) : null,
    untilOdometer: km > 0 && Number(odometerOut) > 0 ? round3(Number(odometerOut) + km) : null,
  };
}

// A comeback: the same vehicle back inside the warranty of an earlier job, for something that job had touched.
// It is OFFERED, never decided - only the advisor knows whether the new noise is the old fault - so this returns
// the candidates and the screen asks.
function comebackCandidates(previousJobs = [], { today, odometer, dayOf }) {
  const km = Number(odometer) || 0;
  return previousJobs
    .filter((j) => j.warranty && (j.warranty.until || j.warranty.untilOdometer))
    .filter((j) => {
      const byDay = j.warranty.until ? dayOf(j.warranty.until) >= today : false;
      const byKm = j.warranty.untilOdometer ? km > 0 && km <= Number(j.warranty.untilOdometer) : false;
      return byDay || byKm;
    })
    .map((j) => ({
      jobCardId: idOf(j._id),
      jobNo: j.jobNo,
      deliveredAt: j.delivery?.gatePassAt || null,
      until: j.warranty.until || null,
      untilOdometer: j.warranty.untilOdometer || null,
      work: (j.tasks || []).map((t) => t.name).filter(Boolean).slice(0, 8),
    }));
}

// ---- the next service -----------------------------------------------------------------------------------
// Due on a date or a reading, whichever comes first - which is how every manufacturer writes it and how a
// customer understands it. Null means the setting is off, never "due now".
function serviceDue(vehicle, { intervalKm, intervalMonths, lastServiceDay, lastServiceOdometer, addMonths }) {
  const km = Number(intervalKm) || 0;
  const months = Number(intervalMonths) || 0;
  const base = Number(lastServiceOdometer) || Number(vehicle?.odometer) || 0;
  return {
    dueDay: months > 0 && lastServiceDay ? addMonths(lastServiceDay, months) : null,
    dueOdometer: km > 0 && base > 0 ? round3(base + km) : null,
  };
}

// ---- when a job is due ----------------------------------------------------------------------------------
function dueState(dueDay, today, tomorrow) {
  if (!dueDay) return "none";
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";
  if (dueDay === tomorrow) return "tomorrow";
  return "later";
}

// ---- the board ------------------------------------------------------------------------------------------
// What is in the workshop right now, by the stage each car is at. A column per task name, like the process
// board, plus three of our own: waiting for approval (the commonest reason a car sits untouched), ready for
// collection, and delivered but not yet invoiced - the three places money goes missing in a workshop.
function board(cards = [], { today, tomorrow, dayOf, me = null } = {}) {
  const counts = { jobs: 0, awaitingApproval: 0, inProgress: 0, ready: 0, deliveredNotInvoiced: 0, overdue: 0, dueToday: 0, dueTomorrow: 0, doneToday: 0 };
  const columns = new Map();
  const all = [];
  const mine = [];
  const column = (name, order) => {
    if (!columns.has(name)) columns.set(name, { name, order, cards: [] });
    const col = columns.get(name);
    col.order = Math.min(col.order, order);
    return col;
  };
  for (const c of cards) {
    if (!LIVE_STATUS.has(c.status)) continue;
    counts.jobs += 1;
    for (const t of c.tasks || []) if (t.status === "DONE" && t.doneAt && dayOf(t.doneAt) === today) counts.doneToday += 1;
    const open = currentTasks(c);
    const task = open[0] || null;
    const card = {
      jobCardId: idOf(c._id), jobNo: c.jobNo, status: c.status, jobType: c.jobType,
      plate: c.vehicle?.plateNumber || "", vehicle: [c.vehicle?.make, c.vehicle?.model].filter(Boolean).join(" "),
      customer: c.customer?.name || "",
      taskId: task ? idOf(task._id) : null, taskName: task ? task.name : null, taskStatus: task ? task.status : null,
      openTasks: open.length, taskCount: (c.tasks || []).length,
      doneTasks: (c.tasks || []).filter((t) => t.status === "DONE" || t.status === "SKIPPED").length,
      who: task ? (task.mode === "sublet" ? task.vendorName : task.staffName) || "" : "",
      assigneeId: task?.assigneeId ? String(task.assigneeId) : null,
      bay: task?.bayName || c.bayName || "",
      due: c.promisedAt ? dayOf(c.promisedAt) : null,
      total: Number(c.estimate?.total) || 0,
      invoiceStatus: c.invoiceStatus || "NONE",
    };
    card.dueState = dueState(card.due, today, tomorrow);
    if (card.dueState === "overdue") counts.overdue += 1;
    if (card.dueState === "today") counts.dueToday += 1;
    if (card.dueState === "tomorrow") counts.dueTomorrow += 1;

    // Which column the car stands in: the thing actually holding it up, not merely its stored status.
    let name, order;
    if (c.status === "AWAITING_APPROVAL") { name = "Waiting for approval"; order = 0; counts.awaitingApproval += 1; }
    else if (c.status === "DELIVERED") { name = "Delivered, not invoiced"; order = 998; counts.deliveredNotInvoiced += 1; }
    else if (c.status === "READY") { name = "Ready for collection"; order = 997; counts.ready += 1; }
    else if (task) { name = task.name; order = (Number(task.stage) || 1) * 10 + 1; counts.inProgress += 1; }
    else { name = "Not started"; order = 1; }
    column(name, order).cards.push(card);
    all.push(card);
    if (me && card.assigneeId === String(me) && task && OPEN_TASK.has(task.status)) mine.push(card);
  }
  const byDue = (a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999"));
  return {
    counts,
    columns: [...columns.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((c) => ({ ...c, cards: c.cards.sort(byDue) })),
    overdue: all.filter((c) => c.dueState === "overdue").sort(byDue),
    dueToday: all.filter((c) => c.dueState === "today"),
    dueTomorrow: all.filter((c) => c.dueState === "tomorrow"),
    mine: mine.sort(byDue),
  };
}

// ---- analysis -------------------------------------------------------------------------------------------
// The workshop's own numbers over a period. Technician efficiency is hours SOLD divided by hours TAKEN - the
// trade's own definition - and it is null, never 0, when nothing was sold: a shop with no measured hours must
// not be told it is 0% efficient.
const hoursBetween = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 3.6e6) : null);
const avg = (list) => (list.length ? Math.round((list.reduce((t, x) => t + x, 0) / list.length) * 10) / 10 : null);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function analysis(cards = [], { from, to, dayOf } = {}) {
  const inPeriod = (instant) => {
    if (!instant) return false;
    const d = dayOf(instant);
    return (!from || d >= from) && (!to || d <= to);
  };
  const finished = cards.filter((c) => c.delivery?.gatePassAt && inPeriod(c.delivery.gatePassAt));
  const revenue = Object.fromEntries(LINE_KINDS.map((k) => [k, 0]));
  let total = 0;
  for (const c of finished) {
    const t = jobTotals(c);
    for (const k of LINE_KINDS) revenue[k] = round2(revenue[k] + (t[k] || 0));
    total = round2(total + t.total);
  }
  const turnaround = finished.map((c) => hoursBetween(c.receivedAt, c.delivery.gatePassAt)).filter((h) => h != null);
  const withPromise = finished.filter((c) => c.promisedAt);
  const onTime = withPromise.filter((c) => dayOf(c.delivery.gatePassAt) <= dayOf(c.promisedAt));
  const comebacks = finished.filter((c) => c.comebackOf);

  const people = new Map();
  const bucket = (key, label) => {
    if (!people.has(key)) people.set(key, { key, label, done: 0, standard: 0, actual: 0, wait: [], late: 0, withDue: 0 });
    return people.get(key);
  };
  for (const c of cards) {
    for (const t of c.tasks || []) {
      if (t.status !== "DONE" || !inPeriod(t.doneAt)) continue;
      const who = t.mode === "sublet" ? t.vendorName || "Job worker" : t.staffName || t.assigneeName || "Not assigned";
      const row = bucket(`${t.mode}:${idOf(t.staffId) || idOf(t.vendorId) || t.assigneeId || who}`, who);
      row.done += 1;
      row.standard = round2(row.standard + (Number(t.standardHours) || 0));
      row.actual = round2(row.actual + (Number(t.actualHours) || 0));
      const wait = hoursBetween(t.readyAt, t.startedAt);
      if (wait != null) row.wait.push(wait);
    }
  }
  const hours = [...people.values()].reduce((t, r) => ({ standard: round2(t.standard + r.standard), actual: round2(t.actual + r.actual) }), { standard: 0, actual: 0 });
  return {
    period: { from: from || null, to: to || null },
    jobs: {
      delivered: finished.length,
      revenue: { ...revenue, total },
      avgInvoice: finished.length ? round2(total / finished.length) : null,
      avgTurnaroundHours: avg(turnaround),
      withPromise: withPromise.length, onTime: onTime.length, onTimePct: pct(onTime.length, withPromise.length),
      comebacks: comebacks.length, comebackPct: pct(comebacks.length, finished.length),
      hoursSold: hours.standard, hoursTaken: hours.actual,
      // Hours sold against hours taken. Above 100% means the shop beat the book time, which is normal for a
      // good technician on familiar work; it is not an error.
      efficiencyPct: pct(hours.standard, hours.actual),
      avgHoursPerJob: finished.length ? round2(hours.standard / finished.length) : null,
      // What an hour actually earned, against what the shop charges. The gap is where discounting leaks.
      effectiveLabourRate: hours.actual > 0 ? round2(revenue.labour / hours.actual) : null,
    },
    people: [...people.values()]
      .map((r) => ({ key: r.key, label: r.label, done: r.done, hoursSold: r.standard, hoursTaken: r.actual, efficiencyPct: pct(r.standard, r.actual), waitHours: avg(r.wait) }))
      .sort((a, b) => b.done - a.done || a.label.localeCompare(b.label)),
  };
}

module.exports = {
  JOB_STATUS, LIVE_STATUS, JOB_TYPES, TASK_MODES, TASK_STATUS, OPEN_TASK, LINE_KINDS, STOCKED_KINDS,
  COMPLAINT_STATUS, APPROVAL_METHODS, FUEL_LEVELS, CHECK_IN_ITEMS, DAMAGE_KINDS, HOLD_REASONS,
  num, round2, round3, idOf, text, plateKey, chassisKey,
  validateVehicle, validateJobCard,
  isApproved, approvedLines, declinedLines, lineValue, jobTotals, planEstimate, checkApproval,
  stagesOf, release, advance, checkCompletion, allTasksSettled, currentTasks, taskHours,
  mayRelease, warrantyUntil, comebackCandidates, serviceDue,
  dueState, board, analysis,
};
