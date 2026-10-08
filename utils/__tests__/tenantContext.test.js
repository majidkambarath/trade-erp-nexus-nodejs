// The ambient organisation scope: pure, no database. The properties that matter are that the scope follows
// the work across every kind of asynchrony, that two requests in flight never see each other's, and that
// with the legacy default off, "no scope" is an error and never a quiet default.
const test = require("node:test");
const assert = require("node:assert/strict");
const ctx = require("../tenantContext");
const { getTenant } = require("../tenant");

const withLegacy = async (value, fn) => {
  const saved = process.env.TENANT_LEGACY_DEFAULT;
  if (value === undefined) delete process.env.TENANT_LEGACY_DEFAULT; else process.env.TENANT_LEGACY_DEFAULT = value;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TENANT_LEGACY_DEFAULT; else process.env.TENANT_LEGACY_DEFAULT = saved; }
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("with no scope and the legacy default switched on, the single default organisation is used", async () => {
  await withLegacy("1", () => {
    assert.deepEqual(getTenant(), { companyId: "default", branchId: "main" });
    assert.deepEqual(ctx.tenantForQuery(), ctx.DEFAULT_TENANT);
  });
});

test("with the legacy default off (as it is unless asked for), no scope is an error and never a default", async () => {
  await withLegacy("0", () => {
    assert.throws(() => getTenant(), { code: "NO_TENANT_SCOPE" });
    assert.throws(() => ctx.tenantForQuery(), { code: "NO_TENANT_SCOPE" });
  });
  for (const off of ["false", "off", "NO", " 0 "]) await withLegacy(off, () => assert.throws(() => getTenant(), { code: "NO_TENANT_SCOPE" }, off));
});

test("a scope is read back, with the branch defaulting to the head office", async () => {
  await withLegacy("0", () => {
    ctx.runWithTenant({ companyId: "acme" }, () => assert.deepEqual(getTenant(), { companyId: "acme", branchId: "main" }));
    ctx.runWithTenant({ companyId: "acme", branchId: "dxb" }, () => assert.deepEqual(getTenant(), { companyId: "acme", branchId: "dxb" }));
  });
});

test("the scope follows await, timers, promise chains, Promise.all and nested async functions", async () => {
  await withLegacy("0", () =>
    ctx.runWithTenant({ companyId: "acme" }, async () => {
      const seen = [];
      const note = () => seen.push(getTenant().companyId);
      note();
      await tick(5); note();
      await Promise.all([tick(3).then(note), (async () => { await tick(1); note(); })()]);
      await new Promise((r) => setTimeout(() => { note(); r(); }, 2));
      await Promise.resolve().then(() => tick(1)).then(note);
      setImmediate(note);
      await tick(5);
      assert.deepEqual([...new Set(seen)], ["acme"]);
      assert.ok(seen.length >= 7);
    })
  );
});

test("two requests in flight at once never see each other's organisation", async () => {
  await withLegacy("0", async () => {
    const run = (companyId, delays) =>
      ctx.runWithTenant({ companyId }, async () => {
        const seen = [];
        for (const d of delays) { await tick(d); seen.push(getTenant().companyId); }
        return seen;
      });
    const [a, b, c] = await Promise.all([run("A", [1, 9, 2, 6]), run("B", [7, 1, 8, 1]), run("C", [3, 3, 3, 3])]);
    assert.deepEqual([...new Set(a)], ["A"]);
    assert.deepEqual([...new Set(b)], ["B"]);
    assert.deepEqual([...new Set(c)], ["C"]);
  });
});

test("a nested scope applies inside and the outer one returns after", async () => {
  await withLegacy("0", () =>
    ctx.runWithTenant({ companyId: "outer" }, async () => {
      await ctx.runWithTenant({ companyId: "inner" }, async () => { await tick(1); assert.equal(getTenant().companyId, "inner"); });
      assert.equal(getTenant().companyId, "outer");
    })
  );
});

test("an invalid scope is refused", () => {
  for (const bad of [undefined, null, {}, { companyId: "" }, { companyId: "  " }, { companyId: 7 }]) {
    assert.throws(() => ctx.runWithTenant(bad, () => {}), { code: "TENANT_INVALID" }, JSON.stringify(bad));
  }
});

test("an unscoped block has no filter, no tenant, and needs a stated reason", async () => {
  await withLegacy("0", () => {
    assert.throws(() => ctx.runUnscoped("", () => {}), { code: "UNSCOPED_NEEDS_REASON" });
    assert.throws(() => ctx.runUnscoped("because", () => {}), { code: "UNSCOPED_NEEDS_REASON" });
    ctx.runUnscoped("a developer console report that spans organisations", () => {
      assert.equal(ctx.tenantForQuery(), null, "no filter is applied");
      assert.equal(ctx.isUnscoped(), true);
      assert.throws(() => getTenant(), { code: "UNSCOPED_HAS_NO_TENANT" }, "asking for an organisation inside an unscoped block is a bug");
    });
    assert.equal(ctx.isUnscoped(), false, "the block does not leak out");
  });
});

test("every use of the escape hatch is counted by its reason, so a review can see where protection is off", () => {
  const reason = "a counting test that is only here to be counted";
  const before = ctx.unscopedStats()[reason] || 0;
  ctx.runUnscoped(reason, () => {});
  ctx.runUnscoped(reason, () => {});
  assert.equal(ctx.unscopedStats()[reason], before + 2);
});

test("a tenant the auth middleware attached to the request is honoured, and cannot contradict the scope", async () => {
  await withLegacy("0", () => {
    assert.deepEqual(getTenant({ tenant: { companyId: "acme", branchId: "dxb" } }), { companyId: "acme", branchId: "dxb" });
    ctx.runWithTenant({ companyId: "acme" }, () => {
      assert.equal(getTenant({ tenant: { companyId: "acme" } }).companyId, "acme");
      assert.throws(() => getTenant({ tenant: { companyId: "someone-else" } }), { code: "TENANT_MISMATCH" });
    });
  });
});

test("a scope error is a server fault, never a message shown to the person", () => {
  const e = new ctx.TenantScopeError("x");
  assert.equal(e.statusCode, 500);
  assert.equal(e.isOperational, false);
});

test("a lazy query returned from a scope runs INSIDE it, not after it has ended", async () => {
  // A Mongoose query does nothing until awaited. runWithTenant(t, () => Model.find()) used to hand back the
  // un-run query, which then executed with no organisation in scope. This stands in for one.
  const lazy = (label, seen) => ({
    then(resolve, reject) { return this.exec().then(resolve, reject); },
    exec() { seen[label] = ctx.currentScope()?.unscoped ? "unscoped" : ctx.ambientTenant()?.companyId; return Promise.resolve(label); },
  });
  const seen = {};
  assert.equal(await ctx.runWithTenant({ companyId: "acme" }, () => lazy("scoped", seen)), "scoped");
  assert.equal(seen.scoped, "acme", "the query saw the organisation");
  assert.equal(await ctx.runUnscoped("a lazy query inside an unscoped block", () => lazy("open", seen)), "open");
  assert.equal(seen.open, "unscoped");
  // a plain value and an async callback are untouched
  assert.equal(ctx.runWithTenant({ companyId: "acme" }, () => 7), 7);
  assert.equal(await ctx.runWithTenant({ companyId: "acme" }, async () => "done"), "done");
});
