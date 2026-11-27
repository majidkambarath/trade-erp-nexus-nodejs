// Restoring a deleted record over HTTP, against the real server in strict tenant mode: who may, another organisation's
// record, and ids that are not ids.
//
//   node --require ./utils/testSetup.js --test services/__tests__/auditRestoreHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./support/httpHarness");

const skip = H.skipReason();
let stack;
let call;
const tokens = {};

test.before(async () => {
  if (skip) return;
  stack = await H.startStack("rst");
  call = H.makeCaller(stack.base);
  const Org = require("../../models/core/organisationModel");
  const Admin = require("../../models/core/adminModel");
  for (const code of ["rsta", "rstb"]) {
    await Org.create({ legalName: `${code} Trading LLC`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
    const email = `owner@${code}.rst.test`;
    await stack.as(code, () => new Admin({ name: `Owner ${code}`, email, password: H.PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
    const r = await call("POST", "/login", { body: { email, password: H.PASSWORD } });
    assert.equal(r.status, 200, r.text);
    tokens[code] = r.body.tokens.accessToken;
  }
  // in A, a person who may read the audit log and nothing about items
  const role = await call("POST", "/access/roles", { token: tokens.rsta, body: { key: "auditor_only", name: "Auditor", rank: 30, permissions: ["audit.view"] } });
  assert.ok(role.status < 300, role.text);
  const hire = await call("POST", "/access/users", { token: tokens.rsta, body: { name: "Auditor", email: "auditor@rsta.rst.test", password: H.PASSWORD, role: "auditor_only" } });
  assert.ok(hire.status < 300, hire.text);
  await stack.as("rsta", () => Admin.updateOne({ email: "auditor@rsta.rst.test" }, { mustChangePassword: false }));
  const a = await call("POST", "/login", { body: { email: "auditor@rsta.rst.test", password: H.PASSWORD } });
  assert.equal(a.status, 200, a.text);
  tokens.auditor = a.body.tokens.accessToken;
});

test.after(async () => {
  if (stack) await stack.stop();
});

test("a deleted category comes back for someone who may add one, once, and for nobody else", { skip }, async () => {
  const made = await call("POST", "/categories/categories", { token: tokens.rsta, body: { name: "Restorable Spices", description: "kept" } });
  assert.ok(made.status < 300, made.text);
  const id = made.body?._id || made.body?.category?._id || made.data?.data?._id;
  assert.ok(id, made.text);
  const gone = await call("DELETE", `/categories/categories/${id}`, { token: tokens.rsta });
  assert.ok(gone.status < 300, gone.text);

  const list = await call("GET", "/accounting/deleted-records?entity=Category", { token: tokens.rsta });
  assert.equal(list.status, 200, list.text);
  const row = list.body.rows.find((r) => r.entityId === String(id));
  assert.ok(row, "the deleted category is listed");
  assert.equal(row.restorable, true);
  assert.equal(row.restored, false);

  // reading the audit log is not enough: putting a category back needs what adding one needs
  const auditor = await call("POST", `/accounting/deleted-records/${row._id}/restore`, { token: tokens.auditor });
  assert.equal(auditor.status, 403, auditor.text);
  assert.equal(auditor.code, "PERMISSION_DENIED");

  // another organisation never finds it
  const other = await call("POST", `/accounting/deleted-records/${row._id}/restore`, { token: tokens.rstb });
  assert.equal(other.status, 404, other.text);
  assert.equal(other.code, "DELETED_RECORD_NOT_FOUND");

  const ok = await call("POST", `/accounting/deleted-records/${row._id}/restore`, { token: tokens.rsta });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.restored, true);
  const back = await call("GET", `/categories/categories/${id}`, { token: tokens.rsta });
  assert.equal(back.status, 200, back.text);

  const again = await call("POST", `/accounting/deleted-records/${row._id}/restore`, { token: tokens.rsta });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.code, "ALREADY_RESTORED");

  const after = await call("GET", "/accounting/deleted-records?entity=Category", { token: tokens.rsta });
  assert.equal(after.body.rows.find((r) => r.entityId === String(id)).restored, true);
  const log = await call("GET", "/accounting/audit-log?action=CATEGORY_RESTORED", { token: tokens.rsta });
  assert.equal(log.body.rows.length, 1);
  assert.equal(log.body.rows[0].username, "owner@rsta.rst.test");
});

test("ids that are not ids are a plain 404, never a 500", { skip }, async () => {
  for (const bad of ["nope", "64b64b64b64b64b64b64b64b", "%7B%22%24ne%22%3Anull%7D", "constructor"]) {
    const r = await call("POST", `/accounting/deleted-records/${bad}/restore`, { token: tokens.rsta });
    assert.equal(r.status, 404, `${bad}: ${r.text}`);
  }
  const none = await call("POST", "/accounting/deleted-records/64b64b64b64b64b64b64b64b/restore");
  assert.equal(none.status, 401);
});
