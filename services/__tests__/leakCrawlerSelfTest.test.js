// Can the data-bleed crawler SEE a leak? Before trusting tenantBleedHttp.test.js to say "nothing leaked", prove that the very same
// functions (support/leakCrawler.js) catch one. A tiny Express app is built here with routes that leak on purpose beside routes
// that are scoped correctly; the crawler is pointed at it as a spy from "organisation B" looking at "organisation A"'s records.
//
// No production code is touched, and no gate or filter is switched off to watch a test fail - the leaks live in this file.
// No database is needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const crypto = require("crypto");
const { makeCaller } = require("./support/httpHarness");
const { makeMarkers, findLeaks, crawl, snapshotDiff, expandPath } = require("./support/leakCrawler");

const oid = () => crypto.randomBytes(12).toString("hex");
const A_ID = oid();
const B_ID = oid();
const db = new Map([
  [A_ID, { _id: A_ID, tenant: "A", name: "CANARY-A-customer-1 Trading", price: 7391.47, note: "alpha" }],
  [B_ID, { _id: B_ID, tenant: "B", name: "CANARY-B-customer-1 Trading", price: 12.5, note: "bravo" }],
]);
const tenantOf = (req) => (req.get("authorization") || "").replace("Bearer ", ""); // the "token" IS the tenant in this toy app

let server, base, call;

test.before(async () => {
  const app = express();
  app.use(express.json());
  const r = express.Router();

  // ---- the LEAKS: no tenant check at all
  r.get("/leaky/:id", (req, res) => res.json({ success: true, data: db.get(req.params.id) ?? null }));
  r.get("/leaky-search", (req, res) => res.json({ success: true, data: [...db.values()].filter((d) => d.name.includes(String(req.query.q || ""))) }));
  r.get("/leaky-sum", (req, res) => res.json({ success: true, data: { total: 7391.47 + 12.5, ofA: 7391.47 } })); // an aggregate that adds in the other tenant
  r.put("/leaky/:id", (req, res) => { const d = db.get(req.params.id); if (d) Object.assign(d, req.body); res.json({ success: true, data: d ?? null }); });
  // ---- the CLEAN twins: every read and write is limited to the caller's own tenant
  r.get("/scoped/:id", (req, res) => {
    const d = db.get(req.params.id);
    if (!d || d.tenant !== tenantOf(req)) return res.status(404).json({ success: false, message: `No record ${req.params.id}` }); // echoes the id it was asked for
    return res.json({ success: true, data: d });
  });
  r.get("/scoped-search", (req, res) => res.json({ success: true, data: [...db.values()].filter((d) => d.tenant === tenantOf(req) && d.name.includes(String(req.query.q || ""))) }));
  r.get("/scoped-sum", (req, res) => res.json({ success: true, data: { total: [...db.values()].filter((d) => d.tenant === tenantOf(req)).reduce((s, d) => s + d.price, 0) } }));
  r.put("/scoped/:id", (req, res) => {
    const d = db.get(req.params.id);
    if (!d || d.tenant !== tenantOf(req)) return res.status(404).json({ success: false, message: "not found" });
    Object.assign(d, req.body);
    return res.json({ success: true, data: d });
  });
  // ---- a request that hangs, and one that crashes
  r.get("/slow", (_req, res) => setTimeout(() => res.json({ success: true }), 400));
  r.get("/boom", (_req, res) => res.status(500).json({ success: false, message: "Internal Server Error" }));
  app.use("/api/v1", r);

  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  call = makeCaller(base);
});
test.after(() => server?.close());

const markersOfA = () => makeMarkers({ strings: ["CANARY-A-customer-1"], numbers: ["7391.47"], ids: [A_ID] });
const asB = (requests) => crawl({ call, requests, token: "B", markers: markersOfA(), concurrency: 4, slowMs: 200 });

test("the scanner finds a canary, a whole-number amount and an id, and ignores look-alikes", () => {
  const m = markersOfA();
  assert.deepEqual(findLeaks(`{"name":"CANARY-A-customer-1 Trading"}`, m), ["text:CANARY-A-customer-1"]);
  assert.deepEqual(findLeaks(`{"price":7391.47}`, m), ["amount:7391.47"]);
  assert.deepEqual(findLeaks(`{"price":17391.47,"x":7391.475,"y":7391.4}`, m), [], "17391.47, 7391.475 and 7391.4 are different numbers");
  assert.deepEqual(findLeaks(`{"label":"Total 7391.47 AED"}`, m), ["amount:7391.47"], "an amount inside text is found too");
  assert.deepEqual(findLeaks(`{"id":"${A_ID}"}`, m), [`id:${A_ID}`]);
  assert.deepEqual(findLeaks(`{"id":"${A_ID.toUpperCase()}"}`, m), [`id:${A_ID}`], "case does not hide an id");
  assert.deepEqual(findLeaks(`No record ${A_ID}`, m, `/scoped/${A_ID}`), [], "an id the spy supplied itself may be echoed");
  assert.deepEqual(findLeaks(`{"id":"${B_ID}"}`, m), [], "another organisation's own id is not a leak of A's");
  assert.deepEqual(findLeaks("", m), []);
});

test("it CATCHES a route that returns another organisation's record by id, and a search that finds it", async () => {
  const out = await asB([
    { method: "GET", url: `/leaky/${A_ID}`, label: "leaky by id" },
    { method: "GET", url: `/leaky-search?q=CANARY-A`, label: "leaky search" },
    { method: "GET", url: `/leaky-sum`, label: "leaky aggregate" },
  ]);
  const leaked = out.leaks.map((l) => l.label).sort();
  assert.deepEqual(leaked, ["leaky aggregate", "leaky by id", "leaky search"], "all three leaks were seen");
  assert.ok(out.leaks.find((l) => l.label === "leaky by id").found.some((f) => f.startsWith("text:") || f.startsWith("amount:")));
  assert.ok(out.leaks.find((l) => l.label === "leaky aggregate").found.includes("amount:7391.47"), "an aggregate is caught by its figure, not only by a name");
});

test("it PASSES the correctly scoped twins: a 404 that echoes the asked-for id is not a leak", async () => {
  const out = await asB([
    { method: "GET", url: `/scoped/${A_ID}`, label: "scoped by id" },
    { method: "GET", url: `/scoped-search?q=CANARY-A`, label: "scoped search" },
    { method: "GET", url: `/scoped-sum`, label: "scoped aggregate" },
    { method: "GET", url: `/scoped/${B_ID}`, label: "scoped, B's own" },
  ]);
  assert.deepEqual(out.leaks, [], "nothing of A's came back");
  assert.equal(out.statuses[404], 1);
  assert.equal(out.statuses[200], 3);
  // and B's own record is readable: the clean route is clean because it is scoped, not because it is dead
  const own = out.rows.find((x) => x.r.label === "scoped, B's own");
  assert.equal(own.res.status, 200);
  assert.ok(own.res.text.includes("CANARY-B-customer-1"));
});

test("the same sweep notices a write that reached another organisation's data, through the snapshot", async () => {
  const snap = (tenant) => {
    const rows = [...db.values()].filter((d) => d.tenant === tenant).sort((x, y) => (x._id < y._id ? -1 : 1));
    return { records: { count: rows.length, digest: crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex") } };
  };
  const before = snap("A");
  const hit = await asB([{ method: "PUT", url: `/scoped/${A_ID}`, body: { name: "HACKED" }, label: "scoped write" }]);
  assert.equal(hit.statuses[404], 1);
  assert.deepEqual(snapshotDiff(before, snap("A")), [], "the scoped route changed nothing");

  const bad = await asB([{ method: "PUT", url: `/leaky/${A_ID}`, body: { name: "HACKED" }, label: "leaky write" }]);
  assert.equal(bad.statuses[200], 1, "the leaky route accepted B's write");
  const changes = snapshotDiff(before, snap("A"));
  assert.equal(changes.length, 1);
  assert.match(changes[0], /content changed/);
  assert.equal(snapshotDiff({ x: { count: 2, digest: "a" } }, { x: { count: 3, digest: "b" } })[0], "x: 2 -> 3 documents");
  assert.deepEqual(snapshotDiff({}, {}), []);
  db.get(A_ID).name = "CANARY-A-customer-1 Trading"; // put the toy record back
});

test("it flags a request that hangs and a server error, so a regex bomb or a crash cannot pass as 'nothing leaked'", async () => {
  const out = await asB([{ method: "GET", url: "/slow", label: "slow" }, { method: "GET", url: "/boom", label: "boom" }]);
  assert.deepEqual(out.slow.map((s) => s.label), ["slow"]);
  assert.deepEqual(out.serverErrors.map((s) => s.label), ["boom"]);
});

test("route parameters are filled from the victim's real values, a bounded number of times", () => {
  const urls = expandPath("/a/:id/b/:month", (n) => (n === "id" ? ["x1", "x2", "x3"] : ["1", "2"]), 4);
  assert.equal(urls.length, 4);
  assert.ok(urls.every((u) => /^\/a\/x\d\/b\/\d$/.test(u)));
  assert.deepEqual(expandPath("/plain", () => ["z"]), ["/plain"]);
  assert.deepEqual(expandPath("/a/:id", () => ["a b/c"]), ["/a/a%20b%2Fc"], "values are URL-encoded");
});
