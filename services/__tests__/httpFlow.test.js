// The whole system over HTTP: a real server process against a throwaway database, real login and
// tokens, every new feature through its real route. The other tests call services directly and so
// never touch routing, authentication, validators or response shapes; this one does.
//
//   npm test           (runs with the rest)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { hmac } = require("../../utils/secretBox");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");

let child;
let M; // models, once connected
const S = {}; // state shared between the steps, in order
let logs = "";

async function call(method, url, { body, token = S.token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers, body: data?.data ?? data };
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  assert.ok(uri.includes(DB), "could not point the server at the throwaway database");
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Stock: require("../../models/modules/stockModel"),
    VATReport: require("../../models/modules/financial/VATReport"),
  };
  await mongoose.connection.syncIndexes();

  // wait for the server to answer
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children || [])]);
const find = (nodes, name) => flatten(nodes).find((n) => n.name === name);

test("login: bad password is refused, a super admin gets a token, a viewer exists for permission checks", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  await new M.Admin({ name: "Viewer", email: "viewer@test.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();

  const bad = await call("POST", "/login", { body: { email: "boss@test.uae", password: "wrong-password" }, token: null });
  assert.ok(bad.status >= 400 && bad.status < 500);

  const ok = await call("POST", "/login", { body: { email: "boss@test.uae", password: "12312312" }, token: null });
  assert.equal(ok.status, 200);
  S.token = ok.body.tokens.accessToken;
  const v = await call("POST", "/login", { body: { email: "viewer@test.uae", password: "12312312" }, token: null });
  S.viewer = v.body.tokens.accessToken;
  assert.ok(S.token && S.viewer);

  assert.equal((await call("GET", "/accounting/chart", { token: null })).status, 401, "no token, no access");
});

test("the default chart is there on first open: five categories, parents and children, default accounts", { skip }, async () => {
  const r = await call("GET", "/accounting/chart");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.categories.map((c) => c.category), ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);

  const assets = r.body.categories[0].groups;
  const bank = find(assets, "Bank");
  assert.ok(bank, "Assets > Current Assets > Bank");
  const current = find(assets, "Current Assets");
  assert.ok(current.children.some((c) => c.name === "Bank"), "Bank is a child of Current Assets");
  assert.ok(bank.accounts.some((a) => a.accountName === "Bank Account"));
  assert.ok(find(assets, "Cash").accounts.some((a) => a.accountName === "Cash in Hand"));
  assert.ok(find(r.body.categories[1].groups, "Accounts Payable"));
  assert.ok(find(r.body.categories[2].groups, "Equity").accounts.some((a) => a.accountName === "Owner's Capital"));
  assert.ok(find(r.body.categories[3].groups, "Sales Income").accounts.some((a) => a.accountName === "Sales Revenue"));
  assert.ok(find(r.body.categories[4].groups, "Operating Expenses").accounts.some((a) => a.accountName === "Rent Expense"));
  S.accounts0 = r.body.counts.accounts;
  S.bankGroup = bank._id;

  const again = await call("GET", "/accounting/chart");
  assert.equal(again.body.counts.accounts, S.accounts0, "opening it again creates nothing");
});

test("posting accounts are all mapped by the defaults; posting is on from the start and a person's choice is respected", { skip }, async () => {
  const rd = await call("GET", "/accounting/account-configuration/readiness");
  assert.equal(rd.body.missing.length, 0, `unmapped: ${rd.body.missing.map((m) => m.configKey)}`);
  // opening the chart for the first time mapped everything and switched posting on, so approved
  // documents have their financial effect without anyone having to find a switch
  assert.equal((await call("GET", "/accounting/account-configuration")).body.ledgerPostingEnabled, true);

  assert.equal((await call("PUT", "/accounting/account-configuration/posting", { body: { enabled: false }, token: S.viewer })).status, 403, "a viewer cannot");
  const off = await call("PUT", "/accounting/account-configuration/posting", { body: { enabled: false } });
  assert.equal(off.body.ledgerPostingEnabled, false);
  await call("GET", "/accounting/chart");
  assert.equal((await call("GET", "/accounting/account-configuration")).body.ledgerPostingEnabled, false, "once a person has chosen, opening the chart does not undo it");
  const on = await call("PUT", "/accounting/account-configuration/posting", { body: { enabled: true } });
  assert.equal(on.body.ledgerPostingEnabled, true);
  assert.ok(on.body.catchUp && typeof on.body.catchUp.posted === "number", "earlier documents are caught up");

  const y = new Date().getFullYear();
  const fy = await call("POST", "/accounting/fiscal-years", { body: { code: String(y), startDate: `${y}-01-01`, endDate: `${y}-12-31` } });
  assert.equal(fy.status, 201);
  S.fy = fy.body._id;
  const dup = await call("POST", "/accounting/fiscal-years", { body: { code: "OVER", startDate: `${y}-06-01`, endDate: `${y + 1}-05-31` } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.errorCode, "DATE_OVERLAP");
});

test("create an account with an opening balance, then attach, download and remove a document", { skip }, async () => {
  const forbidden = await call("POST", "/accounting/accounts", { token: S.viewer, body: { accountName: "Nope", groupId: S.bankGroup } });
  assert.equal(forbidden.status, 403);

  const c = await call("POST", "/accounting/accounts", { body: { accountName: "Emirates NBD Current", groupId: S.bankGroup, openingBalance: 5000, openingSide: "debit" } });
  assert.equal(c.status, 201);
  assert.match(c.body.accountCode, /^BANK\d{4}$/);
  S.bankAcct = c.body._id;

  const dup = await call("POST", "/accounting/accounts", { body: { accountName: "emirates nbd current", groupId: S.bankGroup } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.errorCode, "DUPLICATE_ACCOUNT");

  const ledger = await call("GET", `/accounting/accounts/${S.bankAcct}/ledger`);
  assert.equal(ledger.body.closing, 5000);
  assert.equal(ledger.body.closingNet, 5000, "debit minus credit, so the screen can show 5,000.00 Dr");
  assert.equal(ledger.body.rows[0].net, 5000);

  // the chart carries the same signed figure at every level, and the pickers get a flat light list
  const chart = await call("GET", "/accounting/chart");
  const bankRow = JSON.stringify(chart.body).match(/"accountName":"Emirates NBD Current"[^}]*"net":(-?[\d.]+)/);
  assert.equal(Number(bankRow?.[1]), 5000);
  const postable = await call("GET", "/accounting/accounts/postable");
  assert.equal(postable.status, 200);
  const row = postable.body.find((a) => a.accountName === "Emirates NBD Current");
  assert.equal(row.category, "ASSET");
  assert.equal(row.groupName, "Bank");
  assert.ok(!("net" in row), "no balances in the picker list");

  // upload straight onto the account
  const form = new FormData();
  form.append("file", new Blob([PDF], { type: "application/pdf" }), "bank-letter.pdf");
  form.append("ownerType", "account");
  form.append("ownerId", S.bankAcct);
  form.append("label", "Bank letter");
  const up = await call("POST", "/accounting/attachments", { form });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  S.att = up.body;
  assert.equal(up.body.fileName, "bank-letter.pdf");

  const list = await call("GET", `/accounting/attachments?ownerType=account&ownerId=${S.bankAcct}`);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].label, "Bank letter");

  const dl = await call("GET", `/accounting/attachments/${S.att.attachmentId}`);
  assert.equal(dl.status, 200);
  assert.ok(Buffer.compare(dl.data, PDF) === 0, "the bytes come back unchanged");
  assert.match(dl.headers.get("content-disposition"), /^attachment;/);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await call("GET", `/accounting/attachments/${S.att.attachmentId}`, { token: null })).status, 401, "downloads need a login");

  const bad = new FormData();
  bad.append("file", new Blob([Buffer.from("MZ not a pdf")], { type: "application/pdf" }), "invoice.pdf");
  const rejected = await call("POST", "/accounting/attachments", { form: bad });
  assert.equal(rejected.status, 415);
  assert.equal(rejected.data.errorCode, "FILE_CONTENT_MISMATCH");

  assert.equal((await call("DELETE", `/accounting/attachments/${S.att.attachmentId}`)).status, 200);
  assert.equal((await call("GET", `/accounting/attachments/${S.att.attachmentId}`)).status, 404);
});

test("tax codes and settings through the API", { skip }, async () => {
  const list = await call("GET", "/accounting/tax-codes");
  assert.deepEqual(list.body.map((t) => t.kind).sort(), ["exempt", "out_of_scope", "standard", "zero_rated"]);
  S.std = list.body.find((t) => t.kind === "standard");
  S.zero = list.body.find((t) => t.kind === "zero_rated");
  const created = await call("POST", "/accounting/tax-codes", { body: { name: "Phased", kind: "standard", ratePercent: 5, rateHistory: [{ date: "2099-01-01", ratePercent: 6 }] } });
  assert.equal(created.status, 201);
  const dupTax = await call("POST", "/accounting/tax-codes", { body: { name: "Phased", kind: "standard", ratePercent: 5 } });
  assert.equal(dupTax.status, 400);
  assert.equal(dupTax.data.errorCode, "DUPLICATE_FIELD");

  const s = await call("PUT", "/accounting/settings", { body: { profile: { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", emirate: "Dubai" } } });
  assert.equal(s.body.profile.trn, "100123456700003");
  assert.equal((await call("PUT", "/accounting/settings", { body: { profile: { trn: "123" } } })).data.errorCode, "INVALID_TRN");
});

// ---- trade ----
const line = (qty, price, extra = {}) => ({ itemId: S.stock, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5, ...extra });
const order = (type, party, partyType, items, extra = {}) =>
  call("POST", "/transactions/transactions", { body: { type, partyId: party, partyType, partyTypeRef: partyType, items, createdBy: "tester", ...extra } });
const processDoc = (id, action, extra = {}) => call("PATCH", `/transactions/transactions/${id}/process`, { body: { action, ...extra } });

test("purchase: server computes the totals, approval books stock, batch and ledger", { skip }, async () => {
  const v = await new M.Vendor({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003", paymentTerms: "Net 30" }).save();
  const c = await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 100000, trnNumber: "100999888700003", billingAddress: "Deira", eInvoice: { participantId: "0235:100999888700003", city: "Dubai", countryCode: "AE" } }).save();
  const st = await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId() }).save();
  Object.assign(S, { vendor: String(v._id), customer: String(c._id), stock: String(st._id) });

  // a deliberately wrong client total: the server's figure wins
  const po = await order("purchase_order", S.vendor, "Vendor", [line(100, 10, { discountPercent: 10, taxCodeId: S.std._id, batchNumber: "LOT-1", expiryDate: "2099-12-31" })], {
    charges: [{ description: "Freight", amount: 20, vatPercent: 5 }], totalAmount: 0,
  });
  assert.equal(po.status, 201, JSON.stringify(po.data));
  assert.match(po.body.transactionNo, /^PO-\d{4}-0001$/);
  assert.equal(po.body.pricing.net, 900); // 1000 less 10%
  assert.equal(po.body.totalAmount, 900 + 45 + 20 + 1); // + VAT 45, freight 20 + VAT 1
  S.po = po.body._id;

  const ap = await processDoc(S.po, "approve");
  assert.equal(ap.status, 200, JSON.stringify(ap.data));

  const batches = await call("GET", "/batches");
  assert.equal(batches.body.length, 1);
  assert.equal(batches.body[0].batchNumber, "LOT-1");
  assert.equal(batches.body[0].qtyOnHand, 100);
  S.batch = batches.body[0]._id;

  const tb = await call("GET", "/vouchers/reports/financial?reportType=trial_balance");
  assert.equal(tb.status, 200, JSON.stringify(tb.data));
  assert.equal(tb.body.report.summary.isBalanced, true);
  const row = (n) => tb.body.report.trialBalance.find((r) => r.accountName === n);
  assert.equal(row("Inventory Stock").balance, 900);
  assert.equal(row("Freight on Purchases").balance, 20);
  assert.equal(row("Input VAT").balance, 46);
  // the VAT return agrees with the ledger: freight VAT is in it too
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const vat = await call("GET", `/vat-return/return?from=${day(-2)}&to=${day(2)}`);
  assert.equal(vat.status, 200, JSON.stringify(vat.data));
  assert.equal(vat.body.totals.recoverableVat, 46);
  assert.equal(await M.VATReport.countDocuments({}), 0, "the old VAT report table is no longer written");
  assert.equal(row("Vendor - Mill").balance, 966);

  // editing reads the document exactly as stored
  const back = await call("GET", `/transactions/transactions/${S.po}`);
  assert.equal(back.body.transaction.items[0].discountPercent, 10);
  assert.equal(back.body.transaction.items[0].batchNumber, "LOT-1");
  assert.equal(back.body.transaction.charges[0].amount, 20);
});

test("sales: credit warning must be acknowledged, a block cannot be overridden", { skip }, async () => {
  await M.Customer.updateOne({ _id: S.customer }, { creditLimit: 500 });
  assert.equal((await call("PUT", "/accounting/settings", { body: { creditControl: { mode: "warn" } } })).status, 200);

  const so = await order("sales_order", S.customer, "Customer", [line(20, 50, { taxCodeId: S.std._id })]); // 1050
  assert.equal(so.status, 201);
  S.so = so.body._id;
  const warn = await processDoc(S.so, "approve");
  assert.equal(warn.status, 409);
  assert.equal(warn.data.errorCode, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED");
  const field = warn.data.details.risk.acknowledgementField;
  assert.equal(field, "riskAck_limit_party_credit");
  assert.equal((await call("GET", `/transactions/transactions/${S.so}`)).body.transaction.status, "DRAFT", "nothing happened yet");

  const acked = await processDoc(S.so, "approve", { [field]: true });
  assert.equal(acked.status, 200, JSON.stringify(acked.data));

  await call("PUT", "/accounting/settings", { body: { creditControl: { mode: "block" } } });
  const so2 = await order("sales_order", S.customer, "Customer", [line(20, 50)]);
  const blocked = await processDoc(so2.body._id, "approve", { [field]: true });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.errorCode, "RISK_LIMIT_BLOCKED");
  await call("PUT", "/accounting/settings", { body: { creditControl: { mode: "off" } } });
  await M.Customer.updateOne({ _id: S.customer }, { creditLimit: 100000 });
  S.so2 = so2.body._id;
  assert.equal((await processDoc(S.so2, "approve")).status, 200);
});

test("returns: the picker shows what is left, over-returning is refused, a good return is accepted", { skip }, async () => {
  const info = await call("GET", `/accounting/returnable/${S.so}`);
  assert.equal(info.body.lines[0].remainingQty, 20);
  const lineId = info.body.lines[0].lineId;

  const over = await order("sales_return", S.customer, "Customer", [line(25, 50, { returnOfLineId: lineId })], { returnOf: { transactionId: S.so } });
  assert.equal(over.status, 422);
  assert.equal(over.data.errorCode, "OVER_RETURN");

  const ok = await order("sales_return", S.customer, "Customer", [line(5, 50, { returnOfLineId: lineId })], { returnOf: { transactionId: S.so } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.body.returnOf.transactionNo.startsWith("SO-"), true);
  S.sr = ok.body._id;
  assert.equal((await processDoc(S.sr, "approve")).status, 200);
  assert.equal((await call("GET", `/accounting/returnable/${S.so}`)).body.lines[0].remainingQty, 15);
});

test("reports: statements agree with each other; ageing, statement and batches answer", { skip }, async () => {
  const tb = (await call("GET", "/vouchers/reports/financial?reportType=trial_balance")).body.report;
  assert.equal(tb.summary.isBalanced, true);
  const pl = (await call("GET", "/vouchers/reports/financial?reportType=profit_loss")).body.report;
  const bs = (await call("GET", "/vouchers/reports/financial?reportType=balance_sheet")).body.report;
  assert.equal(bs.isBalanced, true, `assets ${bs.totalAssets} vs ${bs.totalLiabilitiesAndEquity}`);
  assert.equal(bs.profitToDate, pl.netProfit);
  assert.ok(pl.totalIncome > 0);

  const ageing = await call("GET", "/accounting/reports/ageing?type=receivable");
  assert.equal(ageing.status, 200);
  const aged = ageing.body.rows.find((r) => r.partyName === "Al Noor");
  assert.ok(aged && aged.total > 0);
  assert.equal(Object.values(aged.buckets).reduce((t, n) => t + n, 0), aged.total);

  const stmt = await call("GET", `/accounting/reports/statement?partyType=Customer&partyId=${S.customer}`);
  assert.equal(stmt.status, 200);
  assert.ok(stmt.body.rows.length >= 3 && stmt.body.closing > 0);
  const last = stmt.body.rows.at(-1);
  assert.equal(stmt.body.closing, last.balance, "closing is the last running balance");

  const coa = await call("GET", "/accounting/chart");
  const ar = find(coa.body.categories[0].groups, "Bank").accounts.find((a) => a.accountName === "Emirates NBD Current");
  assert.equal(ar.balance, 5000);
});

test("batches: expiry write-off through the API books the loss", { skip }, async () => {
  const wo = await call("POST", `/batches/${S.batch}/write-off`, { body: { qty: 5, reason: "damage", note: "dropped pallet" } });
  assert.equal(wo.status, 201, JSON.stringify(wo.data));
  assert.equal(wo.body.posted, true);
  assert.match(wo.body.number, /^WO-/);
  assert.equal((await call("POST", `/batches/${S.batch}/write-off`, { body: { qty: 5000, reason: "damage" } })).data.errorCode, "EXCEEDS_BATCH_QTY");
  assert.equal((await call("POST", `/batches/${S.batch}/write-off`, { body: { qty: 1, reason: "damage" }, token: S.viewer })).status, 403);
  const tb = (await call("GET", "/vouchers/reports/financial?reportType=trial_balance")).body.report;
  assert.equal(tb.summary.isBalanced, true);
  assert.ok(tb.trialBalance.find((r) => r.accountName === "Stock Write-off - Damage").balance > 0);
});

test("period lock: a closed year refuses new documents, and reopening allows them", { skip }, async () => {
  assert.equal((await call("POST", `/accounting/fiscal-years/${S.fy}/close`)).status, 200);
  const refused = await order("sales_order", S.customer, "Customer", [line(1, 50)]);
  assert.equal(refused.status, 422);
  assert.equal(refused.data.errorCode, "PERIOD_CLOSED");
  await call("POST", `/accounting/fiscal-years/${S.fy}/reopen`);
  assert.equal((await order("sales_order", S.customer, "Customer", [line(1, 50)])).status, 201);
});

test("e-invoicing: configure, check, send, follow to reported, and the inbound side", { skip }, async () => {
  // not ready until the company is complete
  const rd0 = await call("GET", "/einvoice/readiness");
  assert.equal(rd0.status, 200);
  assert.ok(rd0.body.seller.some((c) => c.key === "participantId" && !c.ok));
  assert.equal((await call("PUT", "/einvoice/settings", { body: { enabled: true } })).data.errorCode, "EINVOICE_NOT_READY");

  const set = await call("PUT", "/einvoice/settings", { body: { participantId: "0235:100123456700003", webhookSecret: "whsec-e2e", enabled: true } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.body.enabled, true);
  assert.equal(set.body.connected, false, "only the sandbox is connected");
  assert.ok(!JSON.stringify(set.body).includes("whsec-e2e"));
  assert.equal((await call("PUT", "/einvoice/settings", { body: { environment: "production" } })).data.errorCode, "PROVIDER_NOT_AVAILABLE");

  const docs = await call("GET", "/einvoice/documents");
  const d = docs.body.find((x) => x.transactionNo.startsWith("SO-") && x.status === "NOT_SENT" && x.customer === "Al Noor");
  assert.ok(d, "an approved sale is listed");
  const prev = await call("GET", `/einvoice/preview/${d._id}`);
  assert.equal(prev.body.ready, true, JSON.stringify(prev.body.issues));

  S.einvoiced = d._id;
  const sent = await call("POST", `/einvoice/submit/${d._id}`);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.body.submission.status, "SUBMITTED");
  const again = await call("POST", `/einvoice/submit/${d._id}`);
  assert.equal(again.body.alreadySubmitted, true);

  const id = sent.body.submission._id;
  assert.equal((await call("POST", `/einvoice/submissions/${id}/refresh`)).body.status, "ACKNOWLEDGED");
  assert.equal((await call("POST", `/einvoice/submissions/${id}/refresh`)).body.status, "REPORTED");
  const hist = await call("GET", `/einvoice/submissions/${id}`);
  assert.deepEqual(hist.body.history.map((h) => h.status), ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED"]);

  const dash = await call("GET", "/einvoice/dashboard");
  assert.equal(dash.body.outbound.byStatus.REPORTED, 1);

  // inbound: by hand, then a signed webhook, then an unsigned one
  const inv = { providerId: "IN-1", documentId: "SUP-1", sellerName: "Mill", sellerVatTrn: "100555444300003", payableAmount: 966, lineExtensionTotal: 920, taxAmount: 46 };
  const added = await call("POST", "/einvoice/inbound", { body: inv });
  assert.equal(added.status, 201);
  const list = await call("GET", "/einvoice/inbound");
  assert.equal(String(list.body.rows[0].suggestedPurchaseOrderId._id), S.po, "matched by amount to the purchase order");
  assert.equal((await call("POST", `/einvoice/inbound/${list.body.rows[0]._id}/accept`, { body: {} })).body.status, "ACCEPTED");

  const raw = JSON.stringify({ ...inv, providerId: "IN-2", documentId: "SUP-2" });
  const good = await fetch(`${BASE}/einvoice/inbound/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-einvoice-signature": hmac("whsec-e2e", Buffer.from(raw)) }, body: raw });
  assert.equal(good.status, 201, "a correctly signed delivery is accepted without a login");
  const forged = await fetch(`${BASE}/einvoice/inbound/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-einvoice-signature": "0".repeat(64) }, body: raw });
  assert.equal(forged.status, 401);
  const nosig = await fetch(`${BASE}/einvoice/inbound/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  assert.equal(nosig.status, 401);
});

test("deleting an approved sale puts the books back; one already e-invoiced cannot be deleted; the audit log recorded the changes", { skip }, async () => {
  const refused = await call("DELETE", `/transactions/transactions/${S.einvoiced}`);
  assert.equal(refused.status, 409, `status ${refused.status} ${JSON.stringify(refused.body)}
${logs.slice(-2500)}`);
  assert.equal(refused.data.errorCode, "EINVOICE_SENT");

  const fresh = await order("sales_order", S.customer, "Customer", [line(2, 50, { taxCodeId: S.std._id })]);
  assert.equal((await processDoc(fresh.body._id, "approve")).status, 200);
  const rev = (r) => r.trialBalance.find((x) => x.accountName === "Sales Revenue")?.balance ?? 0;
  const before = (await call("GET", "/vouchers/reports/financial?reportType=trial_balance")).body.report;
  const del = await call("DELETE", `/transactions/transactions/${fresh.body._id}`);
  assert.ok(del.status === 204 || del.status === 200, `status ${del.status}
${logs.slice(-2500)}`);
  const after = (await call("GET", "/vouchers/reports/financial?reportType=trial_balance")).body.report;
  assert.equal(after.summary.isBalanced, true);
  assert.equal(rev(after), rev(before) - 100, "its revenue is gone");

  const log = await call("GET", "/accounting/audit-log?limit=100");
  const actions = new Set(log.body.rows.map((r) => r.action));
  for (const a of ["ACCOUNT_CREATED", "LEDGER_POSTING_ENABLED", "FISCAL_YEAR_CREATED", "PERIOD_CLOSED", "PERIOD_REOPENED", "SETTINGS_UPDATED", "CREDIT_WARNING_ACKNOWLEDGED", "CREDIT_BLOCKED", "STOCK_WRITTEN_OFF", "EINVOICE_SETTINGS_CHANGED", "EINVOICE_SUBMITTED"]) {
    assert.ok(actions.has(a), `audit log is missing ${a}`);
  }
  assert.ok(!JSON.stringify(log.body).includes("whsec-e2e"), "secrets never reach the log");
});

test("one document's audit trail: its ledger entries, stock, party balance and who did what", { skip }, async () => {
  const { status, body } = await call("GET", `/transactions/transactions/${S.po}/audit`);
  assert.equal(status, 200, JSON.stringify(body));

  assert.equal(body.document.status, "APPROVED");
  assert.equal(body.party.name, "Mill");

  // the double entry it posted: inventory + input VAT against the vendor, and it balances
  assert.ok(body.ledger.posted, "the approved purchase posted to the ledger");
  assert.equal(body.ledger.balanced, true);
  assert.equal(body.ledger.totals.debit, body.ledger.totals.credit);
  assert.equal(body.ledger.totals.debit, body.document.totalAmount);
  assert.ok(body.ledger.entries.some((e) => e.credit === body.document.totalAmount), "the vendor is credited the whole amount");
  assert.equal(body.ledger.note, null);

  // the stock it moved, with the costing trail
  assert.equal(body.stock.movements.length, 1);
  assert.equal(body.stock.movements[0].eventType, "PURCHASE_RECEIVE");
  assert.equal(body.stock.movements[0].quantity, 100);
  assert.equal(body.stock.movements[0].previousStock, 0);
  assert.equal(body.stock.movements[0].newStock, 100);

  // the vendor balance row it wrote
  assert.equal(body.partyBalance.rows.length, 1);
  assert.equal(body.partyBalance.rows[0].invNo, body.document.transactionNo);

  // and who did it
  const actions = body.activity.map((a) => a.action);
  assert.deepEqual(actions, ["TRANSACTION_CREATED", "TRANSACTION_APPROVED"]);
  const approved = body.activity.find((a) => a.action === "TRANSACTION_APPROVED");
  assert.equal(approved.after.effects.ledgerEntries, body.ledger.entries.length);
  assert.equal(approved.after.effects.stockMovements, 1);
  assert.ok(approved.username, "the approval is attributed to the person who made it");

  // a draft has nothing posted yet, and says so rather than showing an empty table
  const draft = await order("purchase_order", S.vendor, "Vendor", [line(1, 10, { taxCodeId: S.std._id })]);
  const fresh = await call("GET", `/transactions/transactions/${draft.body._id}/audit`);
  assert.equal(fresh.body.ledger.posted, false);
  assert.match(fresh.body.ledger.note, /until the document is approved/i);
  assert.equal(fresh.body.stock.movements.length, 0);
  assert.deepEqual(fresh.body.activity.map((a) => a.action), ["TRANSACTION_CREATED"]);

  // an edit records what changed
  await call("PUT", `/transactions/transactions/${draft.body._id}`, { body: { notes: "rush" } });
  const edited = await call("GET", `/transactions/transactions/${draft.body._id}/audit`);
  assert.deepEqual(edited.body.activity.map((a) => a.action), ["TRANSACTION_CREATED", "TRANSACTION_UPDATED"]);
  assert.ok(edited.body.activity[1].before, "an update keeps the before side");

  assert.equal((await call("GET", "/transactions/transactions/000000000000000000000000/audit")).status, 404);
});

test("one voucher's audit trail: its double entry, what it was set against, and who did what", { skip }, async () => {
  // a sale to settle, then a cash receipt against it
  const sale = await order("sales_order", S.customer, "Customer", [line(4, 100, { taxCodeId: S.std._id })]);
  assert.equal((await processDoc(sale.body._id, "approve")).status, 200);
  const total = sale.body.totalAmount;

  const made = await call("POST", "/vouchers/vouchers", {
    body: {
      voucherType: "receipt", customerId: S.customer, date: "2026-10-05", paymentMode: "cash",
      totalAmount: total, linkedInvoices: [{ invoiceId: sale.body._id, amount: total, balance: 0 }],
      narration: "Settled in full",
    },
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.body._id;

  const { status, body } = await call("GET", `/vouchers/vouchers/${id}/audit`);
  assert.equal(status, 200, JSON.stringify(body));

  assert.equal(body.voucher.typeLabel, "Receipt");
  // the voucher's own state, not the separate approval workflow, which defaults to "pending"
  assert.equal(body.voucher.status, "approved");
  assert.equal(body.voucher.paymentMode, "cash");
  assert.equal(body.voucher.totalAmount, total);

  // Dr cash / Cr the customer, and it balances
  assert.ok(body.ledger.posted, "an approved receipt posts to the ledger");
  assert.equal(body.ledger.balanced, true);
  assert.equal(body.ledger.totals.debit, total);
  assert.equal(body.ledger.note, null);

  // what it was set against
  assert.equal(body.allocations.length, 1);
  assert.equal(body.allocations[0].transactionNo, sale.body.transactionNo);
  assert.equal(body.allocations[0].allocatedAmount, total);
  assert.equal(body.allocations[0].outstandingNow, 0, "the invoice it settled is now clear");
  assert.equal(body.onAccount, 0);
  assert.equal(body.cheque, null);

  // and who did it
  assert.deepEqual(body.activity.map((a) => a.action), ["VOUCHER_CREATED"]);
  assert.equal(body.activity[0].after.effects.ledgerEntries, body.ledger.entries.length);
  assert.ok(body.activity[0].username, "the save is attributed");

  // the sale's own trail now shows the receipt that settled it
  const doc = await call("GET", `/transactions/transactions/${sale.body._id}/audit`);
  assert.equal(doc.body.settlements.length, 1);
  assert.equal(doc.body.settlements[0].voucherNo, body.voucher.voucherNo);
  assert.equal(doc.body.settlements[0].allocatedAmount, total);

  // deleting it reverses the entries, and both the deletion and the reversal are visible
  assert.equal((await call("DELETE", `/vouchers/vouchers/${id}`)).status, 200);
  const after = await call("GET", `/vouchers/vouchers/${id}/audit`);
  assert.ok(after.body.ledger.isReversed, "the reversing entries are kept and marked");
  assert.equal(after.body.ledger.reversals.length, after.body.ledger.entries.length);
  assert.deepEqual(after.body.activity.map((a) => a.action), ["VOUCHER_CREATED", "VOUCHER_DELETED"]);

  assert.equal((await call("GET", "/vouchers/vouchers/000000000000000000000000/audit")).status, 404);
});
