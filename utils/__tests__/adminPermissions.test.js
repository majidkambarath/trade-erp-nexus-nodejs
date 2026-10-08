// Who may do what to user accounts: pure, so the whole table runs with no server and no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ALL, permissionsFor, mayManage, withoutSystemFields } = require("../adminPermissions");

test("each account type carries only what it needs; nobody but a super admin can restore backups", () => {
  assert.deepEqual(permissionsFor("super_admin").sort(), [...ALL].sort());
  assert.ok(!permissionsFor("admin").includes("backup_restore"));
  assert.ok(permissionsFor("admin").includes("users_manage"));
  assert.deepEqual(permissionsFor("viewer"), ["financial_reports"]);
  assert.ok(!permissionsFor("operator").includes("transactions_approve"), "an operator enters documents, a manager approves them");
  assert.ok(permissionsFor("manager").includes("transactions_approve"));
  for (const t of ["manager", "operator", "viewer"]) {
    assert.ok(!permissionsFor(t).includes("users_manage"), `${t} cannot manage users`);
    assert.ok(!permissionsFor(t).includes("system_settings"), `${t} cannot change settings`);
  }
});

test("an unknown type gets nothing, never everything", () => {
  assert.deepEqual(permissionsFor("root"), []);
  assert.deepEqual(permissionsFor(undefined), []);
  assert.deepEqual(permissionsFor(null), []);
});

test("permissionsFor returns a copy, so a caller cannot widen a type for everyone", () => {
  permissionsFor("viewer").push("backup_restore");
  assert.deepEqual(permissionsFor("viewer"), ["financial_reports"]);
});

test("only a super admin or an admin manages accounts at all", () => {
  for (const actor of ["manager", "operator", "viewer", undefined, null, "root"]) {
    const v = mayManage({ actor, target: "viewer", action: "update" });
    assert.equal(v.ok, false, String(actor));
    assert.equal(v.code, "INSUFFICIENT_ROLE");
  }
});

test("a super admin may do anything except remove themselves", () => {
  assert.equal(mayManage({ actor: "super_admin", target: "admin", nextType: "super_admin" }).ok, true);
  assert.equal(mayManage({ actor: "super_admin", target: "viewer", action: "delete" }).ok, true);
  const self = mayManage({ actor: "super_admin", target: "super_admin", self: true, action: "delete" });
  assert.equal(self.ok, false);
  assert.equal(self.code, "CANNOT_REMOVE_SELF");
});

test("an admin cannot make anyone, themselves included, more powerful than an admin", () => {
  assert.equal(mayManage({ actor: "admin", target: "viewer", nextType: "manager" }).ok, true);
  for (const next of ["admin", "super_admin"]) {
    const v = mayManage({ actor: "admin", target: "viewer", nextType: next });
    assert.equal(v.ok, false, next);
    assert.equal(v.code, "SUPER_ADMIN_REQUIRED");
  }
  // promoting yourself is the same thing
  assert.equal(mayManage({ actor: "admin", target: "admin", nextType: "super_admin", self: true }).ok, false);
});

test("an admin cannot touch an admin or super admin account at all", () => {
  for (const target of ["admin", "super_admin"]) {
    for (const action of ["update", "delete"]) {
      const v = mayManage({ actor: "admin", target, action });
      assert.equal(v.ok, false, `${action} ${target}`);
      assert.equal(v.code, "SUPER_ADMIN_REQUIRED");
    }
  }
});

test("nobody removes their own account, so an organisation cannot lock itself out", () => {
  assert.equal(mayManage({ actor: "admin", target: "manager", self: true, action: "delete" }).code, "CANNOT_REMOVE_SELF");
});

test("a request body can never set the system's own fields", () => {
  const clean = withoutSystemFields({ name: "Ali", permissions: ["backup_restore"], createdBy: "x", loginAttempts: 0, lockUntil: null, _id: "y", type: "viewer" });
  assert.deepEqual(clean, { name: "Ali", type: "viewer" });
  assert.deepEqual(withoutSystemFields(undefined), {});
});
