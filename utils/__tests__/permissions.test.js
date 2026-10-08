// The permission catalogue and the built-in roles: pure, so every rule is a table with no server and no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../permissions");
const legacy = require("../adminPermissions");

const holds = (role, ...keys) => keys.every((k) => p.can(p.resolveRole(role).permissions, k));
const lacks = (role, ...keys) => keys.every((k) => !p.can(p.resolveRole(role).permissions, k));

test("the catalogue is consistent: every key is module.action, every implied key exists, no module is empty", () => {
  assert.ok(p.KEYS.length >= 30 && p.KEYS.length <= 40, `a size an administrator can read: ${p.KEYS.length}`);
  for (const k of p.KEYS) assert.match(k, /^[a-z]+\.[A-Za-z]+$/, k);
  for (const [key, implied] of Object.entries(p.IMPLIES)) {
    assert.ok(p.isKey(key), `${key} is a real permission`);
    for (const i of implied) assert.ok(p.isKey(i), `${key} implies ${i}, which must exist`);
  }
  for (const m of p.MODULE_KEYS) assert.ok(Object.keys(p.MODULES[m].actions).length > 0, m);
  for (const m of p.MODULE_KEYS.filter((x) => x !== "lookups")) assert.ok(p.isKey(`${m}.view`), `${m} can be looked at`);
});

test("expand: view comes with every other action, pick lists come with doing anything, and it is idempotent", () => {
  const got = p.expand(["sales.approve"]);
  assert.ok(got.includes("sales.view"), "approving means being able to see");
  assert.ok(got.includes("lookups.view"), "and being able to fill a form");
  assert.ok(got.includes("inventory.view"), "approving a sale checks stock");
  assert.deepEqual(p.expand(got), got, "expanding twice changes nothing");
  assert.deepEqual(p.expand(["sales.view"]), ["sales.view"], "looking alone brings nothing else");
  assert.deepEqual(p.expand(["audit.view", "users.view"]), ["audit.view", "users.view"], "and does not bring the pick lists");
  assert.ok(p.expand(["finance.create"]).includes("sales.view"), "a receipt is settled against invoices, which it must be able to see");
  assert.ok(p.expand(["reports.vat"]).includes("reports.view"), "filing a return implies reading the reports");
});

test("expand drops what does not exist rather than guessing, and unknownKeys names it", () => {
  assert.deepEqual(p.expand(["sales.fly", "nonsense", null, undefined]), []);
  assert.deepEqual(p.unknownKeys(["sales.view", "sales.fly"]), ["sales.fly"]);
  assert.deepEqual(p.expand(null), []);
});

test("every built-in role names only real permissions, and holds exactly what its expansion says", () => {
  for (const k of p.BUILT_IN_KEYS) {
    const role = p.BUILT_IN[k];
    assert.deepEqual(p.unknownKeys(role.permissions), [], `${k} names only real permissions`);
    assert.deepEqual(p.expand(role.permissions), role.permissions, `${k} is stored fully expanded`);
    assert.ok(role.name && role.description && Number.isInteger(role.rank), k);
  }
});

test("the five account types that existed before roles are all built-in roles, so every existing account keeps one", () => {
  for (const type of p.LEGACY_TYPES) assert.ok(p.isBuiltIn(type), type);
  assert.equal(p.roleKeyOf({ type: "manager" }), "manager", "no explicit role: the type is the role");
  assert.equal(p.roleKeyOf({ type: "manager", roleKey: "accountant" }), "accountant", "an explicit role wins");
});

test("ranks run from the owner down, and the three jobs at one level share a rank", () => {
  const r = (k) => p.BUILT_IN[k].rank;
  assert.ok(r("super_admin") > r("admin") && r("admin") > r("manager") && r("manager") > r("accountant"));
  assert.ok(r("accountant") > r("operator") && r("operator") > r("viewer"));
  assert.equal(r("sales"), r("purchase"));
  assert.equal(r("sales"), r("storekeeper"));
});

test("the headline cases: who can and cannot do the things that hurt", () => {
  // an operator enters documents, a manager approves them - the sentence the old table was written to say
  assert.ok(lacks("operator", "sales.approve", "purchase.approve", "finance.approve"));
  assert.ok(holds("manager", "sales.approve", "purchase.approve", "finance.approve"));
  // a sales clerk raises and sends an invoice but cannot approve it, and cannot open Finance or the books
  assert.ok(holds("sales", "sales.create", "sales.send"));
  assert.ok(lacks("sales", "sales.approve", "sales.delete", "sales.creditOverride", "finance.view", "accounts.view", "reports.financial"));
  // a storekeeper adjusts stock but touches no money
  assert.ok(holds("storekeeper", "inventory.adjust"));
  assert.ok(lacks("storekeeper", "finance.view", "finance.create", "sales.create", "accounts.view"));
  // a viewer changes nothing at all
  const writes = p.KEYS.filter((k) => !p.isRead(k));
  assert.deepEqual(p.resolveRole("viewer").permissions.filter((k) => writes.includes(k)), []);
  // nobody but an administrator manages people, settings, the chart or the period lock
  for (const role of ["manager", "accountant", "operator", "sales", "purchase", "storekeeper", "viewer"]) {
    assert.ok(lacks(role, "users.manage", "settings.manage", "accounts.close"), role);
  }
  // credit override and stock adjustment are not handed out by accident
  assert.ok(lacks("accountant", "sales.creditOverride", "inventory.adjust"));
  assert.ok(lacks("viewer", "sales.send"));
});

test("an unknown, missing or switched-off role holds nothing, never everything", () => {
  assert.equal(p.resolveRole("root"), null);
  assert.deepEqual(p.grantsOf(null), []);
  assert.deepEqual(p.grantsOf(p.resolveRole("ghost")), []);
  const off = p.resolveRole("lead", [{ key: "lead", name: "Lead", rank: 30, permissions: ["sales.view"], isActive: false }]);
  assert.equal(off.isActive, false);
  assert.deepEqual(p.grantsOf(off), [], "a role that has been switched off grants nothing");
  const on = p.resolveRole("lead", [{ key: "lead", name: "Lead", rank: 30, permissions: ["sales.create"], isActive: true }]);
  assert.ok(p.can(p.grantsOf(on), "sales.view"), "a custom role is expanded like a built-in one");
});

test("can and canAny: an empty or missing request is refused, not allowed", () => {
  const g = ["sales.view", "lookups.view"];
  assert.equal(p.can(g, "sales.view"), true);
  assert.equal(p.can(new Set(g), "sales.view"), true);
  assert.equal(p.can(g, "sales.approve"), false);
  assert.equal(p.can(undefined, "sales.view"), false);
  assert.equal(p.canAny(g, ["sales.approve", "lookups.view"]), true);
  assert.equal(p.canAny(g, []), false, "a guard that names nothing refuses");
  assert.equal(p.canAny(g, undefined), false);
});

test("the old coarse permissions the token carries are derived from the new ones and match what each type always had", () => {
  for (const type of p.LEGACY_TYPES) {
    const role = p.BUILT_IN[type];
    assert.deepEqual(p.legacyPermissions(role.permissions, role.rank).sort(), [...legacy.permissionsFor(type)].sort(), type);
  }
  assert.deepEqual(p.legacyPermissions([]), []);
});

test("who may manage whom: the rules the old table had, now by rank", () => {
  for (const actor of ["manager", "operator", "viewer", "accountant", "sales", undefined, null, "root"]) {
    const v = p.mayManage({ actor, target: "viewer", action: "update" });
    assert.equal(v.ok, false, String(actor));
    assert.equal(v.code, "INSUFFICIENT_ROLE");
  }
  assert.equal(p.mayManage({ actor: "super_admin", target: "admin", next: "super_admin" }).ok, true, "an owner may make another owner");
  assert.equal(p.mayManage({ actor: "super_admin", target: "viewer", action: "delete" }).ok, true);
  assert.equal(p.mayManage({ actor: "super_admin", target: "super_admin", self: true, action: "delete" }).code, "CANNOT_REMOVE_SELF");
  assert.equal(p.mayManage({ actor: "admin", target: "manager", next: "viewer" }).ok, true);
  assert.equal(p.mayManage({ actor: "admin", target: "storekeeper", next: "accountant" }).ok, true);
  assert.equal(p.mayManage({ actor: "admin", target: "super_admin" }).code, "SUPER_ADMIN_REQUIRED");
  assert.equal(p.mayManage({ actor: "admin", target: "admin" }).code, "SUPER_ADMIN_REQUIRED", "an admin cannot touch another admin");
  assert.equal(p.mayManage({ actor: "admin", target: "viewer", next: "admin" }).code, "SUPER_ADMIN_REQUIRED", "or make anyone one");
  assert.equal(p.mayManage({ actor: "admin", target: "admin", self: true, action: "delete" }).code, "CANNOT_REMOVE_SELF", "removing oneself is answered first, as it always was");
});

test("rank alone settles it for a custom role: a person may only touch, or make, someone below them", () => {
  const lead = { rank: 55, permissions: p.expand(["users.manage"]), isActive: true };
  const clerk = { rank: 30, permissions: p.expand(["sales.view"]), isActive: true };
  assert.equal(p.mayManage({ actor: lead, target: clerk, next: clerk }).ok, true);
  assert.equal(p.mayManage({ actor: lead, target: "manager" }).code, "RANK_TOO_LOW", "a manager outranks them");
  assert.equal(p.mayManage({ actor: lead, target: clerk, next: "manager" }).code, "RANK_TOO_LOW", "and they cannot promote beyond themselves");
  assert.equal(p.mayManage({ actor: lead, target: clerk, next: lead }).code, "RANK_TOO_LOW", "nor to their own level");
  const noUsers = { rank: 70, permissions: p.expand(["sales.approve"]), isActive: true };
  assert.equal(p.mayManage({ actor: noUsers, target: clerk }).code, "INSUFFICIENT_ROLE", "rank without users.manage is not enough");
});

const admin = p.resolveRole("admin");
const good = { key: "sales_lead", name: "Sales lead", rank: 55, permissions: ["sales.create", "sales.approve", "sales.send"] };

test("a custom role: a good one passes, and every way of building something too powerful is refused", () => {
  assert.deepEqual(p.validateCustomRole(good, admin), { ok: true, errors: {} });
  const bad = (over, actor = admin) => p.validateCustomRole({ ...good, ...over }, actor).errors;
  assert.ok(bad({ key: "manager" }).key, "a built-in key is taken");
  assert.ok(bad({ key: "Sales Lead" }).key, "a key is a plain slug");
  assert.ok(bad({ key: "" }).key);
  assert.ok(bad({ name: "  " }).name);
  assert.ok(bad({ rank: 80 }).rank, "not at the actor's own rank");
  assert.ok(bad({ rank: 95 }).rank, "not above the actor's");
  assert.ok(bad({ rank: 5 }).rank, "and not below the floor");
  assert.ok(bad({ rank: 55.5 }).rank);
  assert.ok(bad({ permissions: ["sales.fly"] }).permissions, "unknown permission");
  assert.equal(p.validateCustomRole({ ...good, rank: 90 }, "super_admin").ok, true, "an owner may go up to 90");
  assert.ok(p.validateCustomRole({ ...good, rank: 100 }, "super_admin").errors.rank, "never a second owner");
});

test("nobody can grant what they do not hold", () => {
  const accountantWithUsers = { rank: 70, permissions: p.expand(["users.manage", "finance.create"]), isActive: true };
  const r = p.validateCustomRole({ ...good, key: "x1", rank: 40, permissions: ["finance.create", "sales.approve"] }, accountantWithUsers);
  assert.equal(r.ok, false);
  assert.match(r.errors.permissions, /sales\.approve/, "names what was beyond them");
  assert.equal(p.validateCustomRole({ ...good, key: "x2", rank: 40, permissions: ["finance.create"] }, accountantWithUsers).ok, true);
  // an implied permission counts: they cannot smuggle sales.view in through sales.approve
  assert.equal(p.validateCustomRole({ ...good, key: "x3", rank: 40, permissions: ["sales.view"] }, accountantWithUsers).ok, true, "finance.create already brings sales.view");
});

test("editing an existing role does not re-check its key", () => {
  assert.equal(p.validateCustomRole({ ...good, key: "manager" }, admin, { isNew: false }).ok, true);
});

test("the catalogue the editor draws covers every key exactly once, and marks the automatic one", () => {
  const drawn = p.catalogue().flatMap((m) => m.actions.map((a) => a.key));
  assert.deepEqual([...drawn].sort(), [...p.KEYS].sort());
  assert.equal(new Set(drawn).size, drawn.length);
  assert.deepEqual(p.catalogue().filter((m) => m.automatic).map((m) => m.key), ["lookups"]);
  for (const m of p.catalogue()) assert.ok(m.label && m.actions.every((a) => a.label && a.short), m.key);
  const all = Object.fromEntries(p.catalogue().flatMap((m) => m.actions.map((a) => [a.key, a])));
  assert.deepEqual(all["sales.approve"].implies.sort(), ["inventory.view", "lookups.view", "sales.view"], "what ticking approve brings with it, for the editor to lock");
  assert.deepEqual(all["sales.view"].implies, []);
  assert.equal(all["reports.financial"].read, true);
  assert.equal(all["sales.create"].read, false);
  assert.equal(all["sales.create"].short, "Add and edit");
  assert.equal(all["users.manage"].short, "Manage people and roles");
});
