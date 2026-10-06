// Bank reconciliation over HTTP: a real server process against a throwaway database, real login. The
// service tests call the code directly; this proves what only a request can: the routes are
// reachable (under /banking, before adminRouter), need a login, can be READ by anyone signed in but
// CHANGED only by an admin, answer in the { success, data } envelope, report errors with a status and
// an errorCode, and leave an audit trail of who did what.
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
const REC = "/banking/reconciliation";
const ROOT = path.resolve(__dirname, "..", "..");

let child;
let M;
const S = {};
let logs = "";

async function call(method, url, { body, token = S.token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data };
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
    Customer: require("../../models/modules/customerModel"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    Chart: require("../financial/chartOfAccountsService"),
    Activity: require("../../models/modules/financial/activityLogModel"),
    Voucher: require("../../models/modules/financial/financialModels").Voucher,
  };
  await mongoose.connection.syncIndexes();
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

const day = (n) => new Date(Date.now() + 4 * 3600000 + n * 86400000).toISOString().slice(0, 10); // Dubai
const dmy = (d) => d.split("-").reverse().join("/");
const GRID = [
  ["Date", "Description", "Debit", "Credit", "Balance"],
  [dmy(day(-3)), "TRANSFER FROM CUST TRF-7001", "", "525.00", "525.00"],
  [dmy(day(-2)), "BANK CHARGES INCL VAT", "10.50", "", "514.50"],
];

test("setup: an admin and a viewer, a bank account, a customer receipt in the books", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  await new M.Admin({ name: "Viewer", email: "viewer@test.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();
  const login = await call("POST", "/login", { body: { email: "boss@test.uae", password: "12312312" }, token: null });
  assert.equal(login.status, 200);
  S.token = login.body.tokens.accessToken;
  S.viewer = (await call("POST", "/login", { body: { email: "viewer@test.uae", password: "12312312" }, token: null })).body.tokens.accessToken;
  await call("GET", "/accounting/chart"); // opens the chart: posting on, accounts mapped

  S.customer = await M.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", creditLimit: 1e6 });
  const group = await M.AccountGroup.findOne({ name: "Bank" });
  const made = await call("POST", "/accounting/accounts", { body: { accountName: "HTTP Bank", groupId: group._id } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.bank = made.body._id;

  // the receipt goes through the real voucher route (it answers in the older { status, data } envelope)
  const rv = await call("POST", "/vouchers/vouchers", {
    body: { voucherType: "receipt", customerId: S.customer._id, totalAmount: 525, date: day(-3), paymentMode: "transfer", paymentDetails: { accountId: S.bank, reference: "TRF-7001" } },
  });
  assert.equal(rv.status, 201, JSON.stringify(rv.data));
  S.rv = rv.data.data;
});

test("every route needs a login, and the fixed paths are not mistaken for an id", { skip }, async () => {
  for (const url of ["/accounts", "/lines?accountId=x", "/proof?accountId=x", "/reconciliations", "/card/variance?accountId=x", "/setup/status?accountId=x"]) {
    assert.equal((await call("GET", `${REC}${url}`, { token: null })).status, 401, url);
  }
  // adminRouter's bare GET /:id would swallow these if they were mounted after it
  const accounts = await call("GET", `${REC}/accounts`);
  assert.equal(accounts.status, 200);
  assert.equal(accounts.data.success, true);
  assert.ok(accounts.body.some((a) => String(a._id) === S.bank && a.setUp === false));
});

test("anyone signed in can read; only an admin can change", { skip }, async () => {
  assert.equal((await call("GET", `${REC}/accounts`, { token: S.viewer })).status, 200);
  for (const [method, url, body] of [
    ["PUT", "/setup", { accountId: S.bank, startDay: day(-5), statementOpening: 0 }],
    ["POST", "/import/preview", { accountId: S.bank, rows: GRID }],
    ["POST", "/import", { accountId: S.bank, rows: GRID }],
    ["POST", "/matches", { accountId: S.bank, lineIds: [] }],
    ["POST", "/matches/accept", { accountId: S.bank }],
    ["POST", "/reconciliations", { accountId: S.bank, asOf: day(0), statementBalance: 0 }],
    ["POST", "/card/settle", { accountId: S.bank }],
  ]) {
    const r = await call(method, `${REC}${url}`, { body, token: S.viewer });
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.data.errorCode, "INSUFFICIENT_ROLE");
  }
});

test("import over HTTP: a bad request says what is wrong; a good one needs the start of the statement first", { skip }, async () => {
  const noBank = await call("POST", `${REC}/import/preview`, { body: { rows: GRID } });
  assert.equal(noBank.status, 400);
  assert.equal(noBank.data.errorCode, "ACCOUNT_REQUIRED");
  const notBank = await call("POST", `${REC}/import/preview`, { body: { accountId: String(S.customer._id), rows: GRID } });
  assert.equal(notBank.data.errorCode, "NOT_A_BANK_ACCOUNT");
  const empty = await call("POST", `${REC}/import/preview`, { body: { accountId: S.bank, rows: [] } });
  assert.equal(empty.data.errorCode, "EMPTY_FILE");

  const preview = await call("POST", `${REC}/import/preview`, { body: { accountId: S.bank, rows: GRID } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.body.counts.total, 2);
  assert.equal(preview.body.setup.exists, false);
  assert.equal(preview.body.setup.suggestedStart, day(-3));
  assert.equal(preview.body.setup.suggestedOpening, 0);

  const early = await call("POST", `${REC}/import`, { body: { accountId: S.bank, rows: GRID } });
  assert.equal(early.status, 409);
  assert.equal(early.data.errorCode, "SETUP_REQUIRED");

  const saved = await call("PUT", `${REC}/setup`, { body: { accountId: S.bank, startDay: day(-3), statementOpening: 0 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.body.difference, 0);

  const done = await call("POST", `${REC}/import`, { body: { accountId: S.bank, rows: GRID, fileName: "oct.csv" } });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.body.imported, 2);
  const again = await call("POST", `${REC}/import`, { body: { accountId: S.bank, rows: GRID } });
  assert.equal(again.status, 409);
  assert.equal(again.data.errorCode, "ALL_DUPLICATES");

  const profile = await call("GET", `${REC}/profile?accountId=${S.bank}`);
  assert.equal(profile.body.columns.date, 0, "the layout is remembered for next time");
});

test("the worklist suggests, accepts, posts a fee, and the proof finishes: all over HTTP", { skip }, async () => {
  const lines = await call("GET", `${REC}/lines?accountId=${S.bank}&tab=suggested`);
  assert.equal(lines.status, 200);
  assert.equal(lines.body.counts.suggested, 1);
  assert.equal(lines.body.rows[0].suggestion.confidence, "high");
  assert.equal(lines.body.rows[0].suggestion.entries[0].voucherNo, S.rv.voucherNo);

  const accepted = await call("POST", `${REC}/matches/accept`, { body: { accountId: S.bank } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.body.accepted, 1);

  const todo = await call("GET", `${REC}/lines?accountId=${S.bank}&tab=todo`);
  const fee = todo.body.rows[0];
  assert.match(fee.description, /BANK CHARGES/);
  const wrong = await call("POST", `${REC}/lines/${fee._id}/create`, { body: { accountId: S.bank, kind: "interest" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.errorCode, "WRONG_DIRECTION");
  const posted = await call("POST", `${REC}/lines/${fee._id}/create`, { body: { accountId: S.bank, kind: "fee" } });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(posted.body.voucher.totalAmount, 10.5);
  S.fee = posted.body;

  // the receipt cannot be deleted through the voucher route while the bank has matched it
  const del = await call("DELETE", `/vouchers/vouchers/${S.rv._id}`);
  assert.equal(del.status, 409, JSON.stringify(del.data));
  assert.equal(del.data.errorCode, "BANK_MATCHED");

  const proof = await call("GET", `${REC}/proof?accountId=${S.bank}&asOf=${day(0)}&statementBalance=514.5`);
  assert.equal(proof.status, 200, JSON.stringify(proof.data));
  assert.equal(proof.body.difference, 0);
  assert.equal(proof.body.canFinish, true);
  const off = await call("POST", `${REC}/reconciliations`, { body: { accountId: S.bank, asOf: day(0), statementBalance: 600 } });
  assert.equal(off.status, 409);
  assert.equal(off.data.errorCode, "RECONCILIATION_NOT_READY");

  const done = await call("POST", `${REC}/reconciliations`, { body: { accountId: S.bank, asOf: day(0), statementBalance: 514.5, note: "October" } });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.match(done.body.number, /^BRC-\d{4}-0001$/);
  S.rec = done.body;

  const got = await call("GET", `${REC}/reconciliations/${S.rec._id}`);
  assert.equal(got.body.proof.difference, 0);
  assert.equal(got.body.account.accountName, "HTTP Bank");
  const unmatch = await call("DELETE", `${REC}/matches/${S.fee.match._id}`);
  assert.equal(unmatch.status, 409);
  assert.equal(unmatch.data.errorCode, "BANK_RECONCILED");

  const reopened = await call("POST", `${REC}/reconciliations/${S.rec._id}/reopen`, { body: { reason: "Checking" } });
  assert.equal(reopened.status, 200);
  assert.equal((await call("GET", `${REC}/accounts`)).body.find((a) => a._id === S.bank).lastReconciled, null);
});

test("who did what is recorded", { skip }, async () => {
  const actions = (await M.Activity.find({}).sort({ at: 1 }).lean()).filter((a) => /^BANK_|^CARD_/.test(a.action));
  const names = actions.map((a) => a.action);
  for (const want of ["BANK_RECON_SETUP", "BANK_STATEMENT_IMPORTED", "BANK_LINES_MATCHED", "BANK_LINE_POSTED", "BANK_RECONCILIATION_COMPLETED", "BANK_RECONCILIATION_REOPENED"]) {
    assert.ok(names.includes(want), `${want} was logged (${names.join(", ")})`);
  }
  assert.ok(actions.every((a) => a.username === "boss@test.uae"), "and by whom");
  assert.ok(actions.every((a) => a.summary && a.summary.length > 5), "with a sentence a person can read");
});
