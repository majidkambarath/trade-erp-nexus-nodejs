const test = require("node:test");
const assert = require("node:assert/strict");
const { visibleTo, planRaise } = require("../notifications");

test("visibleTo: a row with no audience permission is visible to anyone signed in", () => {
  assert.equal(visibleTo({ audience: {} }, []), true);
  assert.equal(visibleTo({ audience: { permission: null } }, []), true);
});

test("visibleTo: a row naming a permission is visible only to grants that hold it", () => {
  const row = { audience: { permission: "inventory.view" } };
  assert.equal(visibleTo(row, ["inventory.view"]), true);
  assert.equal(visibleTo(row, ["sales.view"]), false);
  assert.equal(visibleTo(row, []), false);
});

test("visibleTo: a row may belong to one person, and then both the person and the key must agree", () => {
  const mine = { audience: { permission: "crm.view", adminId: "64b64b64b64b64b64b64b6a1" } };
  assert.equal(visibleTo(mine, ["crm.view"], "64b64b64b64b64b64b64b6a1"), true);
  assert.equal(visibleTo(mine, ["crm.view"], "64b64b64b64b64b64b64b6b2"), false, "somebody else's overdue follow-up is not news for me");
  assert.equal(visibleTo(mine, ["sales.view"], "64b64b64b64b64b64b64b6a1"), false, "and the right person still needs the key");
  assert.equal(visibleTo(mine, ["crm.view"]), false, "with nobody named, a row that belongs to somebody is not shown");
  assert.equal(visibleTo({ audience: { adminId: "64b64b64b64b64b64b64b6a1" } }, [], "64b64b64b64b64b64b64b6a1"), true, "a row for one person and no key is theirs");
});

test("planRaise: no existing row - create", () => {
  assert.equal(planRaise(null), "create");
  assert.equal(planRaise(undefined), "create");
});

test("planRaise: an open row for the same episode - touch, never resurface as unread", () => {
  assert.equal(planRaise({ resolvedAt: null }), "touch");
});

test("planRaise: a resolved row recurring - reopen, a fresh episode", () => {
  assert.equal(planRaise({ resolvedAt: new Date() }), "reopen");
});
