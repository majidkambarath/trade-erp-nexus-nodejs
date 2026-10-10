// Three gaps in who may approve what, against a strict server with real sign-ins and roles made through the API:
//
//   1. EDITING AN APPROVED VOUCHER. Changing what a posted voucher posted takes its postings back and posts new ones - a
//      deletion and an approval in one act - so Edit alone is not enough: it needs finance.deletePosted, and the new amount is
//      judged like an approval (the editor's limit, the separate-approver rule, no second approver). A plain edit also used to
//      copy the whole request body onto the voucher, status and approvals included.
//   2. THE APPROVALS LIST. GET /approvals/waiting: what is waiting for the signed-in person's decision, judged by the same
//      rules as the approve routes, and what is waiting but not for them, with the reason.
//   3. APPROVAL LIMITS APPLY TO SAVING TOO. A voucher that would post the moment it is saved (journal, contra, expense, notes,
//      receipt, payment) is held - saved pending, nothing posted - when the person saving it is over their limit or the
//      organisation wants two approvers at that amount. It then appears in the list for people who may approve it.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";

let child, M, Org, ctx;
let logs = "";
const T = {};
const S = {};

async function call(method, url, { body, token, branch } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (branch) headers["X-Branch"] = branch;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, message: data?.message };
}
const as = (fn) => ctx.runWithTenant({ companyId: "acc", branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
// the same, working in one branch (head office's branch switcher sends X-Branch)
const apiAt = (who, branch, method, url, body) => call(method, url, { token: T[who], branch, body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

async function person(key, permissions, { approvalLimit, rank = 50 } = {}) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank, permissions, ...(approvalLimit !== undefined ? { approvalLimit } : {}) });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@acc.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@acc.test` }, { $set: { mustChangePassword: false } })); // (the forced first change: passwordPolicyHttp.test.js)
  T[key] = await login(`${key}@acc.test`);
  assert.ok(T[key], `${key} signs in`);
  S[`id_${key}`] = String((await as(() => M.Admin.findOne({ email: `${key}@acc.test` }).lean()))._id);
}

const order = (qty) => ({ type: "sales_order", partyId: S.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "test", items: [{ itemId: S.item, description: "Rice 5kg", qty, price: 20, rate: 20, vatPercent: 5, taxCodeId: S.tax }] });
// qty x 20 + 5% VAT: 6 -> 126, 40 -> 840
const draft = async (who, qty) => {
  const r = await api(who, "POST", "/transactions/transactions", order(qty));
  assert.equal(r.status, 201, `${JSON.stringify(r.data)}
${r.status >= 500 ? logs.slice(-1500) : ""}`);
  return r.body._id;
};
const approveDoc = (who, id) => api(who, "PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
const approveVoucher = (who, id) => api(who, "PATCH", `/vouchers/vouchers/${id}/approve`, { action: "approve" });
const settings = (patch) => api("owner", "PUT", "/accounting/settings", patch);
const voucherRow = (id) => as(() => M.Voucher.findById(id).select("+heldCheque").lean());
const entriesOf = (id) => as(() => M.LedgerEntry.find({ voucherId: id, isReversed: { $ne: true } }).lean());
const legs = async (id) => (await entriesOf(id)).map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`).sort();
const lines = (n) => [{ accountId: S.rent, debit: n }, { accountId: S.cash, credit: n }];
const journal = (who, n) => api(who, "POST", "/vouchers/vouchers", { voucherType: "journal", date: new Date().toISOString(), narration: "Month-end accrual", lines: lines(n) });
const voucherId = (r) => r.body?._id || r.body?.voucher?._id;
const waiting = (who, query = "") => api(who, "GET", `/approvals/waiting${query}`);
const numbers = (rows) => rows.map((r) => r.number);

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"), Stock: require("../../models/modules/stockModel"), Customer: require("../../models/modules/customerModel"),
    Transaction: require("../../models/modules/transactionModel"), Voucher: require("../../models/modules/financial/financialModels").Voucher,
    LedgerEntry: require("../../models/modules/financial/financialModels").LedgerEntry, ActivityLog: require("../../models/modules/financial/activityLogModel"),
  };
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

test("an organisation with a customer, an item, the starter chart, and people with every kind of right to approve", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Acc Trading", code: "acc", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@acc.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@acc.test");
  S.id_owner = String((await as(() => M.Admin.findOne({ email: "owner@acc.test" }).lean()))._id);
  S.customer = String((await as(() => new M.Customer({ customerId: "CUST001", customerName: "Al Noor Trading", contactPerson: "Ali Hassan", email: "ali@alnoor.test", phone: "0501234567", paymentTerms: "Net 30", creditLimit: 10000000, trnNumber: "100999888700003", billingAddress: "Deira, Dubai" }).save()))._id);
  S.item = String((await as(() => new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 100000 }).save()))._id);
  S.tax = (await api("owner", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")?._id;
  assert.ok(S.tax);
  const accounts = (await api("owner", "GET", "/accounting/accounts/postable")).body;
  S.rent = accounts.find((a) => /Rent Expense/i.test(a.accountName || a.name))?._id;
  S.cash = accounts.find((a) => /Cash in Hand/i.test(a.accountName || a.name))?._id;
  assert.ok(S.rent && S.cash, "the starter chart has Rent Expense and Cash in Hand");

  await person("editor", ["finance.create", "finance.edit"]); // edits, but may not take postings back
  await person("deleter", ["finance.delete"]); // deletes what never posted, but may not reverse what did
  await person("reposter", ["finance.create", "finance.edit", "finance.deletePosted"]);
  await person("reposter_ltd", ["finance.edit", "finance.deletePosted"], { approvalLimit: 500 });
  await person("salesedit", ["sales.create", "sales.edit"]);
  await person("cashier", ["finance.create"], { approvalLimit: 500 }); // saves vouchers; may not approve; a ceiling
  await person("junior", ["finance.approve", "sales.approve", "sales.create"], { approvalLimit: 500 });
  await person("senior", ["finance.approve", "sales.approve", "sales.create", "finance.create"]);
  await person("salesonly", ["sales.approve"]);
  await person("financeonly", ["finance.approve"]);
  await person("preparer", ["sales.create"]);
  await person("maker_approver", ["sales.create", "sales.approve"]);
  await person("looker", ["sales.view", "finance.view"]);
});

// ---- 1. editing an approved voucher ---------------------------------------------------------------
test("Edit alone cannot change what an approved voucher posted: it is refused, and nothing is reversed or re-posted", { skip }, async () => {
  const made = await journal("owner", 600);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.v1 = voucherId(made);
  assert.equal((await voucherRow(S.v1)).status, "approved");
  assert.deepEqual(await legs(S.v1), ["Cash in Hand:Cr600", "Rent Expense:Dr600"]);

  const refused = await api("editor", "PUT", `/vouchers/vouchers/${S.v1}`, { forceUpdate: true, lines: lines(700) });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.code, "PERMISSION_DENIED");
  assert.ok(refused.details.required.includes("finance.deletePosted"), `names what is missing: ${JSON.stringify(refused.details)}`);
  assert.equal((await voucherRow(S.v1)).totalAmount, 600);
  assert.deepEqual(await legs(S.v1), ["Cash in Hand:Cr600", "Rent Expense:Dr600"], "the postings are exactly as they were");
  assert.equal((await as(() => M.LedgerEntry.countDocuments({ voucherId: S.v1 }))), 2, "and no reversal rows were written");

  // the amount alone, the accounts alone: any change to what it posted
  assert.equal((await api("editor", "PUT", `/vouchers/vouchers/${S.v1}`, { forceUpdate: true, totalAmount: 650 })).status, 403);

  // a narration is not a posted figure
  const narration = await api("editor", "PUT", `/vouchers/vouchers/${S.v1}`, { forceUpdate: true, narration: "October accrual" });
  assert.equal(narration.status, 200, JSON.stringify(narration.data));
  assert.equal((await voucherRow(S.v1)).narration, "October accrual");
  assert.equal((await voucherRow(S.v1)).status, "approved", "and an edit never moves where the voucher stands");
});

test("a request cannot move a voucher's status, approvals or maker through a plain edit", { skip }, async () => {
  const pending = await as(() => new M.Voucher({ voucherNo: "JV-T-1", voucherType: "journal", date: new Date(), totalAmount: 50, status: "pending", approvalStatus: "pending", createdBy: new mongoose.Types.ObjectId(S.id_owner), entries: [] }).save());
  const r = await api("editor", "PUT", `/vouchers/vouchers/${pending._id}`, {
    forceUpdate: true, narration: "tidied", status: "approved", approvalStatus: "approved",
    approvals: [{ by: "x", name: "forged", step: 1 }], createdBy: S.id_editor, voucherNo: "JV-HACKED",
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const now = await voucherRow(pending._id);
  assert.equal(now.narration, "tidied", "the edit itself applied");
  assert.equal(now.status, "pending", "but a voucher is not approved by being edited");
  assert.equal(now.approvalStatus, "pending");
  assert.deepEqual(now.approvals, []);
  assert.equal(String(now.createdBy), S.id_owner, "and its maker cannot be changed to dodge the separate-approver rule");
  assert.equal(now.voucherNo, "JV-T-1");
  assert.equal((await entriesOf(pending._id)).length, 0, "nothing posted");
});

test("with deletePosted the new figures are posted, and become the editor's approval", { skip }, async () => {
  const done = await api("reposter", "PUT", `/vouchers/vouchers/${S.v1}`, { forceUpdate: true, lines: lines(700) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await voucherRow(S.v1)).totalAmount, 700);
  assert.deepEqual(await legs(S.v1), ["Cash in Hand:Cr700", "Rent Expense:Dr700"]);
  assert.deepEqual((await voucherRow(S.v1)).approvals.map((a) => a.by), [S.id_reposter], "who stands behind the new figures");
});

test("the new amount is judged like an approval: the editor's limit", { skip }, async () => {
  const v = voucherId(await journal("owner", 300));
  const over = await api("reposter_ltd", "PUT", `/vouchers/vouchers/${v}`, { forceUpdate: true, lines: lines(700) });
  assert.equal(over.status, 403, JSON.stringify(over.data));
  assert.equal(over.code, "APPROVAL_LIMIT_EXCEEDED");
  assert.deepEqual(over.details, { amount: 700, limit: 500 });
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr300", "Rent Expense:Dr300"], "refused: as it was, the whole edit undone");
  assert.equal((await voucherRow(v)).totalAmount, 300);
  const within = await api("reposter_ltd", "PUT", `/vouchers/vouchers/${v}`, { forceUpdate: true, lines: lines(400) });
  assert.equal(within.status, 200, JSON.stringify(within.data));
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr400", "Rent Expense:Dr400"]);
});

test("the new amount is judged like an approval: the separate approver, and a second approver", { skip }, async () => {
  const mine = voucherId(await journal("reposter", 200));
  assert.equal((await settings({ approvals: { separateApprover: true } })).status, 200);
  try {
    const own = await api("reposter", "PUT", `/vouchers/vouchers/${mine}`, { forceUpdate: true, lines: lines(210) });
    assert.equal(own.status, 403, JSON.stringify(own.data));
    assert.equal(own.code, "SELF_APPROVAL_NOT_ALLOWED", "whoever prepared a voucher does not correct their own figures");
    assert.equal((await api("owner", "PUT", `/vouchers/vouchers/${mine}`, { forceUpdate: true, lines: lines(210) })).status, 200, "someone else may");
  } finally {
    await settings({ approvals: { separateApprover: false } });
  }

  assert.equal((await settings({ approvals: { secondApprovalAbove: 1000 } })).status, 200);
  try {
    const refused = await api("owner", "PUT", `/vouchers/vouchers/${mine}`, { forceUpdate: true, lines: lines(1500) });
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.equal(refused.code, "SECOND_APPROVER_REQUIRED", "one person's edit cannot reach an amount that needs two");
    assert.match(refused.message, /Delete the voucher and enter it again/);
    assert.deepEqual(await legs(mine), ["Cash in Hand:Cr210", "Rent Expense:Dr210"]);
    assert.equal((await api("owner", "PUT", `/vouchers/vouchers/${mine}`, { forceUpdate: true, lines: lines(900) })).status, 200, "under the amount one person is enough");
  } finally {
    await settings({ approvals: { secondApprovalAbove: "" } });
  }
});

test("the older account-voucher routes follow the same rules: a posted (settled) one is not edited or deleted on Edit / Delete alone", { skip }, async () => {
  const settled = await as(() => new M.Voucher({ voucherNo: "SV-T-1", voucherType: "sale", date: new Date(), totalAmount: 10, status: "settled", approvalStatus: "approved", createdBy: new mongoose.Types.ObjectId(S.id_owner), entries: [] }).save());
  const waitingOne = await as(() => new M.Voucher({ voucherNo: "SV-T-2", voucherType: "sale", date: new Date(), totalAmount: 10, status: "pending", approvalStatus: "pending", createdBy: new mongoose.Types.ObjectId(S.id_owner), entries: [] }).save());

  const edit = await api("editor", "PUT", `/account/account-vouchers/${settled._id}`, { forceUpdate: true, paidAmount: 5, invoiceBalances: [] });
  assert.equal(edit.status, 403, JSON.stringify(edit.data));
  assert.equal(edit.code, "PERMISSION_DENIED");
  assert.ok(edit.details.required.includes("finance.deletePosted"));

  const del = await api("deleter", "DELETE", `/account/account-vouchers/${settled._id}`);
  assert.equal(del.status, 403, JSON.stringify(del.data));
  assert.ok(del.details.required.includes("finance.deletePosted"), "a posted one needs the right to reverse it");
  assert.equal((await voucherRow(settled._id)).status, "settled", "untouched");
  const plain = await api("deleter", "DELETE", `/account/account-vouchers/${waitingOne._id}`);
  assert.equal(plain.status, 200, "one that never posted needs only Delete: " + JSON.stringify(plain.data));
  const done = await api("reposter", "DELETE", `/account/account-vouchers/${settled._id}`);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await voucherRow(settled._id)).status, "cancelled");
});

test("an approved trade document cannot be edited at all, by anyone: it is reversed and re-entered, never edited in place", { skip }, async () => {
  const id = await draft("preparer", 6);
  assert.equal((await approveDoc("senior", id)).status, 200);
  for (const who of ["owner", "salesedit"]) {
    const r = await api(who, "PUT", `/transactions/transactions/${id}`, order(7));
    assert.equal(r.status, 400, `${who}: ${JSON.stringify(r.data)}`);
    assert.match(r.message, /Cannot edit processed transactions/);
  }
  assert.equal((await as(() => M.Transaction.findById(id).lean())).totalAmount, 126);
});

// ---- 3. a limit applies to saving too ---------------------------------------------------------------
test("a person with a limit saves a voucher inside it as ever, and one above it is HELD: pending, nothing posted", { skip }, async () => {
  const within = await journal("cashier", 400);
  assert.equal(within.status, 201, JSON.stringify(within.data));
  assert.equal(within.body.status, "approved");
  assert.equal(within.data.approval, undefined, "nothing to say");
  assert.equal((await entriesOf(voucherId(within))).length, 2);

  const held = await journal("cashier", 800);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  S.held = voucherId(held);
  assert.equal(held.body.status, "pending");
  assert.deepEqual({ held: held.data.approval.held, reason: held.data.approval.reason, limit: held.data.approval.limit, amount: held.data.approval.amount }, { held: true, reason: "limit", limit: 500, amount: 800 });
  assert.match(held.data.approval.message, /800\.00 AED, above your approval limit of 500\.00 AED/);
  assert.match(held.body.voucherNo, /^JV-\d{4}-\d{4}$/);
  assert.equal("heldCheque" in held.body, false);
  assert.equal((await entriesOf(S.held)).length, 0, "no ledger rows");

  // the trail says it was held, and by whom
  const trail = await as(() => M.ActivityLog.findOne({ entity: "Voucher", entityId: S.held, action: "VOUCHER_CREATED" }).lean());
  assert.match(trail.summary, /held for approval/);
  // someone without a ceiling who saves the same voucher is not held
  assert.equal((await journal("senior", 800)).body.status, "approved");
});

test("a held voucher is approved through the usual route by someone whose limit covers it, and then posts", { skip }, async () => {
  const limited = await approveVoucher("junior", S.held);
  assert.equal(limited.status, 403);
  assert.equal(limited.code, "APPROVAL_LIMIT_EXCEEDED");
  assert.equal((await voucherRow(S.held)).status, "pending");
  assert.equal((await entriesOf(S.held)).length, 0);

  const done = await approveVoucher("senior", S.held);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await voucherRow(S.held)).status, "approved");
  assert.deepEqual(await legs(S.held), ["Cash in Hand:Cr800", "Rent Expense:Dr800"]);
  assert.deepEqual((await voucherRow(S.held)).approvals.map((a) => a.by), [S.id_senior]);
  assert.equal(await approveVoucher("senior", S.held).then((r) => r.status), 400, "approved once, not twice");
});

test("a held voucher that is turned down never posts; its maker can still fix and resubmit through an edit", { skip }, async () => {
  const id = voucherId(await journal("cashier", 900));
  const edited = await api("editor", "PUT", `/vouchers/vouchers/${id}`, { forceUpdate: true, lines: lines(950) });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal((await voucherRow(id)).status, "pending", "editing it is not approving it");
  assert.equal((await entriesOf(id)).length, 0);
  const rejected = await api("senior", "PATCH", `/vouchers/vouchers/${id}/approve`, { action: "reject" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal((await voucherRow(id)).status, "rejected");
  assert.equal((await entriesOf(id)).length, 0);
});

test("above the organisation's second-approver amount even the owner's voucher waits for two different people", { skip }, async () => {
  assert.equal((await settings({ approvals: { secondApprovalAbove: 1000 } })).status, 200);
  try {
    const small = await journal("owner", 900);
    assert.equal(small.body.status, "approved");
    const big = await journal("owner", 1500);
    assert.equal(big.body.status, "pending");
    assert.equal(big.data.approval.reason, "second");
    const id = voucherId(big);
    const first = await approveVoucher("senior", id);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.approval, { awaitingSecond: true, given: 1 });
    assert.equal((await entriesOf(id)).length, 0);
    assert.equal((await approveVoucher("senior", id)).code, "SECOND_APPROVER_REQUIRED");
    assert.equal((await approveVoucher("owner", id)).status, 200, "a different person finishes it");
    assert.deepEqual(await legs(id), ["Cash in Hand:Cr1500", "Rent Expense:Dr1500"]);
  } finally {
    await settings({ approvals: { secondApprovalAbove: "" } });
  }
});

// ---- 2. the approvals list ---------------------------------------------------------------------------
test("the list is for people who can approve something: anyone else is refused, and nobody signed in even more so", { skip }, async () => {
  for (const who of ["looker", "cashier", "preparer", "editor"]) {
    const r = await waiting(who);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
    assert.equal(r.code, "PERMISSION_DENIED");
    assert.deepEqual(r.details.required.sort(), ["finance.approve", "purchase.approve", "sales.approve"]);
  }
  assert.equal((await call("GET", "/approvals/waiting")).status, 401);
});

test("what is waiting, for whom: documents and vouchers, judged by the approve rules, each with the reason it is not yours", { skip }, async () => {
  // fresh ground: whatever earlier tests left waiting is decided first
  for (const r of (await waiting("owner")).body.forYou) {
    const res = r.kind === "document" ? await approveDoc("owner", r.id) : await approveVoucher("owner", r.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
  assert.deepEqual((await waiting("owner")).body.counts, { forYou: 0, others: 0 });

  S.small = await draft("preparer", 6); // 126
  S.big = await draft("preparer", 40); // 840
  S.heldV = voucherId(await journal("cashier", 800));

  const senior = (await waiting("senior")).body;
  assert.deepEqual(numbers(senior.forYou).length, 3, JSON.stringify(senior));
  assert.deepEqual(senior.others, []);
  assert.deepEqual(senior.counts, { forYou: 3, others: 0 });
  const doc = senior.forYou.find((r) => r.id === S.big);
  assert.equal(doc.kind, "document");
  assert.equal(doc.type, "sales_order");
  assert.equal(doc.typeLabel, "Sales order");
  assert.match(doc.number, /^SO-\d{4}-\d{4}$/);
  assert.equal(doc.party, "Al Noor Trading");
  assert.equal(doc.amount, 840);
  assert.equal(doc.preparedBy, "preparer");
  assert.equal(doc.ageDays, 0);
  assert.equal(doc.state, "waiting");
  assert.equal(doc.reason, null);
  assert.deepEqual([doc.step, doc.of], [1, 1]);
  assert.equal(doc.link, `/sales-order?search=${encodeURIComponent(doc.number)}`);
  assert.ok(doc.date && doc.createdAt);
  const v = senior.forYou.find((r) => r.id === S.heldV);
  assert.equal(v.kind, "voucher");
  assert.equal(v.type, "journal");
  assert.equal(v.typeLabel, "Journal");
  assert.equal(v.amount, 800);
  assert.equal(v.preparedBy, "cashier");
  assert.equal(v.link, "/journal-voucher");
  // oldest first: an approver clears the oldest
  assert.deepEqual(senior.forYou.map((r) => r.id), [S.small, S.big, S.heldV]);

  // a role with a ceiling is shown what it could approve, and the rest with the reason
  const junior = (await waiting("junior")).body;
  assert.deepEqual(junior.forYou.map((r) => r.id), [S.small]);
  assert.deepEqual(junior.others.map((r) => [r.id, r.reason.code]), [[S.big, "APPROVAL_LIMIT_EXCEEDED"], [S.heldV, "APPROVAL_LIMIT_EXCEEDED"]]);
  assert.match(junior.others[0].reason.message, /840\.00 AED and your approval limit is 500\.00 AED/);
  assert.equal(junior.others[0].step, null);
});

test("a module you cannot approve in is not shown at all - not in your list, not in the others", { skip }, async () => {
  const salesOnly = (await waiting("salesonly")).body;
  assert.deepEqual([...salesOnly.forYou, ...salesOnly.others].map((r) => r.id).sort(), [S.small, S.big].sort());
  assert.ok([...salesOnly.forYou, ...salesOnly.others].every((r) => r.kind === "document"));
  const financeOnly = (await waiting("financeonly")).body;
  assert.deepEqual([...financeOnly.forYou, ...financeOnly.others].map((r) => r.id), [S.heldV]);
});

test("the count for a badge is the same answer without the rows", { skip }, async () => {
  const senior = await waiting("senior", "?countOnly=1");
  assert.equal(senior.status, 200);
  assert.deepEqual(senior.body, { count: 3, others: 0, capped: false });
  const junior = await waiting("junior", "?countOnly=1");
  assert.deepEqual(junior.body, { count: 1, others: 2, capped: false });
  assert.equal((await waiting("salesonly", "?countOnly=true")).body.count, 2);
  assert.equal((await waiting("looker", "?countOnly=1")).status, 403);
});

test("the person who prepared it sees it as not theirs when the organisation separates the two, and as theirs when it does not", { skip }, async () => {
  const mine = await draft("maker_approver", 6); // 126
  assert.ok((await waiting("maker_approver")).body.forYou.some((r) => r.id === mine), "separate approver off: theirs to approve");
  assert.equal((await settings({ approvals: { separateApprover: true } })).status, 200);
  try {
    const list = (await waiting("maker_approver")).body;
    assert.ok(!list.forYou.some((r) => r.id === mine));
    assert.deepEqual(list.others.find((r) => r.id === mine).reason.code, "SELF_APPROVAL_NOT_ALLOWED");
    assert.match(list.others.find((r) => r.id === mine).reason.message, /You prepared this document/);
    assert.ok((await waiting("senior")).body.forYou.some((r) => r.id === mine), "anyone else may");
    assert.equal((await approveDoc("maker_approver", mine)).code, "SELF_APPROVAL_NOT_ALLOWED", "and the route agrees with the list");
  } finally {
    await settings({ approvals: { separateApprover: false } });
  }
  assert.equal((await approveDoc("senior", mine)).status, 200);
});

test("a first approval moves the document to the second approver's list and out of the first one's", { skip }, async () => {
  assert.equal((await settings({ approvals: { secondApprovalAbove: 500 } })).status, 200);
  try {
    const listed = (await waiting("senior")).body;
    // before anyone has approved: the 840 order needs two approvers, so senior's approval would be the first of two
    const before = listed.forYou.find((r) => r.id === S.big);
    assert.deepEqual([before.state, before.step, before.of], ["waiting", 1, 2]);
    assert.deepEqual([before.given], [0]);
    // a voucher held for the same reason is in the same position
    assert.deepEqual([listed.forYou.find((r) => r.id === S.small).step, listed.forYou.find((r) => r.id === S.small).of], [1, 1], "126 needs only one");

    const first = await approveDoc("senior", S.big);
    assert.deepEqual(first.body.approval, { awaitingSecond: true, given: 1 });

    const firstApprover = (await waiting("senior")).body;
    assert.ok(!firstApprover.forYou.some((r) => r.id === S.big), "no longer theirs to approve");
    const mine = firstApprover.others.find((r) => r.id === S.big);
    assert.equal(mine.reason.code, "SECOND_APPROVER_REQUIRED");
    assert.equal(mine.state, "awaiting second approver");
    assert.deepEqual(mine.firstApprovers, ["senior"]);

    const second = (await waiting("owner")).body.forYou.find((r) => r.id === S.big);
    assert.equal(second.state, "awaiting second approver");
    assert.deepEqual([second.step, second.of, second.given], [2, 2, 1]);

    // a person whose limit is too low for it is shown it as over their limit, not as a second approval they could give
    const low = (await waiting("junior")).body.others.find((r) => r.id === S.big);
    assert.equal(low.reason.code, "APPROVAL_LIMIT_EXCEEDED");

    assert.equal((await approveDoc("owner", S.big)).status, 200);
    for (const who of ["senior", "owner"]) {
      const after = (await waiting(who)).body;
      assert.ok(![...after.forYou, ...after.others].some((r) => r.id === S.big), `${who}: decided, so gone`);
    }
  } finally {
    await settings({ approvals: { secondApprovalAbove: "" } });
  }
});

test("approving from the list is the usual approve: the same refusals, and the row leaves when it is decided", { skip }, async () => {
  assert.equal((await approveDoc("senior", S.small)).status, 200);
  assert.ok(!(await waiting("senior")).body.forYou.some((r) => r.id === S.small));
  assert.equal((await approveVoucher("senior", S.heldV)).status, 200);
  assert.deepEqual((await waiting("senior")).body.forYou.filter((r) => r.kind === "voucher"), []);
  assert.equal((await waiting("senior", "?countOnly=1")).body.count, 0);
});

test("it is the branch being worked in that is listed: head office sees every branch's documents, or one branch's when it picks one", { skip }, async () => {
  const made = await api("owner", "POST", "/branches", { code: "shj", name: "Sharjah Warehouse" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const main = await draft("preparer", 6);
  const shj = (await apiAt("owner", "shj", "POST", "/transactions/transactions", order(6)));
  assert.equal(shj.status, 201, JSON.stringify(shj.data));

  const ids = (r) => r.body.forYou.map((x) => x.id);
  const everywhere = await waiting("senior");
  assert.ok(ids(everywhere).includes(main) && ids(everywhere).includes(shj.body._id), "head office sees both");
  const inSharjah = await apiAt("senior", "shj", "GET", "/approvals/waiting");
  assert.equal(inSharjah.status, 200, JSON.stringify(inSharjah.data));
  assert.deepEqual(ids(inSharjah), [shj.body._id], "working in Sharjah: only Sharjah's");
  assert.deepEqual((await apiAt("senior", "shj", "GET", "/approvals/waiting?countOnly=1")).body, { count: 1, others: 0, capped: false });
  const inMain = await apiAt("senior", "main", "GET", "/approvals/waiting");
  assert.deepEqual(ids(inMain), [main], "and in head office: only head office's");
  assert.equal((await approveDoc("senior", main)).status, 200);
  assert.equal((await approveDoc("senior", shj.body._id)).status, 200);
});
