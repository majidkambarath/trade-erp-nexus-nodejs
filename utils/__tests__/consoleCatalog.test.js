// What the developer console is offered (utils/consoleCatalog.js): every optional feature filed under a module, the roles'
// reach per module, and the time zones the books can be kept in. These are guards: a feature or module added to the
// product without being filed here fails a test instead of showing up in the console as an unexplained loose switch.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../consoleCatalog");
const plans = require("../plans");
const perms = require("../permissions");
const tz = require("../tz");

test("every optional feature is filed under exactly one module, and says what it does", () => {
  const features = C.featureCatalogue();
  assert.deepEqual(features.map((f) => f.key), Object.keys(plans.FEATURES), "none left out, none invented");
  const placed = C.moduleCatalogue().flatMap((m) => m.sections.filter((s) => typeof s === "object").map((s) => [s.feature, m.key]));
  assert.equal(new Set(placed.map(([f]) => f)).size, placed.length, "a feature appears under one module only");
  for (const f of features) {
    assert.ok(f.module, `${f.key} is not filed under any module: add it to MODULE_INFO in utils/consoleCatalog.js`);
    assert.ok(plans.MODULE_KEYS.includes(f.module), `${f.key} is filed under ${f.module}, which is not a module`);
    assert.deepEqual(placed.find(([k]) => k === f.key), [f.key, f.module], "the feature and the module's own list agree");
    assert.ok(f.hint && f.hint.length > 10, `${f.key} needs a sentence saying what it is`);
  }
});

test("production sits under Inventory, is opt-in, and reads as a short name", () => {
  const production = C.featureCatalogue().find((f) => f.key === "production");
  assert.equal(production.module, "inventory");
  assert.equal(production.optIn, true);
  assert.equal(production.label, "Production");
  assert.equal(C.featureCatalogue().find((f) => f.key === "quotations").module, "sales");
  assert.equal(C.featureCatalogue().find((f) => f.key === "batches").module, "inventory");
});

test("the UAE-only features say so, and nothing else does", () => {
  const only = C.featureCatalogue().filter((f) => f.onlyIn).map((f) => [f.key, f.onlyIn]);
  assert.deepEqual(only, [["vatReturn", ["AE"]], ["einvoicing", ["AE"]]]);
});

test("every module is in a group the console draws, with its actions named in words", () => {
  const groups = new Set(C.GROUPS.map((g) => g.key));
  const modules = C.moduleCatalogue();
  assert.deepEqual(modules.map((m) => m.key), plans.MODULE_KEYS);
  for (const m of modules) {
    assert.ok(groups.has(m.group), `${m.key} is in an unknown group ${m.group}`);
    assert.ok(m.actions.length > 0 && m.actions.every((a) => a.short && a.label), `${m.key} has an unnamed action`);
    assert.deepEqual(m.actions.map((a) => a.action), Object.keys(perms.MODULES[m.key].actions), "the same actions the permissions have, in order");
  }
  assert.deepEqual(modules.find((m) => m.key === "reports").alwaysOn, ["view"], "what no plan can take away is still reported");
  assert.equal(modules.find((m) => m.key === "sales").actions.find((a) => a.action === "create").short, "Add");
});

test("a role's reach is what it really holds, implied permissions included", () => {
  const roles = C.roleCatalogue();
  assert.deepEqual(roles.map((r) => r.key), perms.BUILT_IN_KEYS);
  const owner = roles.find((r) => r.key === "super_admin");
  assert.deepEqual(owner.modules.sales, Object.keys(perms.MODULES.sales.actions).sort(), "the owner holds every sales action");
  const viewer = roles.find((r) => r.key === "viewer");
  assert.deepEqual(viewer.modules.sales, ["view"]);
  assert.equal(viewer.modules.users, undefined, "a viewer has nothing in Users and roles");
  const storekeeper = roles.find((r) => r.key === "storekeeper");
  assert.ok(storekeeper.modules.inventory.includes("adjust"));
  assert.equal(storekeeper.modules.finance, undefined);
  assert.ok(storekeeper.modules.lookups.includes("view"), "doing anything beyond looking brings the pick lists, as the role table says");
});

test("the time zones offered are the ones the server accepts, under their current names, each once", () => {
  // what a browser or Node actually lists today: India as Asia/Calcutta, which is not the name anyone looks for
  const list = C.zoneList(["Asia/Calcutta", "Asia/Kolkata", "Asia/Dubai", "America/New_York", "Europe/London", "Asia/Katmandu", "Asia/Saigon"]);
  assert.deepEqual(list, ["Asia/Dubai", "Asia/Ho_Chi_Minh", "Asia/Kathmandu", "Asia/Kolkata", "Europe/London"]);
  assert.ok(!list.includes("America/New_York"), "west of UTC is refused by the server, so it is not offered");
  const real = C.zoneList();
  assert.ok(real.includes("Asia/Kolkata"), "India is offered under the name the console suggests for it");
  assert.ok(!real.includes("Asia/Calcutta"));
  for (const zone of real) assert.equal(tz.supportedZone(zone).ok, true, `${zone} would be refused`);
  assert.equal(new Set(real).size, real.length);
});

test("an alias still stores and reads as the same clock", () => {
  const at = new Date("2026-10-21T00:00:00Z");
  for (const [old, current] of Object.entries(C.ZONE_ALIASES)) {
    if (!tz.supportedZone(old).ok) continue;
    assert.equal(tz.offsetMinutes(at, old), tz.offsetMinutes(at, current), `${old} and ${current} differ`);
  }
});
