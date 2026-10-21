// Pure rules of job work (utils/jobWork.js), and the party tax number following the organisation's country
// (utils/partyMaster.js: a UAE TRN, an Indian GSTIN - which the job-work challan prints - or a plain tax number).
const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../jobWork");
const { resolveVat, isValidTrn, taxIdRule } = require("../partyMaster");

const RAW = "a".repeat(24), FIN = "b".repeat(24), V = "c".repeat(24);
const order = (over = {}) => ({
  status: "SENT",
  lines: [{ _id: "L1", rawStockId: RAW, rawName: "Holder raw", qtySent: 10, finishedStockId: FIN, finishedPerRaw: 1, unitValue: 50 }],
  receipts: [],
  ...over,
});
const codes = (input) => J.validateOrder(input).map((e) => e.code);

test("validateOrder: a job worker and lines that send one item and bring back another", () => {
  assert.deepEqual(codes({ jobWorkerId: V, lines: [{ rawStockId: RAW, finishedStockId: FIN, qtySent: 5 }] }), []);
  assert.deepEqual(codes({}), ["JOB_WORKER_REQUIRED", "NOTHING_TO_SEND"]);
  assert.deepEqual(codes({ jobWorkerId: V, lines: [{ rawStockId: RAW, finishedStockId: RAW, qtySent: 5 }] }), ["SAME_ITEM"]);
  assert.deepEqual(codes({ jobWorkerId: V, lines: [{ rawStockId: RAW, finishedStockId: FIN, qtySent: 0 }] }), ["INVALID_QTY"]);
  assert.deepEqual(codes({ jobWorkerId: V, lines: [{ rawStockId: RAW, finishedStockId: FIN, qtySent: 5, finishedPerRaw: 0 }] }), ["INVALID_QTY"]);
});

test("progress: what is still with the job worker, and the status that follows", () => {
  assert.deepEqual([J.progress(order()).atWorker, J.progress(order()).status], [10, "SENT"]);
  const part = order({ receipts: [{ lines: [{ lineId: "L1", finishedQty: 6, rawConsumed: 6, rawReturned: 0 }] }] });
  assert.deepEqual([J.progress(part).atWorker, J.progress(part).status], [4, "PARTLY_RECEIVED"]);
  const done = order({ receipts: [...part.receipts, { lines: [{ lineId: "L1", finishedQty: 3, rawConsumed: 3, rawReturned: 1 }] }] });
  const p = J.progress(done);
  assert.deepEqual([p.atWorker, p.status, p.lines[0].finished, p.lines[0].returned], [0, "RECEIVED", 9, 1]);
  const reversed = order({ status: "RECEIVED", receipts: [{ reversedAt: new Date(), lines: [{ lineId: "L1", finishedQty: 10, rawConsumed: 10 }] }] });
  assert.deepEqual([J.progress(reversed).atWorker, J.progress(reversed).status], [10, "SENT"], "a reversed receipt counts for nothing");
  assert.equal(J.progress(order({ status: "DRAFT" })).status, "DRAFT");
});

test("validateReceipt: pre-fills the raw used from the ratio and never takes back more than is out", () => {
  const two = order({ lines: [{ ...order().lines[0], finishedPerRaw: 2 }] });
  const r = J.validateReceipt(two, { lines: [{ lineId: "L1", finishedQty: 8 }] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines.map((l) => [l.finishedQty, l.rawConsumed, l.rawReturned]), [[8, 4, 0]], "two finished from each raw: 8 used 4");
  assert.equal(J.validateReceipt(order(), { lines: [{ lineId: "L1", finishedQty: 8, rawReturned: 3 }] }).errors[0].code, "MORE_THAN_AT_WORKER");
  assert.equal(J.validateReceipt(order(), { lines: [{ lineId: "L1" }] }).errors[0].code, "NOTHING_RECEIVED");
  assert.equal(J.validateReceipt(order(), { lines: [{ lineId: "nope", finishedQty: 1 }] }).errors[0].code, "LINE_NOT_FOUND");
  assert.equal(J.validateReceipt(order(), { lines: [{ lineId: "L1", finishedQty: -1 }] }).errors[0].code, "INVALID_QTY");
  const back = J.validateReceipt(order(), { lines: [{ lineId: "L1", rawReturned: 2 }] });
  assert.deepEqual(back.lines.map((l) => [l.finishedQty, l.rawConsumed, l.rawReturned]), [[0, 0, 2]], "returned unprocessed alone is a receipt too");
});

test("splitCosts: each cost spread by value, adding up to the fils", () => {
  const shares = J.splitCosts([{ accountId: "coat", amount: 100 }, { accountId: "trans", amount: 0.05 }], [50, 100]);
  assert.deepEqual(shares.map((s) => s.map((c) => [c.accountId, c.amount])), [[["coat", 33.33], ["trans", 0.02]], [["coat", 66.67], ["trans", 0.03]]]);
  assert.deepEqual(J.splitCosts([{ amount: 9 }], [0, 0, 0]).map((s) => s[0].amount), [3, 3, 3], "no value to weigh by: equal shares");
  assert.deepEqual(J.splitCosts([], [1]), [[]]);
});

test("returnByFor: one year in India (s.143), nothing elsewhere", () => {
  assert.equal(J.returnByFor("IN", "2026-10-18"), "2027-10-18");
  assert.equal(J.returnByFor("in", "2028-02-29"), "2029-02-28", "29 February comes back on the 28th");
  assert.equal(J.returnByFor("AE", "2026-10-18"), null);
  assert.equal(J.isOverdue("SENT", "2026-10-17", "2026-10-18"), true);
  assert.equal(J.isOverdue("RECEIVED", "2026-10-17", "2026-10-18"), false);
  assert.equal(J.isOverdue("PARTLY_RECEIVED", null, "2026-10-18"), false);
});

test("withJobWorker: open jobs only, by raw item", () => {
  const m = J.withJobWorker([
    order(),
    order({ receipts: [{ lines: [{ lineId: "L1", finishedQty: 6, rawConsumed: 6 }] }] }),
    order({ status: "RECEIVED" }),
    order({ status: "DRAFT" }),
  ]);
  assert.deepEqual([...m.entries()], [[RAW, 14]]);
});

test("party tax number follows the organisation's country: TRN, GSTIN, or a plain tax number", () => {
  assert.equal(taxIdRule().label, "TRN", "no country reads as the UAE, as before");
  assert.equal(isValidTrn("100999888700003"), true);
  assert.equal(isValidTrn("27ABCDE1234F1Z5"), false, "a GSTIN is not a UAE TRN");
  assert.equal(isValidTrn("27ABCDE1234F1Z5", "IN"), true);
  assert.equal(isValidTrn("27ABCDE1234F1X5", "IN"), false, "the 14th character of a GSTIN is Z");
  assert.deepEqual(resolveVat({ input: { trn: " 27abcde1234f1z5 " }, country: "IN" }), { status: "registered", trn: "27ABCDE1234F1Z5", tradeLicenseNo: "" });
  assert.throws(() => resolveVat({ input: { trn: "100999888700003" }, country: "IN" }), { code: "INVALID_TRN", message: /GSTIN/ });
  assert.throws(() => resolveVat({ input: { status: "registered" }, country: "IN" }), { message: "Enter the GSTIN of a GST-registered party" });
  assert.throws(() => resolveVat({ input: { status: "registered" } }), { message: "Enter the TRN of a VAT-registered party" }, "the UAE wording is unchanged");
  assert.equal(resolveVat({ input: { trn: "GB123456789" }, country: "GB" }).trn, "GB123456789");
  assert.throws(() => resolveVat({ input: { trn: "12" }, country: "GB" }), { code: "INVALID_TRN" });
});
