// Card and bank transfer on the road over real HTTP against a spawned strict server: who may set a van's card machine,
// what the salesman is told about it, that he cannot name a machine of his own, and that a transfer he takes lands in the
// OFFICE's approval list - and he cannot approve it himself.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vpay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanpay";

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(who, method, url, body) {
  const headers = { Authorization: `Bearer ${T[who]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (org, fn) => ctx.runWithTenant({ companyId: org, branchId: "main" }, fn);
async function person(org, who, fields) {
  const doc = await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, ...fields }).save());
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${who}@${org}.test`, password: PASSWORD }) });
  const json = await login.json();
  assert.equal(login.status, 200, JSON.stringify(json));
  T[who] = json.data.tokens.accessToken;
  return doc;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", SUPPORT_CONTACT: "help@zarvia.example" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
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

let rice, vanId, tripId, cust, terminal, debit, bank, ali;
const sell = (who, payNow) => call(who, "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 5 }], ...(payNow ? { payNow } : {}) });

test("setup: an organisation with banking and one without, a supervisor and a salesman, a card machine, a van out", { skip }, async () => {
  await Org.create({ legalName: "Van Pay Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await Org.create({ legalName: "No Bank Foods LLC", code: "nobank", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true }, featureOverrides: { banking: false } });
  await person(CODE, "owner", { type: "super_admin" });
  await person("nobank", "nbowner", { type: "super_admin" });
  const role = await call("owner", "POST", "/access/roles", { key: "van_salesman", name: "Van salesman", description: "Sells from a van", rank: 30, permissions: ["vansales.sell"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });

  // a bank account to settle card money into, a card type and the machine, in-process (the same services the screens use)
  await as(CODE, async () => {
    const { groupFamily, CardService, CardTypeService } = require("../banking/cardService");
    const Chart = require("../financial/chartOfAccountsService");
    const { rootId } = await groupFamily("bank-account-group", {});
    bank = await Chart.createAccount({ accountName: "Card Settlement Bank", groupId: rootId }, {}, ali._id);
    const visa = await CardTypeService.create({ name: "Visa", feePercent: 2.5 }, {});
    terminal = await CardService.create({ label: "POS Van One", kind: "terminal", cardTypeId: visa._id, accountId: bank._id, terminalId: "T1" }, {}, ali._id);
    debit = await CardService.create({ label: "Office Debit", kind: "debit", cardTypeId: visa._id, holderName: "Boss", accountId: bank._id }, {}, ali._id);
  });

  const cat = await call("owner", "POST", "/categories/categories", { name: "Food" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("owner", "POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Net 30" }));
  vanId = (await call("owner", "POST", "/van-sales/vans", { code: "van-1", name: "Van One", salesmanId: String(ali._id) })).body.id;
  tripId = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
  assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 40 }] })).status, 200);
  assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/depart`)).status, 200);
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { paymentModes: ["cash", "cheque", "card", "transfer"] })).status, 200);
});

test("the card machines a van can be given: a manager's read, names and fees only", { skip }, async () => {
  const r = await call("owner", "GET", "/van-sales/card-machines");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.body.map((x) => Object.keys(x).sort()), [["feePercent", "id", "label"]], "no account, no bank, no terminal id");
  assert.equal(r.body[0].label, "POS Van One", "only terminals: the debit card is not a machine");
  assert.equal(r.body[0].feePercent, 2.5);
  const refused = await call("ali", "GET", "/van-sales/card-machines");
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "PERMISSION_DENIED");
  assert.deepEqual((await call("nbowner", "GET", "/van-sales/card-machines")).body, [], "no banking: none offered");
});

test("setting a van's machine: a supervisor only, a terminal only, never without banking", { skip }, async () => {
  assert.equal((await call("ali", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", cardId: String(terminal._id) })).status, 403, "a salesman cannot give his own van a machine");
  const notTerminal = await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", cardId: String(debit._id) });
  assert.equal(notTerminal.status, 400);
  assert.equal(notTerminal.code, "CARD_NOT_A_TERMINAL");
  assert.equal((await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", cardId: { $ne: null } })).status, 400, "a hostile id is a clean refusal");
  const set = await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", cardId: String(terminal._id) });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(String(set.body.cardId), String(terminal._id));
  const nb = await call("nbowner", "POST", "/van-sales/vans", { code: "van-9", name: "Van Nine", cardId: String(new mongoose.Types.ObjectId()) });
  assert.equal(nb.status, 403);
  assert.equal(nb.code, "FEATURE_NOT_IN_PLAN", "a card is the banking feature's");
});

test("what the salesman is told: the machine by name and fee, the ways he can pay, and no ids to misuse", { skip }, async () => {
  const mine = await call("ali", "GET", "/van-sales/trips/mine");
  assert.deepEqual(mine.body[0].cardMachine, { label: "POS Van One", feePercent: 2.5 });
  assert.equal(JSON.stringify(mine.body[0]).includes(String(terminal._id)), false, "the machine's id is not in anything he is sent");
  const choices = await call("ali", "GET", "/van-sales/payment-choices");
  assert.equal(choices.status, 200, JSON.stringify(choices.data));
  assert.equal(choices.body.card, true);
  assert.ok(choices.body.bankAccounts.length >= 1, "bank accounts for a transfer");
  assert.ok(Array.isArray(choices.body.banks), "the banks a cheque is drawn on");
  assert.equal(JSON.stringify(choices.body).includes("balance"), false, "names and ids only: no balances");
  const nb = await call("nbowner", "GET", "/van-sales/payment-choices");
  assert.equal(nb.body.card, false);
  assert.equal(nb.body.cheque, false);
  assert.ok(nb.body.bankAccounts.length >= 1, "a transfer needs no part of the plan, so the bank accounts are still offered");
  assert.deepEqual(nb.body.banks, [], "the banks a cheque is drawn on are the banking feature's");
});

test("a card sale by the salesman posts to the VAN's machine, whatever machine the body names", { skip }, async () => {
  const noCode = await sell("ali", { mode: "card", full: true, details: {} });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.code, "APPROVAL_CODE_REQUIRED");
  const done = await sell("ali", { mode: "card", full: true, details: { approvalCode: "A1B2", cardId: String(debit._id), accountId: String(bank._id) } });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.body.receipt.status, "approved");
  assert.equal(done.body.receipt.paymentDetails.cardLabel, "POS Van One");
  assert.equal(done.body.trip.totals.card, done.body.invoice.totalAmount, "the whole invoice, VAT included, went on the card");
});

test("a transfer waits in the OFFICE's list; the salesman cannot approve it, the office can, and then it is real", { skip }, async () => {
  const sale = await sell("ali", { mode: "transfer", full: true, details: { reference: "TRF-9001", accountId: String(bank._id) } });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  const receipt = sale.body.receipt;
  assert.equal(receipt.status, "pending");
  assert.equal(sale.body.trip.totals.transferWaiting, sale.body.invoice.totalAmount);
  assert.equal(sale.body.trip.totals.transfer, 0);

  const queue = await call("owner", "GET", "/approvals/waiting");
  assert.equal(queue.status, 200, JSON.stringify(queue.data));
  const rows = [...(queue.body.forYou || []), ...(queue.body.others || [])];
  assert.ok(rows.some((r) => r.number === receipt.voucherNo), `the transfer is in the office's approvals list: ${JSON.stringify(rows.map((r) => r.number))}`);

  const own = await call("ali", "PATCH", `/vouchers/vouchers/${receipt._id}/approve`, { action: "approve" });
  assert.equal(own.status, 403, "the salesman who took it cannot say it arrived");
  const approved = await call("owner", "PATCH", `/vouchers/vouchers/${receipt._id}/approve`, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const after = await call("ali", "GET", "/van-sales/trips/mine");
  assert.equal(after.body[0].totals.transferWaiting, 0);
  assert.equal(after.body[0].totals.transfer, sale.body.invoice.totalAmount);
});

test("a salesman cannot take a way of paying the organisation switched off, even with a machine on the van", { skip }, async () => {
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { paymentModes: ["cash"] })).status, 200);
  const r = await sell("ali", { mode: "card", full: true, details: { approvalCode: "X1" } });
  assert.equal(r.status, 400);
  assert.equal(r.code, "VAN_MODE_NOT_ALLOWED");
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { paymentModes: ["cash", "cheque"] })).status, 200);
});

test("a cheque from the road, and the settlement preview over HTTP: 'none handed in' is an empty list, not 'all'", { skip }, async () => {
  const cheque = await sell("ali", { mode: "cheque", full: true, details: { chequeNo: "445566", chequeDate: new Date().toISOString().slice(0, 10), accountId: String(bank._id), drawnOnBankName: "Small Bank LLC" } });
  assert.equal(cheque.status, 201, JSON.stringify(cheque.data));
  assert.equal(cheque.body.receipt.paymentMode, "cheque");
  const trip = (await call("ali", "GET", "/van-sales/trips/mine")).body[0];
  const counts = trip.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 }));
  const counted = await call("ali", "POST", `/van-sales/trips/${tripId}/unload`, { counts });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));

  const all = await call("owner", "GET", `/van-sales/trips/${tripId}/settlement`);
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.body.cheques.map((c) => c.chequeNo), ["445566"]);
  assert.ok(!all.body.warnings.some((w) => w.code === "CHEQUES_MISSING"), "nothing said about handed in: every cheque is taken as handed in");
  assert.ok(all.body.cards.length >= 1 && all.body.transfers.length >= 1, "card and transfer listed apart from the cash");

  const none = await call("owner", "GET", `/van-sales/trips/${tripId}/settlement?chequesHanded=`);
  assert.ok(none.body.warnings.some((w) => w.code === "CHEQUES_MISSING"), "an EMPTY list says none was handed in");
  const one = await call("owner", "GET", `/van-sales/trips/${tripId}/settlement?chequesHanded=445566`);
  assert.ok(!one.body.warnings.some((w) => w.code === "CHEQUES_MISSING"));
});
