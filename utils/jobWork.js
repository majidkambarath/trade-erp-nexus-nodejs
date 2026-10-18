// Pure rules of job work (subcontracting): parts sent to an outside party and received back finished. No Mongoose:
// the service (services/stock/jobWorkService.js) reads and writes. What is "at the job worker" is never stored; it is
// worked out from what was sent and the receipts that are not reversed.
const EPS = 1e-9;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const idOf = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v == null ? "" : String(v));
const OPEN = new Set(["SENT", "PARTLY_RECEIVED"]);

// Per line: received, consumed, returned unprocessed, and what is still with the job worker.
function lineProgress(line, receipts = []) {
  let finished = 0, consumed = 0, returned = 0;
  for (const r of receipts) {
    if (r.reversedAt) continue;
    for (const l of r.lines || []) {
      if (idOf(l.lineId) !== idOf(line._id)) continue;
      finished += Number(l.finishedQty) || 0;
      consumed += Number(l.rawConsumed) || 0;
      returned += Number(l.rawReturned) || 0;
    }
  }
  const qtySent = Number(line.qtySent) || 0;
  return {
    lineId: idOf(line._id),
    qtySent,
    expectedFinished: round3(qtySent * (Number(line.finishedPerRaw) || 1)),
    finished: round3(finished),
    consumed: round3(consumed),
    returned: round3(returned),
    atWorker: Math.max(0, round3(qtySent - consumed - returned)),
  };
}

// The status follows from the receipts: nothing back = SENT, some = PARTLY_RECEIVED, all back = RECEIVED.
function progress(order) {
  const lines = (order.lines || []).map((l) => lineProgress(l, order.receipts));
  const atWorker = round3(lines.reduce((s, l) => s + l.atWorker, 0));
  const anyBack = (order.receipts || []).some((r) => !r.reversedAt);
  let status = order.status;
  if (OPEN.has(order.status) || order.status === "RECEIVED") {
    status = atWorker <= EPS ? "RECEIVED" : anyBack ? "PARTLY_RECEIVED" : "SENT";
  }
  return { lines, atWorker, status };
}

// Every problem as { field, code, message }; empty = the job can be saved.
function validateOrder(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  if (!idOf(input.jobWorkerId)) add("jobWorkerId", "JOB_WORKER_REQUIRED", "Choose the job worker (the vendor doing the work)");
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) add("lines", "NOTHING_TO_SEND", "Add at least one item to send");
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!idOf(l?.rawStockId)) add(`lines.${i}.rawStockId`, "ITEM_REQUIRED", `${n}: choose the item you send`);
    if (!idOf(l?.finishedStockId)) add(`lines.${i}.finishedStockId`, "ITEM_REQUIRED", `${n}: choose the item that comes back`);
    else if (idOf(l.finishedStockId) === idOf(l.rawStockId)) add(`lines.${i}.finishedStockId`, "SAME_ITEM", `${n}: the item that comes back must be a different item (e.g. "coated") from the one sent`);
    if (!(num(l?.qtySent) > 0)) add(`lines.${i}.qtySent`, "INVALID_QTY", `${n}: the quantity sent must be more than zero`);
    if (l?.finishedPerRaw !== undefined && l.finishedPerRaw !== "" && !(num(l.finishedPerRaw) > 0)) {
      add(`lines.${i}.finishedPerRaw`, "INVALID_QTY", `${n}: finished per unit sent must be more than zero`);
    }
  });
  return errors;
}

// The raw consumed by `finishedQty` finished units, from the line's ratio.
const rawFor = (line, finishedQty) => round3((Number(finishedQty) || 0) / (Number(line.finishedPerRaw) || 1));

// Checks a receipt against what is still at the job worker. Returns { errors, lines } with the numbers cleaned.
function validateReceipt(order, input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  const prog = new Map(progress(order).lines.map((l) => [l.lineId, l]));
  const byId = new Map((order.lines || []).map((l) => [idOf(l._id), l]));
  const out = [];
  (Array.isArray(input.lines) ? input.lines : []).forEach((r, i) => {
    const line = byId.get(idOf(r?.lineId));
    if (!line) return add(`lines.${i}.lineId`, "LINE_NOT_FOUND", `Line ${i + 1} is not on this job`);
    const finishedQty = num(r.finishedQty) || 0;
    const rawReturned = num(r.rawReturned) || 0;
    const rawConsumed = r.rawConsumed === undefined || r.rawConsumed === "" ? rawFor(line, finishedQty) : num(r.rawConsumed);
    const name = line.rawName || "this line";
    if ([finishedQty, rawReturned, rawConsumed].some((v) => !(v >= 0))) return add(`lines.${i}`, "INVALID_QTY", `${name}: quantities cannot be negative`);
    if (!finishedQty && !rawReturned) return; // nothing back on this line
    if (finishedQty > 0 && !(rawConsumed > 0)) return add(`lines.${i}.rawConsumed`, "INVALID_QTY", `${name}: say how many sent units were used`);
    const left = prog.get(idOf(line._id)).atWorker;
    if (rawConsumed + rawReturned > left + EPS) {
      return add(`lines.${i}`, "MORE_THAN_AT_WORKER", `${name}: only ${left} still with the job worker; ${round3(rawConsumed + rawReturned)} entered`);
    }
    out.push({ lineId: line._id, finishedQty: round3(finishedQty), rawConsumed: round3(rawConsumed), rawReturned: round3(rawReturned) });
  });
  if (!errors.length && !out.length) add("lines", "NOTHING_RECEIVED", "Enter what came back");
  return { errors, lines: out };
}

// The cost lines of a receipt (coating, transport) spread over the items that came back, in proportion to `weights`
// (the value of the raw parts each one used). Each share is rounded to the fils and the last takes the remainder, so the
// shares of every cost add up to it exactly. Returns one list of cost lines per weight (a zero share is left out).
function splitCosts(costs = [], weights = []) {
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const total = weights.reduce((s, w) => s + (Number(w) > 0 ? Number(w) : 0), 0);
  const share = (i) => (total > 0 ? (Number(weights[i]) > 0 ? Number(weights[i]) / total : 0) : 1 / weights.length);
  const out = weights.map(() => []);
  for (const c of costs) {
    const amount = round2(c.amount);
    let given = 0;
    weights.forEach((_, i) => {
      const last = i === weights.length - 1;
      const part = last ? round2(amount - given) : round2(amount * share(i));
      given = round2(given + part);
      if (part > 0) out[i].push({ ...c, amount: part });
    });
  }
  return out;
}

// India (CGST Act s.143): inputs sent for job work must come back within one year, or the sending is a supply from
// the day they left. Other countries set no such limit here.
function returnByFor(country, sentDay) {
  if (String(country || "").toUpperCase() !== "IN" || !/^\d{4}-\d{2}-\d{2}$/.test(String(sentDay || ""))) return null;
  const [y, m, d] = sentDay.split("-").map(Number);
  const next = new Date(Date.UTC(y + 1, m - 1, d));
  if (next.getUTCMonth() !== m - 1) next.setUTCDate(0); // 29 Feb -> 28 Feb next year
  return next.toISOString().slice(0, 10);
}

// Open and past its return-by day (both "YYYY-MM-DD").
const isOverdue = (status, returnByDay, today) => OPEN.has(status) && Boolean(returnByDay) && returnByDay < today;

// Quantity of each raw item still with job workers, over open jobs: Map(stockId -> qty).
function withJobWorker(orders = []) {
  const out = new Map();
  for (const o of orders) {
    if (!OPEN.has(o.status)) continue;
    for (const l of progress(o).lines) {
      const line = o.lines.find((x) => idOf(x._id) === l.lineId);
      const key = idOf(line.rawStockId);
      if (l.atWorker > EPS) out.set(key, round3((out.get(key) || 0) + l.atWorker));
    }
  }
  return out;
}

module.exports = { OPEN, lineProgress, progress, validateOrder, validateReceipt, rawFor, splitCosts, returnByFor, isOverdue, withJobWorker };
