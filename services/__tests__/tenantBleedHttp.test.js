// DATA BLEED. Two organisations (alphaorg and bravoorg) are filled with recognisable data through the product's own routes:
// every record carries a canary (CANARY-A-<kind>-<n>) and the money uses amounts nothing else uses. Then a SPY from one
// organisation walks the WHOLE API (the route inventory is read live from the code, so a new route is swept with no edit
// here) aimed at the other's ids, and the sweep looks for any of the victim's canaries, amounts, record ids or company code in
// any response, and for any change to the victim's data afterwards - read back over HTTP and straight from the database.
//
// The crawler's own ability to see a leak is proved in leakCrawlerSelfTest.test.js against a tiny app that leaks on purpose.
// Run alone:  node --require ./utils/testSetup.js --test services/__tests__/tenantBleedHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const H = require("./support/httpHarness");
const L = require("./support/leakCrawler");
const { inventory } = require("./support/routeInventory");
const { seedOrg, loadAllModels, ownedIds, PDF, day, today } = require("./support/seedOrg");
const { modelsFor } = require("./support/routeHints");
const { hmac } = require("../../utils/secretBox");

const skip = H.skipReason();
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RANDOM_ID = "64b64b64b64b64b64b64b64b";
const A = "alphaorg";
const B = "bravoorg";

let stack, call;
const R = {}; // R.A, R.B: what each organisation was seeded with
const log = (m) => process.stderr.write(`    # ${m}\n`);
const strip = (p) => p.slice("/api/v1".length) || "/";

const routes = inventory().filter((r) => r.identity === "organisation" && r.gate !== "public");
const GET_ROUTES = routes.filter((r) => r.method === "GET");
// A route that changes only the signed-in person's own record is not an attack surface for another organisation's data
// (the mass-assignment sweep covers it).
const MUT_ROUTES = routes.filter((r) => MUTATING.has(r.method) && r.gate !== "signedIn");

/** The values a route's :params are tried with: the victim's REAL ones (by kind), plus a random id. */
function valuesFor(route, victim) {
  const hinted = modelsFor(route);
  const models = hinted || Object.keys(victim.dbIds);
  const ids = models.flatMap((m) => (victim.dbIds[m] || []).slice(0, hinted ? 3 : 1));
  const x = victim.extra;
  const strings = {
    customerId: [x.customerCode], vendorId: [x.vendorCode], staffId: [x.staffCode], itemId: [x.itemCode],
    code: [x.branchCode, x.currencyCode], branch: [x.branchCode], key: [x.roleKey], type: ["receipt", "sales_order", "customer"],
    status: ["APPROVED", "active"], month: ["1", "10"], token: [x.shareToken], org: [victim.code],
  };
  return (name) => [...new Set([...(strings[name] ? strings[name].filter(Boolean) : ids), RANDOM_ID])];
}

/** One long query string naming the victim's records under every parameter name a list or report might read. */
function kitchenSink(victim) {
  const id = (m) => victim.dbIds[m]?.[0];
  const q = {
    accountId: id("LedgerAccount"), partyId: id("Customer"), customerId: id("Customer"), vendorId: id("Vendor"), itemId: id("Stock"), stockId: id("Stock"),
    transactionId: id("Transaction"), sourceId: id("Transaction"), invoiceId: id("Transaction"), orderId: id("Transaction"), voucherId: id("Voucher"),
    ownerId: id("LedgerAccount"), ownerType: "account", partyType: "customer", categoryId: id("Category"), unitId: id("UOM"), bankId: id("BankMaster"),
    fromAccountId: id("LedgerAccount"), toAccountId: id("LedgerAccount"), id: id("Customer"), from: "2000-01-01", to: "2100-12-31", asOf: "2100-12-31", dateFrom: "2000-01-01", dateTo: "2100-12-31",
    limit: "500", page: "1", reportType: "trial_balance",
  };
  return Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

/** Every request the GET sweep makes for one route. */
function getRequests(route, victim) {
  const sink = kitchenSink(victim);
  const out = [];
  if (!route.params.length) {
    out.push({ method: "GET", url: strip(route.path), label: route.key, meta: { route } });
    out.push({ method: "GET", url: `${strip(route.path)}?${sink}`, label: `${route.key} +ids`, meta: { route } });
    return out;
  }
  const ids = L.expandPath(strip(route.path), valuesFor(route, victim), 6);
  for (const url of ids) {
    out.push({ method: "GET", url, label: `${route.key} => ${url}`, meta: { route, byId: true } });
  }
  out.push({ method: "GET", url: `${L.expandPath(strip(route.path), valuesFor(route, victim), 1)[0]}?${sink}`, label: `${route.key} +ids`, meta: { route } });
  return out;
}

const markersOf = (reg) =>
  L.makeMarkers({
    strings: [...reg.strings, reg.extra.attachmentId, reg.extra.shareToken?.split(".")[0], reg.extra.shareToken].filter(Boolean),
    numbers: reg.numbers,
    ids: Object.values(reg.dbIds).flat(),
  });

const ATTACK = {
  name: "HACKED-BY-SPY", customerName: "HACKED-BY-SPY", vendorName: "HACKED-BY-SPY", itemName: "HACKED-BY-SPY", unitName: "HACKED-BY-SPY", label: "HACKED-BY-SPY", title: "HACKED-BY-SPY",
  notes: "HACKED-BY-SPY", narration: "HACKED-BY-SPY", description: "HACKED-BY-SPY", reason: "HACKED-BY-SPY", terms: "HACKED-BY-SPY",
  status: "inactive", isActive: false, action: "cancel", quantity: 1, qty: 1, currentStock: 1, amount: 1, totalAmount: 1, creditLimit: 1, email: "hacked@spy.test",
  accountName: "HACKED-BY-SPY", permissions: ["sales.view"], role: "viewer", roleKey: "viewer", acknowledge: ["ALL"], enabled: false,
};
const BODIES = {
  "PATCH /api/v1/transactions/transactions/:id/process": [{ action: "cancel" }, { action: "reject", reason: "HACKED-BY-SPY" }, { action: "approve" }],
  "PATCH /api/v1/vouchers/vouchers/:id/approve": [{ action: "reject", reason: "HACKED-BY-SPY" }, { action: "approve" }],
  "POST /api/v1/delivery-notes/:id/deliver": [{ receivedBy: "HACKED-BY-SPY" }],
  "POST /api/v1/delivery-notes/:id/cancel": [{ reason: "HACKED-BY-SPY" }],
  "POST /api/v1/quotations/:id/accept": [{ acceptedBy: "HACKED-BY-SPY" }],
  "POST /api/v1/messaging/shares/:id/revoke": [{ reason: "HACKED-BY-SPY" }],
  "POST /api/v1/transactions/transactions/:id/close-short": [{ reason: "HACKED-BY-SPY" }],
  "PATCH /api/v1/stock/stock/:id/quantity": [{ quantity: 1 }, { currentStock: 1, reason: "HACKED-BY-SPY" }],
  "POST /api/v1/batches/:id/write-off": [{ qty: 1, reason: "damage", note: "HACKED-BY-SPY" }],
  "PATCH /api/v1/access/users/:id": [{ name: "HACKED-BY-SPY", isActive: false }, { role: "viewer" }],
  "PATCH /api/v1/:id/status": [{ status: "inactive" }],
};
function mutationRequests(route, victim) {
  const bodies = [{}, ATTACK, ...(BODIES[route.key] || [])];
  const urls = L.expandPath(strip(route.path), valuesFor(route, victim), 5);
  const reqs = [];
  for (const url of urls) for (const body of bodies) {
    if (route.method === "DELETE" && Object.keys(body).length) continue;
    reqs.push({ method: route.method, url, body: route.method === "DELETE" ? undefined : body, label: `${route.key} => ${url}`, meta: { route } });
  }
  return reqs;
}

/** A fingerprint of everything one organisation owns, taken straight from the database. */
async function snapshotOf(code) {
  loadAllModels();
  const out = {};
  await stack.raw(async () => {
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (!M.schema.path("companyId")) continue;
      const rows = await M.find({ companyId: code }).sort({ _id: 1 }).lean();
      out[name] = { count: rows.length, digest: crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex") };
    }
  });
  return out;
}

const crawl = (requests, token, victim, extra = {}) =>
  L.crawl({ call, requests, token, markers: markersOf(victim), concurrency: 20, slowMs: 30000, pool: H.pool, ...extra });
const describeLeaks = (out) => out.leaks.map((l) => `${l.label} -> ${l.status}: ${l.found.slice(0, 4).join(", ")}`);
// GET /accounting/audit-log is itself swept by every test above: B's own PERMISSION_DENIED rows legitimately carry,
// in free-text `summary`, the raw URL path THIS SAME SPY tried and was refused for before anything was read
// (entityId stays null on those rows) - so when an earlier test in this file sent one of A's real ids to a route B
// may not use, that id resurfaces here. That proves B's audit trail works, not that A's data leaked: nobody who
// did not already know the id learns it. A leak on this one route counts only when some id appears OUTSIDE a
// PERMISSION_DENIED/Route row (a real entityId, or inside before/after/summary of an actual action).
function auditLogRowsAreJustDeniedRoutes(res, markers) {
  const rows = res?.body?.rows;
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (row.action === "PERMISSION_DENIED" && row.entity === "Route") continue;
    for (const m of JSON.stringify(row).matchAll(L.HEX24)) if (markers.ids.has(m[0].toLowerCase())) return false;
  }
  return true;
}
function describeLeaksBeyondAuditEcho(out, victim) {
  const markers = markersOf(victim);
  return out.leaks
    .filter((l) => {
      const row = out.rows.find((r) => (r.r.label || `${r.r.method} ${r.r.url}`) === l.label);
      return !(row && /\/accounting\/audit-log(\?|$)/.test(row.r.url) && auditLogRowsAreJustDeniedRoutes(row.res, markers));
    })
    .map((l) => `${l.label} -> ${l.status}: ${l.found.slice(0, 4).join(", ")}`);
}
const asList = (r) => (Array.isArray(r.body) ? r.body : r.body?.rows || r.body?.data || r.body?.customers || r.body?.transactions || r.body?.vouchers || r.body?.stocks || []);

// =============================================================================================================== set-up
test.before(async () => {
  if (skip) return;
  stack = await H.startStack("bleed");
  call = H.makeCaller(stack.base);
  loadAllModels();
  const [a, b] = await Promise.all([
    seedOrg({ stack, call, code: A, tag: "A", log }),
    seedOrg({ stack, call, code: B, tag: "B", log }),
  ]);
  R.A = a;
  R.B = b;
});

test.after(async () => {
  if (skip) return;
  await stack?.stop();
});

// =============================================================================================================== the seed itself
test("both organisations were filled with canaries across the kinds of record the product has", { skip }, async () => {
  for (const reg of [R.A, R.B]) {
    const failed = reg.failures.map((f) => `${f.step}: ${f.status} ${f.text.slice(0, 100)}`);
    assert.deepEqual(failed, [], `${reg.tag}: a seed step failed - the sweep would be proving less than it claims`);
    const kinds = Object.keys(reg.dbIds);
    assert.ok(kinds.length >= 40, `${reg.tag}: only ${kinds.length} kinds of record were seeded: ${kinds}`);
    for (const need of ["Customer", "Vendor", "Stock", "Transaction", "Voucher", "LedgerEntry", "LedgerAccount", "Quotation", "DeliveryNote", "Category", "UOM", "Staff", "Role", "Branch", "Attachment", "BankMaster", "Cheque", "BankStatementLine", "EInvoiceSubmission", "DocumentSend", "ShareLink", "MessagingSettings", "EInvoiceSettings", "CompanySettings", "ActivityLog", "StockBatch", "TaxCode", "FiscalYear", "NumberSeries", "DocumentType", "Currency"]) {
      assert.ok(reg.dbIds[need]?.length, `${reg.tag}: no ${need} was seeded`);
    }
    log(`${reg.tag}: ${kinds.length} kinds, ${Object.values(reg.dbIds).reduce((n, v) => n + v.length, 0)} records, ${reg.strings.length} canary strings, ${reg.numbers.length} amounts`);
  }
  // the two are disjoint: nothing of A's is B's
  const aIds = new Set(Object.values(R.A.dbIds).flat());
  assert.equal(Object.values(R.B.dbIds).flat().filter((i) => aIds.has(i)).length, 0);
  assert.notEqual(R.A.tokens.owner, R.B.tokens.owner);
});

// =============================================================================================================== the crawl
let aFirst; // A's data before any attack

test("POSITIVE CONTROL: the owner of an organisation, running the same sweep on its own ids, does see its own canaries", { skip, timeout: 1200000 }, async () => {
  const requests = GET_ROUTES.flatMap((r) => getRequests(r, R.A));
  const out = await crawl(requests, R.A.tokens.owner, { ...R.A, dbIds: {} }); // A reading A: markers irrelevant here
  // count the distinct canary kinds A's owner can see: if this were near zero a clean result for B would mean nothing
  const seen = new Set();
  for (const { res } of out.rows) for (const m of String(res.text).matchAll(/CANARY-A-([a-z0-9-]+?)-\d/g)) seen.add(m[1]);
  log(`A reading A: ${out.sent} requests, ${seen.size} distinct canary kinds visible, statuses ${JSON.stringify(out.statuses)}`);
  assert.ok(seen.size >= 30, `the sweep can see too little of an organisation's own data (${seen.size} canary kinds): ${[...seen].join(", ")}`);
  const amounts = new Set();
  for (const { res } of out.rows) for (const n of R.A.numbers) if (new RegExp(`(?<![\\d.])${String(n).replace(".", "\\.")}(?!\\d)`).test(res.text)) amounts.add(n);
  assert.ok(amounts.size >= 6, `only ${amounts.size} of A's distinctive amounts are visible to A's own sweep: ${[...amounts]}`);
  assert.deepEqual(out.slow, [], "a request hung");
});

test("A's data is fingerprinted before anything is attempted", { skip, timeout: 600000 }, async () => {
  R.A.dbIds = await ownedIds(stack, A);
  R.B.dbIds = await ownedIds(stack, B);
  aFirst = await snapshotOf(A);
  assert.ok(Object.keys(aFirst).length >= 40);
});

for (const who of ["owner", "manager"]) {
  test(`B's ${who} walks EVERY read route with A's real ids and random ids: not one canary, amount, id or company code of A comes back`, { skip, timeout: 1800000 }, async () => {
    const requests = GET_ROUTES.flatMap((r) => getRequests(r, R.A));
    const out = await crawl(requests, R.B.tokens[who], R.A);
    log(`B ${who} -> A: ${out.sent} requests over ${GET_ROUTES.length} read routes, statuses ${JSON.stringify(out.statuses)}`);
    assert.deepEqual(describeLeaks(out), [], "another organisation's data came back");
    assert.deepEqual(out.slow, [], "a request hung");
    // Neither of the two statuses below proves isolation, but both show the sweep reached the handlers rather than being stopped at the door
    assert.ok((out.statuses[404] || 0) > 40, `too few 404s (${out.statuses[404]}): by-id reads of A's records are not being refused as 'not found'`);
    if (who === "owner") assert.ok((out.statuses[200] || 0) > 100, "the owner's list routes answered");
    assert.deepEqual(out.serverErrors.map((e) => `${e.label} -> ${e.status} ${e.text}`), [], "a read of someone else's id crashed the server");
  });
}

test("by id, another organisation's record is NOT FOUND: the read answers 404 (or 400/403), never 200 with a body", { skip, timeout: 1200000 }, async () => {
  const byId = GET_ROUTES.filter((r) => r.params.length === 1 && r.path.endsWith("/:id") && modelsFor(r));
  assert.ok(byId.length >= 20, `only ${byId.length} by-id read routes found`);
  const requests = byId.flatMap((r) => (R.A.dbIds[modelsFor(r)[0]] || []).slice(0, 2).map((id) => ({ method: "GET", url: strip(r.path).replace(":id", id), label: `${r.key} (${modelsFor(r)[0]})`, meta: { route: r } })));
  const out = await crawl(requests, R.B.tokens.owner, R.A);
  assert.deepEqual(describeLeaks(out), []);
  const open = out.rows.filter(({ res }) => res.status < 400).map(({ r, res }) => `${r.label} -> ${res.status} ${String(res.text).slice(0, 100)}`);
  // Anything in this list answered 2xx to another organisation's id: it must be empty. (A route that returns an empty envelope for
  // an unknown id would be listed here; there is deliberately no allowlist - such a route should answer 404.)
  assert.deepEqual(open, [], "a read by another organisation's id answered 2xx");
});

test("B's owner AND manager try to change, approve, cancel, delete A's records, by id: nothing succeeds and A's data is byte-for-byte the same", { skip, timeout: 1800000 }, async () => {
  const requests = MUT_ROUTES.filter((r) => r.params.length).flatMap((r) => mutationRequests(r, R.A));
  const ownerOut = await crawl(requests, R.B.tokens.owner, R.A);
  const managerOut = await crawl(requests, R.B.tokens.manager, R.A);
  log(`B -> A writes: ${requests.length} requests x2, statuses ${JSON.stringify(ownerOut.statuses)}`);
  for (const out of [ownerOut, managerOut]) {
    assert.deepEqual(describeLeaks(out), []);
    const succeeded = out.rows.filter(({ r, res }) => res.status >= 200 && res.status < 300 && ownsParam(r)).map(({ r, res }) => `${r.method} ${r.url} -> ${res.status}`);
    assert.deepEqual(succeeded, [], "a write against another organisation's id answered 2xx");
    assert.deepEqual(out.slow, []);
  }
  // read A back over HTTP as A: the canaries are all still there, unchanged
  const names = (await call("GET", "/customers/customers", { token: R.A.tokens.owner })).text;
  assert.ok(names.includes("CANARY-A-customer-1") && !names.includes("HACKED-BY-SPY"));
  // ...and straight from the database
  const after = await snapshotOf(A);
  assert.deepEqual(L.snapshotDiff(aFirst, after), [], "something in A's data changed while B's people attacked it");
  const hacked = await stack.raw(async () => {
    let n = 0;
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (!M.schema.path("companyId")) continue;
      n += (await M.find({ companyId: A }).lean()).filter((d) => JSON.stringify(d).includes("HACKED-BY-SPY")).length;
    }
    return n;
  });
  assert.equal(hacked, 0, "a record of A's carries the spy's text");
  // also none of B's attempts landed in A's activity trail
  assert.equal(await stack.raw(() => mongoose.model("ActivityLog").countDocuments({ companyId: A, summary: /HACKED-BY-SPY/ })), 0);
});
/** Did this request name one of the victim's own record ids (rather than only a random one)? */
function ownsParam(r) {
  const ids = new Set(Object.values(R.A.dbIds).flat());
  return [...String(r.url).matchAll(/[0-9a-f]{24}/gi)].some((m) => ids.has(m[0].toLowerCase()));
}

// =============================================================================================================== building on the other's records
test("B cannot BUILD on A's records: documents, vouchers, quotations, notes, banking, accounts and users that name A's ids are refused and create nothing", { skip, timeout: 900000 }, async () => {
  const a = R.A.dbIds;
  const aCust = a.Customer[0], aVend = a.Vendor[0], aStock = a.Stock[0], aTx = a.Transaction[0], aAcct = a.LedgerAccount[0], aTax = a.TaxCode[0];
  const aBank = R.A.extra.bankAccountId;
  const bTx = () => stack.raw(() => mongoose.model("Transaction").countDocuments({ companyId: B }));
  const bVoucher = () => stack.raw(() => mongoose.model("Voucher").countDocuments({ companyId: B }));
  const bQuotes = () => stack.raw(() => mongoose.model("Quotation").countDocuments({ companyId: B }));
  const bNotes = () => stack.raw(() => mongoose.model("DeliveryNote").countDocuments({ companyId: B }));
  const bGoods = R.B.ids.stock[0];
  const bCust = R.B.ids.customer[0];
  const line = (itemId, extra = {}) => ({ itemId, description: "x", qty: 1, price: 10, rate: 10, vatPercent: 5, ...extra });
  const before = { tx: await bTx(), v: await bVoucher(), q: await bQuotes(), n: await bNotes() };
  const attempts = [
    ["order for A's customer, A's item", "POST", "/transactions/transactions", { type: "sales_order", partyId: aCust, partyType: "Customer", partyTypeRef: "Customer", items: [line(aStock)] }],
    ["order for B's customer, A's item", "POST", "/transactions/transactions", { type: "sales_order", partyId: bCust, partyType: "Customer", partyTypeRef: "Customer", items: [line(aStock)] }],
    ["order for A's customer, B's item", "POST", "/transactions/transactions", { type: "sales_order", partyId: aCust, partyType: "Customer", partyTypeRef: "Customer", items: [line(bGoods)] }],
    ["purchase from A's vendor", "POST", "/transactions/transactions", { type: "purchase_order", partyId: aVend, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(bGoods)] }],
    ["order using A's tax code", "POST", "/transactions/transactions", { type: "sales_order", partyId: bCust, partyType: "Customer", partyTypeRef: "Customer", items: [line(bGoods, { taxCodeId: aTax })] }],
    ["return of A's invoice", "POST", "/transactions/transactions", { type: "sales_return", partyId: bCust, partyType: "Customer", partyTypeRef: "Customer", items: [line(bGoods)], returnOf: { transactionId: aTx } }],
    ["receipt from A's customer", "POST", "/vouchers/vouchers", { voucherType: "receipt", customerId: aCust, totalAmount: 10, paymentMode: "cash", date: today() }],
    ["receipt set against A's invoice", "POST", "/vouchers/vouchers", { voucherType: "receipt", customerId: bCust, totalAmount: 10, paymentMode: "cash", date: today(), linkedInvoices: [{ invoiceId: aTx, amount: 10, balance: 0 }] }],
    ["receipt into A's bank account", "POST", "/vouchers/vouchers", { voucherType: "receipt", customerId: bCust, totalAmount: 10, paymentMode: "transfer", paymentDetails: { accountId: aBank, reference: "x" }, date: today() }],
    ["payment to A's vendor", "POST", "/vouchers/vouchers", { voucherType: "payment", vendorId: aVend, totalAmount: 10, paymentMode: "cash", date: today() }],
    ["journal on A's accounts", "POST", "/vouchers/vouchers", { voucherType: "journal", date: today(), lines: [{ accountId: aAcct, debit: 5 }, { accountId: a.LedgerAccount[1], credit: 5 }] }],
    ["expense on A's account", "POST", "/vouchers/vouchers", { voucherType: "expense", ledgerBased: true, expenseAccountId: aAcct, amount: 5, description: "x", paymentMode: "cash", date: today() }],
    ["contra between A's accounts", "POST", "/vouchers/vouchers", { voucherType: "contra", ledgerBased: true, fromAccountId: aAcct, toAccountId: a.LedgerAccount[1], totalAmount: 1, date: today() }],
    ["credit note to A's customer", "POST", "/vouchers/vouchers", { voucherType: "credit_note", partyType: "Customer", partyId: aCust, date: today(), lines: [{ accountId: aAcct, amount: 1 }] }],
    ["quotation for A's customer", "POST", "/quotations", { partyId: aCust, items: [{ itemId: aStock, qty: 1, price: 1, vatPercent: 5 }] }],
    ["delivery note against A's order", "POST", "/delivery-notes", { sourceTransactionId: aTx, items: [{ sourceLineId: R.A.extra.soLineId, qty: 1 }] }],
    ["item in A's category", "POST", "/stock/stock", { itemName: "x", sku: "SPY-1", categoryId: a.Category[0], unitOfMeasure: a.UOM[0] }],
    ["send A's invoice", "POST", "/messaging/send", { docType: "tax_invoice", sourceId: aTx, force: true }],
    ["card on A's bank account", "POST", "/banking/cards", { label: "spy card", kind: "terminal", accountId: aBank }],
    ["account in A's group", "POST", "/accounting/accounts", { accountName: "Spy account", groupId: a.AccountGroup[0] }],
    ["statement for A's bank account", "POST", "/banking/reconciliation/import", { accountId: aBank, rows: [["Date", "Description", "Debit", "Credit", "Balance"], ["01/01/2026", "x", "", "1", "1"]] }],
    ["match A's statement lines", "POST", "/banking/reconciliation/matches", { accountId: aBank, lineIds: a.BankStatementLine.slice(0, 1) }],
    ["user with A's branch", "POST", "/access/users", { name: "Spy", email: "spy1@bravoorg.sec.test", password: H.PASSWORD, role: "viewer", branchId: R.A.extra.branchCode }],
    ["user with A's role", "POST", "/access/users", { name: "Spy", email: "spy2@bravoorg.sec.test", password: H.PASSWORD, role: R.A.extra.roleKey || "canary_a_role" }],
    ["attachment owned by A's account", "POST", "/accounting/attachments", undefined, (() => { const f = new FormData(); f.append("file", new Blob([PDF], { type: "application/pdf" }), "spy.pdf"); f.append("ownerType", "account"); f.append("ownerId", aBank); return { form: f }; })()],
  ];
  const results = await H.pool(attempts, 8, async ([title, method, url, body, extra]) => ({ title, body, res: await call(method, url, { token: R.B.tokens.owner, body, ...(extra || {}) }) }));
  const worked = results.filter(({ res }) => res.status < 400).map(({ title, res }) => `${title} -> ${res.status} ${res.text.slice(0, 120)}`);
  assert.deepEqual(worked, [], "building on another organisation's record was accepted");
  const crashed = results.filter(({ res }) => res.status >= 500).map(({ title, res }) => `${title} -> ${res.status} ${res.text.slice(0, 120)}`);
  assert.deepEqual(crashed, [], "building on another organisation's record crashed");
  // the THIRD argument is what the spy itself sent, so a clean refusal that politely echoes the id back
  // ("Invoice <id> does not belong to this customer") is not counted as a leak of something new - the spy
  // supplied that id itself. Passing "" here (the bug) flagged every such refusal as if A's data leaked.
  const leaks = results.flatMap(({ title, res, body }) => L.findLeaks(res.text, markersOf(R.A), JSON.stringify(body) || "").map((f) => `${title}: ${f}`));
  assert.deepEqual(leaks, []);
  assert.deepEqual({ tx: await bTx(), v: await bVoucher(), q: await bQuotes(), n: await bNotes() }, before, "something was created on the strength of A's ids");
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), [], "A's data changed");
  // an attachment was the one thing that could be created: it must not exist if it names an owner B cannot see
  assert.equal(await stack.raw(() => mongoose.model("Attachment").countDocuments({ companyId: B, ownerId: aBank })), 0, "an attachment was filed against A's account");
});

// =============================================================================================================== spoofing who you are
test("spoofing the organisation or branch in the query, the body or a header changes nothing", { skip, timeout: 1200000 }, async () => {
  const aMarks = markersOf(R.A);
  const lists = GET_ROUTES.filter((r) => !r.params.length);
  const queries = [
    `companyId=${A}`, `tenant=${A}`, `organisation=${A}`, `branchId=${R.A.extra.branchCode}`, `companyId[$ne]=${B}`, `filter=${encodeURIComponent(JSON.stringify({ companyId: A }))}`,
  ];
  const headerSets = [
    { "X-Company": A }, { "X-Tenant": A }, { "X-Organisation": A }, { "X-Forwarded-Host": `${A}.zarvia.test` },
  ];
  const requests = [];
  for (const r of lists) {
    for (const q of queries) requests.push({ method: "GET", url: `${strip(r.path)}?${q}`, label: `${r.key} ?${q.slice(0, 40)}`, meta: { route: r } });
    for (const h of headerSets) requests.push({ method: "GET", url: strip(r.path), headers: h, label: `${r.key} ${Object.keys(h)[0]}`, meta: { route: r } });
  }
  const out = await crawl(requests, R.B.tokens.owner, R.A);
  log(`spoofing: ${out.sent} requests, statuses ${JSON.stringify(out.statuses)}`);
  assert.deepEqual(describeLeaksBeyondAuditEcho(out, R.A), []);
  assert.deepEqual(out.slow, []);
  // The branch header: A's branch code means nothing in B, and B's own works. 403, the person is told, and no data comes back.
  const sh = await call("GET", "/transactions/transactions", { token: R.B.tokens.owner, headers: { "X-Branch": R.A.extra.branchCode } });
  assert.equal(sh.status, 403);
  assert.equal(sh.code, "BRANCH_NOT_FOUND");
  assert.deepEqual(L.findLeaks(sh.text, aMarks), []);
  const own = await call("GET", "/transactions/transactions", { token: R.B.tokens.owner, headers: { "X-Branch": R.B.extra.branchCode } });
  assert.equal(own.status, 200, "B's own branch code works for B");
  // the same attempts as a person who belongs to B's branch
  const bu = await call("GET", "/transactions/transactions", { token: R.B.tokens.branchUser, headers: { "X-Branch": R.A.extra.branchCode } });
  assert.equal(bu.status, 403);
});

test("a company or branch named in the BODY of a create or update is ignored: the record is B's, in B's branch, whatever it says", { skip, timeout: 600000 }, async () => {
  const spoof = { companyId: A, branchId: R.A.extra.branchCode, tenant: A, organisation: A };
  const marker = "SPOOFED-BODY";
  const made = [];
  const post = async (model, url, body, extra) => {
    const res = await call("POST", url, { token: R.B.tokens.owner, body: { ...body, ...spoof }, ...(extra || {}) });
    const rec = res.body?._id ? res.body : Object.values(res.body || {}).find((v) => v && typeof v === "object" && v._id);
    made.push({ model, url, status: res.status, id: rec?._id || res.data?.data?._id, text: res.text.slice(0, 120) });
    return res;
  };
  await post("Customer", "/customers", { customerName: `${marker} customer`, contactPerson: "x", phone: "0501112233", billingAddress: "x", creditLimit: 5 });
  await post("Vendor", "/vendors/vendors", { vendorName: `${marker} vendor`, contactPerson: "x", phone: "0501112244", address: "x" });
  await post("Category", "/categories/categories", { name: `${marker} category` });
  await post("UOM", "/uom/units", { unitName: `${marker} unit`, shortCode: "SPF", type: "Base", category: "Weight" });
  await post("Voucher", "/vouchers/vouchers", { voucherType: "payment", vendorId: R.B.ids.vendor[0], totalAmount: 3, paymentMode: "cash", date: today(), narration: `${marker} payment` });
  await post("Quotation", "/quotations", { partyId: R.B.ids.customer[0], items: [{ itemId: R.B.ids.stock[0], qty: 1, price: 1, vatPercent: 5 }], notes: `${marker} quote` });
  await post("Transaction", "/transactions/transactions", { type: "sales_order", partyId: R.B.ids.customer[0], partyType: "Customer", partyTypeRef: "Customer", notes: `${marker} order`, items: [{ itemId: R.B.ids.stock[0], description: "x", qty: 1, price: 1, rate: 1, vatPercent: 5 }] });
  await post("TaxCode", "/accounting/tax-codes", { name: `${marker} tax`, kind: "standard", ratePercent: 5 });
  await post("LedgerAccount", "/accounting/accounts", { accountName: `${marker} account`, groupId: R.B.dbIds.AccountGroup[0] });
  await post("Branch", "/branches", { code: "spf", name: `${marker} branch` });
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: `${marker} staff`, designation: "x", contactNo: "0501234567", idNo: "784000000000099", joiningDate: today(), ...spoof })) form.append(k, v);
  await post("Staff", "/staff/staff", undefined, { form });
  const stored = [];
  for (const m of made) {
    if (m.status >= 400) continue;
    const row = await stack.raw(async () => {
      const M = mongoose.model(m.model);
      return m.id ? M.findById(m.id).lean() : M.findOne({ $or: [{ name: new RegExp(marker) }, { customerName: new RegExp(marker) }, { vendorName: new RegExp(marker) }, { unitName: new RegExp(marker) }, { accountName: new RegExp(marker) }] }).lean();
    });
    stored.push({ model: m.model, row });
  }
  assert.ok(stored.length >= 7, `only ${stored.length} of ${made.length} creates were accepted: ${JSON.stringify(made.filter((m) => m.status >= 400))}`);
  for (const { model, row } of stored) {
    assert.ok(row, `${model} was accepted but not found`);
    assert.equal(row.companyId, B, `${model} was filed under ${row.companyId}`);
    if (row.branchId !== undefined) assert.notEqual(row.branchId, R.A.extra.branchCode, `${model} was put in A's branch`);
  }
  // nothing was created in A
  assert.equal(await stack.raw(async () => {
    let n = 0;
    for (const name of mongoose.modelNames()) { const M = mongoose.model(name); if (!M.schema.path("companyId")) continue; n += (await M.find({ companyId: A }).lean()).filter((d) => JSON.stringify(d).includes(marker)).length; }
    return n;
  }), 0, "a record the spy created ended up in A");
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), []);
});

// =============================================================================================================== injection and regex bombs
test("operators and patterns typed into filters and search boxes cannot widen the query or hang the server", { skip, timeout: 1500000 }, async () => {
  const lists = GET_ROUTES.filter((r) => !r.params.length);
  const probes = [
    "status[$ne]=x", "partyId[$gt]=", "type[$in][]=sales_order", "search[$regex]=.*", "q[$ne]=zz", "search[$where]=1", "sort[$natural]=1",
    `filter=${encodeURIComponent('{"companyId":"alphaorg"}')}`, `search=${encodeURIComponent('{"$ne":null}')}`,
  ];
  // metacharacters of a regular expression, typed into any search box
  const patterns = ["(a+)+$", "(.*)*(.*)*(.*)*x", "[", "(", "\\", "*", "a{1000000}", "(?<=", `${"a".repeat(2000)}!`];
  const names = ["search", "q", "query", "needle", "term", "name", "keyword", "text", "partyName", "accountName", "generatedBy", "customerName", "vendorName", "description", "narration"];
  const requests = [];
  for (const r of lists) {
    for (const p of probes) requests.push({ method: "GET", url: `${strip(r.path)}?${p}`, label: `${r.key} ?${p.slice(0, 30)}` });
    for (const pat of patterns) requests.push({ method: "GET", url: `${strip(r.path)}?${names.map((n) => `${n}=${encodeURIComponent(pat)}`).join("&")}`, label: `${r.key} regex ${JSON.stringify(pat).slice(0, 24)}` });
  }
  // The default slowMs (30s, like every other crawl here): IFRS and the dashboard are genuinely heavy aggregations
  // - 10-20s under this test's 20-way concurrent hammering on a shared cluster, confirmed independent of the probe
  // (neither controller reads any of these query keys at all, only from/to/period/month/asAt/compare) - a tighter
  // 10s flagged that cost as if it were a hang. A true catastrophic-backtracking regex takes far longer than either.
  const out = await crawl(requests, R.B.tokens.owner, R.A);
  log(`injection: ${out.sent} requests, statuses ${JSON.stringify(out.statuses)}`);
  assert.deepEqual(describeLeaksBeyondAuditEcho(out, R.A), [], "a typed operator or pattern widened a query to another organisation");
  assert.deepEqual(out.slow, [], "a pattern made a request hang (a regular-expression bomb)");
  assert.deepEqual(out.serverErrors.map((e) => `${e.label} -> ${e.status} ${e.text}`), [], "text typed into a search box crashed a route");
  // search for A's canary from B: nothing, on every list that has a search box
  const find = (route, param) => ({ method: "GET", url: `${strip(route.path)}?${param}=${encodeURIComponent("ANARY-A-")}`, label: `${route.key} ${param}=ANARY-A-` });
  const searches = lists.flatMap((r) => ["search", "q"].map((p) => find(r, p)));
  const found = await crawl(searches, R.B.tokens.owner, R.A);
  assert.deepEqual(describeLeaksBeyondAuditEcho(found, R.A), []);
  const own = await call("GET", "/customers/customers?search=ANARY-B-customer", { token: R.B.tokens.owner });
  assert.ok(own.text.includes("CANARY-B-customer-1"), "the search itself works: B finds its own");
  const theirs = await call("GET", "/customers/customers?search=ANARY-A-customer", { token: R.B.tokens.owner });
  assert.equal(asList(theirs).length, 0, "and finds none of A's");
});

test("JSON operators in a request BODY cannot select another organisation's records", { skip, timeout: 300000 }, async () => {
  const op = { $ne: null };
  const bodies = [
    ["PATCH", "/vouchers/vouchers/bulk/process", { voucherIds: op, action: "approve" }],
    ["POST", "/vouchers/vouchers/bulk/process", { voucherIds: op, action: "approve", ids: op }],
    ["POST", "/vouchers/vouchers", { voucherType: "receipt", customerId: op, totalAmount: 1, paymentMode: "cash", date: today() }],
    ["POST", "/vouchers/vouchers", { voucherType: "payment", vendorId: { $in: R.A.dbIds.Vendor }, totalAmount: 1, paymentMode: "cash", date: today() }],
    ["POST", "/transactions/transactions", { type: "sales_order", partyId: { $in: R.A.dbIds.Customer }, partyType: "Customer", items: [{ itemId: op, qty: 1, price: 1 }] }],
    ["POST", "/quotations", { partyId: op, items: [{ itemId: { $in: R.A.dbIds.Stock }, qty: 1, price: 1 }] }],
    ["PUT", `/customers/${R.B.ids.customer[0]}`, { customerName: op, _id: R.A.dbIds.Customer[0] }],
    ["PUT", "/accounting/settings", { companyId: op, profile: { legalName: op } }],
    ["POST", "/login", { email: { $ne: "" }, password: { $ne: "" } }],
    ["POST", "/messaging/send", { docType: "tax_invoice", sourceId: op, force: true }],
    ["POST", "/banking/reconciliation/matches/accept", { accountId: op }],
    ["POST", "/access/users", { name: "x", email: { $ne: "" }, password: H.PASSWORD, role: "viewer" }],
  ];
  const results = await H.pool(bodies, 6, async ([method, url, body]) => ({ method, url, body, res: await call(method, url, { token: url === "/login" ? undefined : R.B.tokens.owner, body }) }));
  for (const { method, url, body, res } of results) {
    assert.ok(res.status >= 400 && res.status < 500, `${method} ${url} with an operator in the body answered ${res.status}: ${res.text.slice(0, 160)}`);
    assert.deepEqual(L.findLeaks(res.text, markersOf(R.A), JSON.stringify(body)), [], `${method} ${url}`);
  }
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), []);
});

// =============================================================================================================== aggregates, reports, numbering
test("reports and totals for B are B's own figures: compared with the database, not only searched for strings", { skip, timeout: 900000 }, async () => {
  const bToken = R.B.tokens.owner;
  R.B.dbIds = await ownedIds(stack, B); // what B holds NOW (the body-spoofing test added to it)
  const sumB = await stack.raw(async () => {
    const E = mongoose.model("LedgerEntry");
    const rows = await E.aggregate([{ $match: { companyId: B } }, { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" }, n: { $sum: 1 } } }]);
    return rows[0];
  });
  const sumA = await stack.raw(async () => (await mongoose.model("LedgerEntry").aggregate([{ $match: { companyId: A } }, { $group: { _id: null, d: { $sum: "$debitAmount" } } }]))[0]);
  assert.ok(sumB.d > 0 && sumA.d > 0 && Math.abs(sumA.d - sumB.d) > 1, "the two organisations have different books");
  const tb = await call("GET", "/vouchers/reports/financial?reportType=trial_balance", { token: bToken });
  assert.equal(tb.status, 200, tb.text.slice(0, 200));
  const rows = tb.body.report.trialBalance;
  const totalDebit = rows.reduce((t, r) => t + (Number(r.totalDebits) || 0), 0);
  const totalCredit = rows.reduce((t, r) => t + (Number(r.totalCredits) || 0), 0);
  assert.ok(Math.abs(totalDebit - totalCredit) < 0.5, "B's trial balance balances on its own");
  assert.ok(Math.abs(totalDebit - sumB.d) < 1, `B's trial balance debits (${totalDebit}) equal B's ledger (${sumB.d}), not A's (${sumA.d}) or the two together`);
  // customers, items and counts
  const customers = await call("GET", "/customers/customers", { token: bToken });
  assert.equal(asList(customers).length, R.B.dbIds.Customer.length);
  const cstats = await call("GET", "/customers/stats", { token: bToken });
  assert.deepEqual(L.findLeaks(cstats.text, markersOf(R.A)), []);
  const stock = await call("GET", "/stock/stock?limit=1000", { token: bToken });
  assert.equal(asList(stock).length, R.B.dbIds.Stock.length, "B sees its own items only");
  const vouchers = await call("GET", "/vouchers/vouchers?limit=1000", { token: bToken });
  assert.equal(asList(vouchers).length, R.B.dbIds.Voucher.length, "B sees its own vouchers only");
  const docs = await call("GET", "/transactions/transactions?limit=1000", { token: bToken });
  assert.equal(asList(docs).length, R.B.dbIds.Transaction.length, "B sees its own trade documents only");
  // the report family, all at once: no figure of A's appears in any
  const family = ["/dashboard-summary", "/dashboard-summary/analytics", "/dashboard-summary/sales", "/dashboard-summary/inventory", "/dashboard-summary/reports", "/accounting/reports/profit-loss", "/accounting/reports/day-book", "/accounting/reports/daily-summary", "/accounting/reports/cash-book", "/accounting/reports/cash-flow", "/accounting/reports/day-end", "/accounting/reports/party-balances", "/accounting/reports/ageing", "/accounting/reports/general-ledger", "/ifrs/financial-position", "/ifrs/profit-or-loss", "/ifrs/cash-flows", "/ifrs/changes-in-equity", "/ifrs/notes", "/vat-return/return", "/vat-return/detail", "/stock-reports/valuation", "/stock-reports/movement", "/stock-reports/sales-analysis", "/stock-reports/reorder", "/stock-reports/expiry", "/stock-reports/slow-moving", "/stock-reports/item-ledger", "/ledger/parties", "/ledger/debit-accounts", "/ledger/credit-accounts", "/vouchers/dashboard/stats", "/vouchers/ledger-entries?limit=1000", "/einvoice/dashboard", "/accounting/audit-log?limit=1000", "/accounting/number-series", "/currencies/register", "/batches", "/messaging/sends", "/inventory/inventory?limit=1000"];
  const range = "from=2000-01-01&to=2100-12-31&dateFrom=2000-01-01&dateTo=2100-12-31&asOf=2100-12-31";
  const sink = (u) => `${u}${u.includes("?") ? "&" : "?"}${range}`;
  const out = await crawl(family.map((u) => ({ method: "GET", url: sink(u), label: u })), bToken, R.A);
  assert.deepEqual(describeLeaksBeyondAuditEcho(out, R.A), [], "a report for B contained a figure or name of A's");
  assert.deepEqual(out.serverErrors.map((e) => `${e.label} -> ${e.status} ${e.text}`), []);
  const ok = out.rows.filter(({ res }) => res.status === 200).length;
  assert.ok(ok >= 25, `only ${ok} of ${family.length} reports answered 200`);
  // B's reports DO carry B's own canaries (the check is not passing on empty answers)
  const own = out.rows.filter(({ res }) => res.text.includes("CANARY-B-")).length;
  assert.ok(own >= 10, `only ${own} of B's reports carried any of B's own data`);
});

test("numbers, codes and sequences are each organisation's own: B's first document is number 1, whatever A has issued", { skip }, async () => {
  assert.equal(R.A.extra.poNo, R.B.extra.poNo, "both organisations issued purchase order number 1");
  assert.equal(R.A.extra.soNo, R.B.extra.soNo);
  assert.equal(R.A.extra.quotationNo, R.B.extra.quotationNo);
  assert.equal(R.A.extra.deliveryNoteNo, R.B.extra.deliveryNoteNo);
  assert.equal(R.A.extra.customerCode, R.B.extra.customerCode, "customer codes restart for each organisation");
  assert.match(R.B.extra.poNo, /^PO-\d{4}-0001$/);
  // B's number series rows are B's only
  const series = await call("GET", "/accounting/number-series", { token: R.B.tokens.owner });
  assert.deepEqual(L.findLeaks(series.text, markersOf(R.A)), []);
  const rows = await stack.raw(() => mongoose.model("NumberSeries").find({ companyId: B }).lean());
  assert.ok(rows.length >= 4);
  // allocating more numbers in B does not move A's counters
  const aSeriesBefore = await stack.raw(() => mongoose.model("NumberSeries").find({ companyId: A }).sort({ _id: 1 }).lean());
  const doc = await call("POST", "/transactions/transactions", { token: R.B.tokens.owner, body: { type: "purchase_order", partyId: R.B.ids.vendor[0], partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: R.B.ids.stock[0], description: "x", qty: 1, price: 1, rate: 1, vatPercent: 5 }] } });
  assert.equal(doc.status, 201, doc.text.slice(0, 200));
  assert.match(doc.body.transactionNo, /^PO-\d{4}-000[3-9]$/, "B's counter moved");
  const aSeriesAfter = await stack.raw(() => mongoose.model("NumberSeries").find({ companyId: A }).sort({ _id: 1 }).lean());
  assert.deepEqual(aSeriesAfter, aSeriesBefore, "A's counters did not move");
});

// =============================================================================================================== public doors
test("A's customer link reads A's document only; B cannot revoke it; a wrong or other organisation's secret opens nothing", { skip, timeout: 300000 }, async () => {
  const token = R.A.extra.shareToken;
  assert.ok(token, "A has a share link");
  const open = await call("GET", `/share/${token}`);
  assert.equal(open.status, 200, open.text.slice(0, 200));
  assert.ok(open.text.includes("CANARY-A-"), "the link shows A's invoice");
  assert.deepEqual(L.findLeaks(open.text, markersOf(R.B)), [], "and nothing of B's");
  // B's person tries to withdraw A's link by its row id
  const shareId = R.A.dbIds.ShareLink[0];
  const revoke = await call("POST", `/messaging/shares/${shareId}/revoke`, { token: R.B.tokens.owner, body: { reason: "spy" } });
  assert.equal(revoke.status, 404);
  assert.equal((await call("GET", `/share/${token}`)).status, 200, "A's link still opens");
  const row = await stack.raw(() => mongoose.model("ShareLink").findById(shareId).lean());
  assert.ok(!row.revokedAt, "and is not revoked in the database");
  // B's sends and shares lists do not show A's
  for (const u of ["/messaging/sends", "/messaging/shares", `/messaging/sends/${R.A.dbIds.DocumentSend[0]}`]) {
    const r = await call("GET", u, { token: R.B.tokens.owner });
    assert.deepEqual(L.findLeaks(r.text, markersOf(R.A)), [], u);
  }
  // wrong secret on the right selector, right secret on a wrong selector, other organisation's own token
  const [selector, secret] = token.split(".");
  const [bSelector, bSecret] = R.B.extra.shareToken.split(".");
  for (const t of [`${selector}.${"A".repeat(secret.length)}`, `${"Z".repeat(selector.length)}.${secret}`, `${selector}.${bSecret}`, `${bSelector}.${secret}`, `${selector}.`, `.${secret}`, `${selector}.${secret}x`]) {
    const r = await call("GET", `/share/${encodeURIComponent(t || "x")}`);
    assert.ok([404, 410].includes(r.status), `${t} answered ${r.status}`);
    assert.deepEqual(L.findLeaks(r.text, markersOf(R.A)), []);
  }
  // B's own link shows B's document, none of A's
  const bOpen = await call("GET", `/share/${R.B.extra.shareToken}`);
  assert.equal(bOpen.status, 200);
  assert.deepEqual(L.findLeaks(bOpen.text, markersOf(R.A)), []);
  // reading a link is recorded on the link (a fetch counter): that is the link's own life, so the baseline moves
  aFirst = await snapshotOf(A);
});

test("the e-invoice webhook of one organisation is not opened by the other's secret", { skip, timeout: 300000 }, async () => {
  const body = JSON.stringify({ providerId: "SPY-1", documentId: "SPY-DOC-1", sellerName: "Spy Seller", sellerVatTrn: "100000000000003", payableAmount: 10, lineExtensionTotal: 9.5, taxAmount: 0.5 });
  const post = (org, secret) => fetch(`${stack.base}/einvoice/inbound/webhook/${org}`, { method: "POST", headers: { "Content-Type": "application/json", "x-einvoice-signature": hmac(secret, Buffer.from(body)) }, body });
  const countFor = (code) => stack.raw(() => mongoose.model("InboundInvoice").countDocuments({ companyId: code, documentId: "SPY-DOC-1" }));
  assert.equal((await post(B, R.A.extra.webhookSecret)).status, 401, "A's secret does not open B's webhook");
  assert.equal((await post(A, R.B.extra.webhookSecret)).status, 401, "B's secret does not open A's webhook");
  assert.equal(await countFor(B), 0);
  assert.equal(await countFor(A), 0);
  assert.equal((await post(B, "wrong")).status, 401);
  assert.equal((await post("nosuchorg", R.B.extra.webhookSecret)).status, 404, "an unknown organisation is a plain 404");
  const good = await post(B, R.B.extra.webhookSecret);
  assert.equal(good.status, 201, "B's own secret opens B's own webhook");
  assert.equal(await countFor(B), 1, "and the delivery landed in B");
  assert.equal(await countFor(A), 0, "and not in A");
});

test("the developer console's token opens no organisation route, and an organisation's token opens no console route", { skip, timeout: 600000 }, async () => {
  const PlatformAuth = require("../platform/platformAuthService");
  const dev = { name: "Spy Dev", email: "spydev@zarvia.test", password: "a-long-passphrase-123" };
  await PlatformAuth.create(dev);
  const login = await call("POST", "/platform/login", { body: { email: dev.email, password: dev.password } });
  assert.equal(login.status, 200, login.text.slice(0, 200));
  const platformToken = login.body.token;
  assert.equal((await call("GET", "/platform/organisations", { token: platformToken })).status, 200, "the console token works on the console");
  // the console token on every organisation route
  const orgOut = await H.pool(routes, 14, async (r) => ({ r, res: await call(r.method, strip(r.path).replace(/:[A-Za-z0-9_]+/g, RANDOM_ID), { token: platformToken, body: MUTATING.has(r.method) ? {} : undefined }) }));
  const opened = orgOut.filter(({ res }) => res.status !== 401).map(({ r, res }) => `${r.key} -> ${res.status} ${res.text.slice(0, 80)}`);
  assert.deepEqual(opened, [], "a console token reached an organisation route");
  // an organisation's token (owner of A, the most powerful there is) on every console route
  const consoleRoutes = inventory().filter((r) => r.identity === "platform" && !/\/platform\/login/.test(r.path));
  assert.ok(consoleRoutes.length >= 20);
  const conOut = await H.pool(consoleRoutes, 14, async (r) => ({ r, res: await call(r.method, strip(r.path).replace(/:[A-Za-z0-9_]+/g, "alphaorg"), { token: R.A.tokens.owner, body: MUTATING.has(r.method) ? {} : undefined }) }));
  const reached = conOut.filter(({ res }) => res.status !== 401).map(({ r, res }) => `${r.key} -> ${res.status} ${res.text.slice(0, 80)}`);
  assert.deepEqual(reached, [], "an organisation's token reached a console route");
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), []);
});

// =============================================================================================================== branches inside one organisation
test("BRANCHES: a person in one branch cannot read, change or delete another branch's documents, vouchers or ledger rows; head office sees the sum", { skip, timeout: 900000 }, async () => {
  const code = R.A.extra.branchCode;
  const { owner, branchUser } = R.A.tokens;
  const goods = R.A.ids.stock[0];
  const cust = R.A.ids.customer[0];
  const headOffice = { ...R.A.dbIds }; // everything that exists before the branch person makes anything: head office's
  const asBranch = (token, extra = {}) => ({ token, ...extra });
  // documents made IN the branch, by the branch person
  const so = await call("POST", "/transactions/transactions", { token: branchUser, body: { type: "sales_order", partyId: cust, partyType: "Customer", partyTypeRef: "Customer", notes: "CANARY-A-shj-order", items: [{ itemId: goods, description: "x", qty: 2, price: 1234.56, rate: 1234.56, vatPercent: 5 }] } });
  assert.equal(so.status, 201, so.text.slice(0, 200));
  assert.equal(so.body.branchId, code, "it belongs to the person's branch");
  assert.match(so.body.transactionNo, new RegExp(`^${code.toUpperCase()}-SO-`), "and carries the branch's own number prefix");
  const rv = await call("POST", "/vouchers/vouchers", { token: branchUser, body: { voucherType: "payment", vendorId: R.A.ids.vendor[0], totalAmount: 321.09, paymentMode: "cash", date: today(), narration: "CANARY-A-shj-payment" } });
  assert.ok(rv.status < 300, rv.text.slice(0, 200));
  const q = await call("POST", "/quotations", { token: branchUser, body: { partyId: cust, notes: "CANARY-A-shj-quote", items: [{ itemId: goods, qty: 1, price: 99.99, vatPercent: 5 }] } });
  assert.equal(q.status, 201, q.text.slice(0, 200));
  const shjIds = { Transaction: so.body._id, Voucher: rv.data?.data?._id || rv.body?._id, Quotation: q.body._id };
  // these documents are A's own new data: the new baseline for everything that follows
  R.A.dbIds = await ownedIds(stack, A);
  aFirst = await snapshotOf(A);
  // head office's documents (made by the owner with no branch chosen)
  const main = { Transaction: R.A.dbIds.Transaction[0], Voucher: R.A.dbIds.Voucher[0], Quotation: R.A.dbIds.Quotation[0], DeliveryNote: R.A.dbIds.DeliveryNote[0] };
  const mainRow = await stack.raw(() => mongoose.model("Transaction").findById(main.Transaction).lean());
  assert.equal(mainRow.branchId, "main");

  // 1. by id: the branch person gets 404 for head office's documents, in every way to touch one
  const byId = [
    ["GET", `/transactions/transactions/${main.Transaction}`], ["GET", `/transactions/transactions/${main.Transaction}/audit`], ["PUT", `/transactions/transactions/${main.Transaction}`, { notes: "HACKED" }],
    ["PATCH", `/transactions/transactions/${main.Transaction}/process`, { action: "cancel" }], ["DELETE", `/transactions/transactions/${main.Transaction}`],
    ["GET", `/vouchers/vouchers/${main.Voucher}`], ["GET", `/vouchers/vouchers/${main.Voucher}/audit`], ["PUT", `/vouchers/vouchers/${main.Voucher}`, { narration: "HACKED" }],
    ["PATCH", `/vouchers/vouchers/${main.Voucher}/approve`, { action: "reject" }], ["DELETE", `/vouchers/vouchers/${main.Voucher}`],
    ["GET", `/quotations/${main.Quotation}`], ["PUT", `/quotations/${main.Quotation}`, { notes: "HACKED" }], ["POST", `/quotations/${main.Quotation}/send`, {}], ["DELETE", `/quotations/${main.Quotation}`],
    ["GET", `/delivery-notes/${main.DeliveryNote}`], ["POST", `/delivery-notes/${main.DeliveryNote}/dispatch`, {}], ["DELETE", `/delivery-notes/${main.DeliveryNote}`],
  ];
  const r1 = await H.pool(byId, 8, async ([method, url, body]) => ({ method, url, res: await call(method, url, { token: branchUser, body }) }));
  const reached = r1.filter(({ res }) => res.status !== 404).map(({ method, url, res }) => `${method} ${url} -> ${res.status} ${res.code} ${res.text.slice(0, 80)}`);
  assert.deepEqual(reached, [], "the branch person reached head office's documents by id");
  // and head office's documents are as they were
  const mainAfter = await stack.raw(() => mongoose.model("Transaction").findById(main.Transaction).lean());
  assert.deepEqual(mainAfter, mainRow);
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), [], "nothing moved while the branch person tried head office's documents");

  // 2. lists, filters and reports: only the branch's own documents
  const lists = ["/transactions/transactions?limit=1000", "/transactions/transactions?limit=1000&branchId=main", "/transactions/transactions?limit=1000&branch=main", "/vouchers/vouchers?limit=1000", "/vouchers/vouchers?limit=1000&branchId=main", "/quotations?limit=1000", "/delivery-notes?limit=1000", "/vouchers/ledger-entries?limit=1000", "/accounting/reports/day-book?from=2000-01-01&to=2100-12-31", "/accounting/reports/daily-summary?from=2000-01-01&to=2100-12-31", "/accounting/reports/general-ledger?from=2000-01-01&to=2100-12-31"];
  const mainTexts = [R.A.extra.soNo, "CANARY-A-docnote-1", "CANARY-A-receipt-note-1", "CANARY-A-payment-note-1", "CANARY-A-qnote-1", "CANARY-A-dnnote-1", "CANARY-A-journal-note-1", "CANARY-A-expense-desc-1", "CANARY-A-cn-note-1"].filter(Boolean);
  const mainIds = new Set([...headOffice.Transaction, ...headOffice.Voucher, ...headOffice.Quotation, ...headOffice.DeliveryNote, ...headOffice.LedgerEntry]);
  const r2 = await H.pool(lists, 6, async (u) => ({ u, res: await call("GET", u, { token: branchUser }) }));
  for (const { u, res } of r2) {
    if (res.status !== 200) { assert.ok([200, 403].includes(res.status), `${u} -> ${res.status}`); continue; }
    const ids = [...res.text.matchAll(/[0-9a-f]{24}/g)].map((m) => m[0]).filter((i) => mainIds.has(i));
    assert.deepEqual(ids, [], `${u}: head office's records are in the branch person's list`);
    for (const t of mainTexts.filter((t) => t.startsWith("CANARY"))) assert.ok(!res.text.includes(t), `${u}: head office's '${t}' is in the branch person's view`);
  }
  const mine = await call("GET", "/transactions/transactions?limit=1000", { token: branchUser });
  assert.deepEqual(asList(mine).map((d) => d._id), [shjIds.Transaction], "the branch person sees exactly their own document");

  // 3. the branch header: a branch person may only repeat their own; head office is not theirs to choose
  for (const h of ["main", "all", "MAIN", R.B.extra.branchCode, "../main", "main,shj"]) {
    const r = await call("GET", "/transactions/transactions", { token: branchUser, headers: { "X-Branch": h } });
    assert.equal(r.status, 403, `X-Branch: ${h} answered ${r.status}`);
    assert.deepEqual(L.findLeaks(r.text, markersOf(R.A).ids.size ? L.makeMarkers({ ids: [...mainIds] }) : L.makeMarkers({})), []);
  }
  assert.equal((await call("GET", "/transactions/transactions", { token: branchUser, headers: { "X-Branch": code } })).status, 200, "repeating their own branch is fine");

  // 4. head office: every branch, one branch, and the sums agree
  const totals = async (header) => {
    const res = await call("GET", "/vouchers/ledger-entries?limit=5000", { token: owner, headers: header ? { "X-Branch": header } : {} });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const rows = asList(res);
    return { n: rows.length, debit: rows.reduce((t, e) => t + (Number(e.debitAmount) || 0), 0), credit: rows.reduce((t, e) => t + (Number(e.creditAmount) || 0), 0), ids: new Set(rows.map((e) => e._id)) };
  };
  const all = await totals(null);
  const allExplicit = await totals("all");
  const atMain = await totals("main");
  const atBranch = await totals(code);
  assert.ok(atBranch.n > 0 && atMain.n > 0, "both have ledger rows");
  assert.equal(allExplicit.n, all.n);
  assert.equal(all.n, atMain.n + atBranch.n, "the all-branches count is the sum of the branches");
  assert.ok(Math.abs(all.debit - (atMain.debit + atBranch.debit)) < 0.005, `all-branch debits ${all.debit} = main ${atMain.debit} + branch ${atBranch.debit}`);
  assert.ok(Math.abs(all.credit - (atMain.credit + atBranch.credit)) < 0.005);
  for (const id of atBranch.ids) assert.ok(!atMain.ids.has(id), "no ledger row is in two branches");
  // the same through the trial balance
  const tb = async (header) => {
    const res = await call("GET", "/vouchers/reports/financial?reportType=trial_balance", { token: owner, headers: header ? { "X-Branch": header } : {} });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const rows = res.body.report.trialBalance;
    return rows.reduce((t, r) => t + (Number(r.totalDebits) || 0), 0);
  };
  const tAll = await tb(null);
  const tMain = await tb("main");
  const tBranch = await tb(code);
  assert.ok(Math.abs(tAll - (tMain + tBranch)) < 0.01, `trial balance: all ${tAll} = main ${tMain} + branch ${tBranch}`);
  // head office's view of the documents holds both, and the branch's view only the branch's
  const allDocs = asList(await call("GET", "/transactions/transactions?limit=1000", { token: owner })).map((d) => d._id);
  assert.ok(allDocs.includes(shjIds.Transaction) && allDocs.includes(main.Transaction));
  const branchDocs = asList(await call("GET", "/transactions/transactions?limit=1000", { token: owner, headers: { "X-Branch": code } })).map((d) => d._id);
  assert.deepEqual(branchDocs, [shjIds.Transaction]);

  // 5. the other direction: head office's person, working in the branch, cannot touch head office documents without leaving the branch view
  const viaHeader = await call("GET", `/transactions/transactions/${main.Transaction}`, { token: owner, headers: { "X-Branch": code } });
  assert.equal(viaHeader.status, 404, "in the branch view, head office's document does not exist");
});

// =============================================================================================================== the last thing: the attack really would have worked on one's own data
test("POSITIVE CONTROL for the write sweep: the same attack bodies DO succeed against B's own records, so the refusals above were isolation, not bad payloads", { skip, timeout: 1800000 }, async () => {
  const requests = MUT_ROUTES.filter((r) => r.params.length).flatMap((r) => mutationRequests(r, R.B));
  const out = await crawl(requests, R.B.tokens.owner, R.A);
  const accepted = new Set(out.rows.filter(({ res }) => res.status >= 200 && res.status < 300).map(({ r }) => r.meta.route.key));
  log(`B -> B writes: ${requests.length} requests, ${accepted.size} different routes accepted at least one`);
  assert.ok(accepted.size >= 25, `only ${accepted.size} routes accepted the attack on their own organisation's data; the write sweep proves little`);
  assert.deepEqual(describeLeaks(out), [], "even in its own attack, B saw nothing of A's");
  assert.deepEqual(L.snapshotDiff(aFirst, await snapshotOf(A)), [], "A is untouched");
});
