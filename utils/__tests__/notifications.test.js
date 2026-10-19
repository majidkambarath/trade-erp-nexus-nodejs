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
