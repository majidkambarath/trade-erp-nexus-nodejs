const test = require("node:test");
const assert = require("node:assert/strict");
const { assertResettable, KEEP } = require("../../scripts/demo/demoReset");

const base = { code: "sahara", uri: "mongodb+srv://u:p@cluster0.example.net/ERP", nodeEnv: "development", org: { demo: true } };

test("a demo organisation may be reset", () => {
  assert.equal(assertResettable(base), "cluster0.example.net");
});

test("an organisation without the demo flag is refused", () => {
  for (const org of [{}, { demo: false }, { demo: "true" }, { demo: 1 }]) {
    assert.throws(() => assertResettable({ ...base, org }), /not marked as a demonstration company/);
  }
});

test("a missing organisation, code, uri or the wrong host is refused", () => {
  assert.throws(() => assertResettable({ ...base, org: null }), /no organisation/);
  assert.throws(() => assertResettable({ ...base, code: null }), /--org/);
  assert.throws(() => assertResettable({ ...base, uri: "" }), /MONGO_URI/);
  assert.throws(() => assertResettable({ ...base, expectHost: "golden-arrow" }), /wrong cluster/);
  assert.throws(() => assertResettable({ ...base, nodeEnv: "test" }), /NODE_ENV=test/);
});

test("only identity and sending setup survive a reset", () => {
  for (const k of ["transactions", "vouchers", "ledgerentries", "customers", "companysettings", "numberseries"]) {
    assert.equal(KEEP.has(k), false, k);
  }
  assert.equal(KEEP.has("admins"), true);
});
