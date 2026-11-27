// What changed, field by field (utils/auditDiff.js).
//   node --test utils/__tests__/auditDiff.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { changes, updatedPaths } = require("../auditDiff");

test("each changed field with its old and new value, nested fields by their path", () => {
  const id = new mongoose.Types.ObjectId();
  const before = { _id: id, customerName: "Al Noor", phone: "050 1", vat: { status: "registered", trn: "100" }, updatedAt: new Date(1), creditLimit: 500 };
  const after = { _id: id, customerName: "Al Noor", phone: "050 2", vat: { status: "registered", trn: "200" }, updatedAt: new Date(2), creditLimit: 500, notes: "new" };
  assert.deepEqual(changes(before, after), [
    { field: "notes", from: null, to: "new" },
    { field: "phone", from: "050 1", to: "050 2" },
    { field: "vat.trn", from: "100", to: "200" },
  ]);
});

test("ids, dates and lists are shown as an auditor reads them; unchanged ones are not reported", () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const out = changes({ owner: a, day: new Date("2026-01-01"), tags: ["x"] }, { owner: b, day: new Date("2026-01-01"), tags: ["x", "y"] });
  assert.deepEqual(out, [{ field: "owner", from: a.toHexString(), to: b.toHexString() }, { field: "tags", from: ["x"], to: ["x", "y"] }]);
  assert.deepEqual(changes({ owner: a }, { owner: new mongoose.Types.ObjectId(a.toHexString()) }), []);
  // blank and absent read the same
  assert.deepEqual(changes({ notes: "" }, {}), []);
});

test("a secret is reported as changed, never with its value; ignored fields are not reported", () => {
  const out = changes({ apiKeyEnc: "aaa", smtpPassEnc: "p", password: "x", cashBalance: 1 }, { apiKeyEnc: "bbb", smtpPassEnc: "q", password: "y", cashBalance: 2 }, { ignore: ["cashBalance"] });
  assert.deepEqual(out.map((c) => c.field), ["apiKeyEnc", "password", "smtpPassEnc"]);
  assert.ok(out.every((c) => c.from === "[hidden]" && c.to === "[hidden]"));
  assert.deepEqual(changes({ twoFactor: { lastStep: 1, enabled: false } }, { twoFactor: { lastStep: 2, enabled: true } }, { ignore: ["twoFactor.lastStep"] }), [
    { field: "twoFactor.enabled", from: false, to: true },
  ]);
});

test("a record created or deleted lists its fields; long text is cut; at most 100 changes", () => {
  assert.deepEqual(changes(null, { name: "A" }), [{ field: "name", from: null, to: "A" }]);
  assert.deepEqual(changes({ name: "A" }, null), [{ field: "name", from: "A", to: null }]);
  assert.equal(changes({}, { note: "x".repeat(400) })[0].to.length, 301);
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}`, i]));
  assert.equal(changes({}, many).length, 100);
});

test("the fields an update writes", () => {
  assert.deepEqual(updatedPaths({ $set: { "vat.trn": 1 }, $inc: { cashBalance: 2 }, name: "x" }).sort(), ["cashBalance", "name", "vat.trn"]);
  assert.deepEqual(updatedPaths([{ $set: { loginAttempts: 1 } }, { $set: { lockUntil: 2 } }]), ["loginAttempts", "lockUntil"]);
  assert.deepEqual(updatedPaths(null), []);
});
