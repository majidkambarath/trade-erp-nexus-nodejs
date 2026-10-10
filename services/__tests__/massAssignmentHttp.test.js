// MASS ASSIGNMENT. A client sends a body; the server must take from it only what that route is for. On every create and update
// route of people, the profile, roles, organisation settings, trade documents, vouchers, items, customers (and the other masters),
// each body is stuffed with fields a client must never set - the organisation, branch, role, type, permissions, activity flags,
// lock and password flags, who created it, approvals, the last send, a close-short mark, opening and reversal flags, ids and
// versions, update operators, prototype keys - and the stored record is read back from the DATABASE to prove none took effect.
//
// A prototype probe runs INSIDE the server (support/pollutionProbe.js, node --require) and reports if anything is ever added to
// Object.prototype or another built-in: a body shaped like {"__proto__": {...}} is sent to every mutating route in the API.
// Run alone:  node --require ./utils/testSetup.js --test services/__tests__/massAssignmentHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const H = require("./support/httpHarness");
const { inventory } = require("./support/routeInventory");
const { seedOrg, loadAllModels, today, ownedIds } = require("./support/seedOrg");
const { modelsFor } = require("./support/routeHints");

const skip = H.skipReason();
const C = "massorg";
const O = "otherorg"; // an organisation a body may try to name
const FORGED_ID = "64b64b64b64b64b64b64b64c";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALL_KEYS = require("../../utils/permissions").ALL_KEYS;

let stack, call, R;
const log = (m) => process.stderr.write(`    # ${m}\n`);

// ---- fields every record has and no body may set
const COMMON = () => ({
  companyId: O, _id: FORGED_ID, __v: 77, createdBy: "FORGED-USER", updatedBy: "FORGED-USER", createdAt: "2001-01-01T00:00:00.000Z",
  approvals: [{ by: "FORGED", name: "FORGED", at: "2001-01-01T00:00:00.000Z", step: 1 }],
  lastSend: { status: "SENT", channel: "email", to: "forged@x.test" },
  closedShort: { at: "2001-01-01T00:00:00.000Z", by: "FORGED", reason: "FORGED" },
  isOpening: true, posted: true, isReversed: true,
});
// a JSON text with the keys a normal object literal cannot carry: __proto__ as an OWN key, constructor.prototype, update operators
const hostile = (obj) => JSON.stringify(obj).replace(/^\{/, '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"$set":{"name":"FORGED"},"$unset":{"status":1},');

const api = (who, method, url, body) => call(method, url, { token: R.tokens[who], body });
const apiRaw = (who, method, url, obj) => call(method, url, { token: R.tokens[who], raw: hostile(obj), headers: { "Content-Type": "application/json" } });
const find = (model, filter) => stack.raw(() => mongoose.model(model).findOne(filter).lean());
const recOf = (res) => (res.body && res.body._id ? res.body : Object.values(res.body || {}).find((v) => v && typeof v === "object" && v._id) || res.data?.data);
const at = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Add to `problems` when `actual` is not what it should be. */
const expect = (problems, label, actual, expected) => { if (!same(actual, expected)) problems.push(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`); };
const expectNot = (problems, label, actual, forbidden) => { if (same(actual, forbidden)) problems.push(`${label}: the forged value ${JSON.stringify(forbidden)} was stored`); };
/** The stored record must carry nothing that came from the stuffing. */
function expectClean(problems, label, doc) {
  const text = JSON.stringify(doc);
  for (const bad of ["FORGED", "polluted", "forged@x.test"]) if (text.includes(bad)) problems.push(`${label}: the stored record contains '${bad}'`);
  if (doc.companyId !== C) problems.push(`${label}: filed under ${doc.companyId}, not ${C}`);
  if (String(doc._id) === FORGED_ID) problems.push(`${label}: the record took the id from the body`);
  if (doc.__v === 77) problems.push(`${label}: the record took __v from the body`);
  if (doc.createdAt && new Date(doc.createdAt).getFullYear() === 2001) problems.push(`${label}: createdAt came from the body`);
}

test.before(async () => {
  if (skip) return;
  stack = await H.startStack("mass", { probe: true });
  call = H.makeCaller(stack.base);
  loadAllModels();
  R = await seedOrg({ stack, call, code: C, tag: "A", log });
  await stack.Org.create({ legalName: "Other Org Trading LLC", code: O, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  // a role that may edit but not move stock, and a person in it
  const Admin = require("../../models/core/adminModel");
  const Role = require("../../models/core/roleModel");
  await stack.as(C, () => Role.create({ key: "editor", name: "Editor", rank: 30, permissions: ["inventory.edit", "sales.edit", "purchase.edit", "finance.edit"], isActive: true }));
  await stack.as(C, () => new Admin({ name: "editor", email: "editor@massorg.sec.test", password: H.PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: "editor" }).save());
  R.tokens.editor = (await call("POST", "/login", { body: { email: "editor@massorg.sec.test", password: H.PASSWORD } })).body.tokens.accessToken;
  // an administrator (below the owner): may manage people, but may not make anyone an owner or administrator
  await stack.as(C, () => new Admin({ name: "admin", email: "admin@massorg.sec.test", password: H.PASSWORD, status: "active", isActive: true, type: "admin" }).save());
  R.tokens.admin = (await call("POST", "/login", { body: { email: "admin@massorg.sec.test", password: H.PASSWORD } })).body.tokens.accessToken;
  stack.armProbe();
  await new Promise((r) => setTimeout(r, 300));
});
test.after(async () => {
  if (skip) return;
  await stack?.stop();
});

// ================================================================================================================ trade documents
test("a trade document: the server decides its number, totals, state, branch, author and links; the body decides only what the form is for", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const owner = (await find("Admin", { email: { $regex: /^canary-a-owner-1@/i } }))._id;
  const line = (extra = {}) => ({
    itemId: R.ids.stock[0], description: "MASS line", qty: 2, price: 100, rate: 100, vatPercent: 5, taxCodeId: R.ids.taxCode[0],
    allocations: [{ batchId: FORGED_ID, batchNumber: "FORGED", qty: 999 }], itemType: "service", taxKind: "exempt", vatAmount: 0, lineTotal: 1, grossAmount: 1, taxableAmount: 1, rcmVat: 99, currentPurchasePrice: 0.01, ...extra,
  });
  const stuff = () => ({
    ...COMMON(), transactionNo: "FORGED-0001", totalAmount: 1, pricing: { grandTotal: 1, net: 1 }, paidAmount: 999999, outstandingAmount: 0,
    grnGenerated: true, invoiceGenerated: true, creditNoteIssued: true, branchId: R.extra.branchCode, dueDate: "2001-01-01T00:00:00.000Z",
    quoteRef: "FORGED-QUOTE", linkedRef: "FORGED-LINK", attachments: [], returnDate: "2001-01-01T00:00:00.000Z",
  });
  // naming an original document on something that is not a return is refused outright
  const notReturn = await api("owner", "POST", "/transactions/transactions", { type: "sales_order", partyId: R.ids.customer[0], partyType: "Customer", partyTypeRef: "Customer", notes: "MASS-tx-notreturn", items: [line()], returnOf: { transactionId: R.ids.transaction[0] } });
  assert.equal(notReturn.status, 400, notReturn.text.slice(0, 200));
  const made = await api("owner", "POST", "/transactions/transactions", { type: "sales_order", partyId: R.ids.customer[0], partyType: "Customer", partyTypeRef: "Customer", notes: "MASS-tx", items: [line()], ...stuff() });
  assert.equal(made.status, 201, made.text.slice(0, 300));
  const doc = await find("Transaction", { notes: "MASS-tx" });
  expectClean(problems, "created sales order", doc);
  expect(problems, "status", doc.status, "DRAFT");
  if (!/^SO-\d{4}-\d{4}$/.test(doc.transactionNo)) problems.push(`transactionNo: the body chose the number: ${doc.transactionNo}`);
  expect(problems, "totalAmount is computed", doc.totalAmount, 210);
  expect(problems, "pricing.grandTotal is computed", doc.pricing?.grandTotal, 210);
  expect(problems, "paidAmount", doc.paidAmount, 0);
  expect(problems, "outstandingAmount", doc.outstandingAmount, 210);
  for (const f of ["grnGenerated", "invoiceGenerated", "creditNoteIssued", "isOpening"]) expect(problems, f, doc[f], false);
  expect(problems, "branchId is where the author works", doc.branchId, "main");
  expect(problems, "dueDate", doc.dueDate ?? null, null);
  expect(problems, "createdBy is the signed-in person", String(doc.createdBy), String(owner));
  expect(problems, "approvals", doc.approvals || [], []);
  expect(problems, "lastSend", doc.lastSend ?? null, null);
  expect(problems, "closedShort", doc.closedShort ?? null, null);
  expect(problems, "quoteRef", doc.quoteRef ?? null, null);
  expect(problems, "linkedRef", doc.linkedRef ?? null, null);
  expect(problems, "returnOf on a sales order", doc.returnOf?.transactionId ?? null, null);
  expect(problems, "line allocations", doc.items?.[0]?.allocations || [], []);
  expect(problems, "line itemType comes from the item master", doc.items?.[0]?.itemType, "goods");
  expect(problems, "line lineTotal is computed", doc.items?.[0]?.lineTotal, 210);
  expect(problems, "line rcmVat", doc.items?.[0]?.rcmVat ?? null, null);
  expect(problems, "line taxKind comes from the tax code", doc.items?.[0]?.taxKind === "exempt", false);
  assert.deepEqual(problems, [], "creating a trade document");

  // a status other than DRAFT is refused: approval is its own action
  const forced = await api("owner", "POST", "/transactions/transactions", { type: "sales_order", partyId: R.ids.customer[0], partyType: "Customer", partyTypeRef: "Customer", notes: "MASS-tx-forced", status: "APPROVED", items: [line()] });
  assert.equal(forced.status, 400, forced.text.slice(0, 200));
  assert.equal(await find("Transaction", { notes: "MASS-tx-forced" }), null);

  // editing the draft
  const before = { ...doc };
  const edit = await api("owner", "PUT", `/transactions/transactions/${doc._id}`, { notes: "MASS-tx edited", type: "purchase_order", ...stuff(), returnOf: { transactionId: R.ids.transaction[0], transactionNo: "FORGED" }, partyType: "Vendor", partyTypeRef: "Vendor" });
  assert.ok(edit.status < 300, `the edit itself should work: ${edit.status} ${edit.text.slice(0, 300)}`);
  const after = await find("Transaction", { _id: doc._id });
  expect(problems, "the legitimate edit", after.notes, "MASS-tx edited");
  expectClean(problems, "edited sales order", after);
  for (const f of ["type", "transactionNo", "paidAmount", "outstandingAmount", "grnGenerated", "invoiceGenerated", "creditNoteIssued", "isOpening", "branchId", "createdBy", "totalAmount", "status", "partyId"]) expect(problems, `${f} after the edit`, after[f], before[f]);
  expect(problems, "dueDate after the edit", after.dueDate ?? null, null);
  expect(problems, "returnOf after the edit", after.returnOf?.transactionId ?? null, null);
  expect(problems, "quoteRef after the edit", after.quoteRef ?? null, null);
  expect(problems, "linkedRef after the edit", after.linkedRef ?? null, null);
  expect(problems, "approvals after the edit", after.approvals || [], []);
  expect(problems, "lastSend after the edit", after.lastSend ?? null, null);
  expect(problems, "closedShort after the edit", after.closedShort ?? null, null);
  assert.deepEqual(problems, [], "editing a trade document");
  const forcedEdit = await api("owner", "PUT", `/transactions/transactions/${doc._id}`, { status: "APPROVED" });
  assert.equal(forcedEdit.status, 400, "approval cannot be written into an edit");
  expect(problems, "still a draft", (await find("Transaction", { _id: doc._id })).status, "DRAFT");
  assert.deepEqual(problems, [], "forcing a status");
});

// ================================================================================================================ vouchers
test("a voucher: its number, author, approval, entries and posting come from the server", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const owner = String((await find("Admin", { email: { $regex: /^canary-a-owner-1@/i } }))._id);
  const stuff = () => ({
    ...COMMON(), voucherNo: "FORGED-RV-1", entries: [{ accountId: R.ids.account[0], debitAmount: 99999, creditAmount: 0 }], onAccountAmount: 99999, approvedBy: "FORGED", approvedAt: "2001-01-01T00:00:00.000Z",
    approvalStatus: "approved", submittedBy: "FORGED", branchId: R.extra.branchCode, financialYear: "FORGED", referenceType: "FORGED", referenceId: FORGED_ID, referenceNo: "FORGED", heldCheque: { chequeNo: "FORGED" }, rateOverridden: true, month: 1, year: 1999,
  });
  const made = await api("owner", "POST", "/vouchers/vouchers", { voucherType: "receipt", customerId: R.ids.customer[0], totalAmount: 55.55, paymentMode: "cash", date: today(), narration: "MASS-voucher", ...stuff() });
  assert.ok(made.status < 300, made.text.slice(0, 300));
  const doc = await find("Voucher", { narration: "MASS-voucher" });
  expectClean(problems, "created receipt", doc);
  if (!/^RV-\d{4}-\d{4}$/.test(doc.voucherNo)) problems.push(`voucherNo: the body chose the number: ${doc.voucherNo}`);
  expect(problems, "createdBy", String(doc.createdBy), owner);
  expect(problems, "approvals", doc.approvals || [], []);
  expect(problems, "branchId", doc.branchId, "main");
  expect(problems, "onAccountAmount", doc.onAccountAmount, 55.55);
  expectNot(problems, "approvedBy", doc.approvedBy, "FORGED");
  expectNot(problems, "submittedBy", doc.submittedBy, "FORGED");
  expectNot(problems, "month", doc.month, 1);
  expectNot(problems, "year", doc.year, 1999);
  const entries = await stack.raw(() => mongoose.model("LedgerEntry").find({ companyId: C, voucherId: doc._id }).lean());
  expect(problems, "ledger entries posted by the server (two sides)", entries.length, 2);
  expect(problems, "ledger entry totals", Math.round(entries.reduce((t, e) => t + e.debitAmount, 0) * 100) / 100, 55.55);
  assert.deepEqual(problems, [], "creating a voucher");

  const before = { ...doc };
  const edit = await api("owner", "PUT", `/vouchers/vouchers/${doc._id}`, { narration: "MASS-voucher edited", ...stuff(), voucherType: "payment" });
  log(`voucher edit answered ${edit.status} ${edit.text.slice(0, 120)}`);
  const after = await find("Voucher", { _id: doc._id });
  if (edit.status < 300) expect(problems, "the legitimate edit", after.narration, "MASS-voucher edited");
  expectClean(problems, "edited receipt", after);
  expect(problems, "voucherType after the edit", after.voucherType, before.voucherType);
  expect(problems, "voucherNo after the edit", after.voucherNo, before.voucherNo);
  expect(problems, "createdBy after the edit", String(after.createdBy), owner);
  expect(problems, "approvals after the edit", after.approvals || [], []);
  assert.deepEqual(problems, [], "editing a voucher");
});

// ================================================================================================================ masters
test("an item: the average cost and the quantity on hand are the system's; a quantity needs the adjust permission", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const made = await api("owner", "POST", "/stock/stock", { itemName: "MASS item", sku: "MASS-SKU-1", categoryId: R.ids.category[0], unitOfMeasure: R.ids.unit[0], salesPrice: 12.34, purchasePrice: 5.55, ...COMMON(), costValue: 987654.32, vendorId: FORGED_ID });
  assert.ok(made.status < 300, made.text.slice(0, 300));
  const doc = await find("Stock", { sku: "MASS-SKU-1" });
  expectClean(problems, "created item", doc);
  expectNot(problems, "costValue", doc.costValue, 987654.32);
  const edit = await api("editor", "PUT", `/stock/stock/${doc._id}`, { itemName: "MASS item edited", ...COMMON(), costValue: 987654.32, status: "Active" });
  assert.ok(edit.status < 300, `an editor edits an item: ${edit.status} ${edit.text.slice(0, 200)}`);
  const after = await find("Stock", { _id: doc._id });
  expect(problems, "the legitimate edit", after.itemName, "MASS item edited");
  expectNot(problems, "costValue after an edit", after.costValue, 987654.32);
  expectClean(problems, "edited item", after);
  // moving the quantity through an edit is an adjustment: the editor holds Edit and not Adjust
  const move = await api("editor", "PUT", `/stock/stock/${doc._id}`, { itemName: "MASS item edited", currentStock: 4242 });
  assert.equal(move.status, 403, `an editor changing the quantity through an edit: ${move.status} ${move.text.slice(0, 200)}`);
  assert.equal((await find("Stock", { _id: doc._id })).currentStock, doc.currentStock, "the quantity did not move");
  assert.deepEqual(problems, []);
});

test("customers, vendors, categories, units, staff: balances, codes and authors are not the client's to set", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const owner = String((await find("Admin", { email: { $regex: /^canary-a-owner-1@/i } }))._id);
  const cust = await api("owner", "POST", "/customers", { customerName: "MASS customer", contactPerson: "x", phone: "0501110000", billingAddress: "x", creditLimit: 10, ...COMMON(), cashBalance: 777777, totalSpent: 888888, totalOrders: 99, customerId: "FORGED-C", joinDate: "2001-01-01T00:00:00.000Z", lastOrder: "2001-01-01T00:00:00.000Z" });
  assert.ok(cust.status < 300, cust.text.slice(0, 300));
  const c = await find("Customer", { customerName: "MASS customer" });
  expectClean(problems, "customer", c);
  expectNot(problems, "customer cashBalance", c.cashBalance, 777777);
  expectNot(problems, "customer totalSpent", c.totalSpent, 888888);
  expectNot(problems, "customer totalOrders", c.totalOrders, 99);
  if (!/^CUST\d{7}$/.test(c.customerId)) problems.push(`customerId: ${c.customerId}`);
  const cu = await api("owner", "PUT", `/customers/${c._id}`, { customerName: "MASS customer edited", ...COMMON(), cashBalance: 777777, totalSpent: 888888, totalOrders: 99, customerId: "FORGED-C" });
  assert.ok(cu.status < 300, cu.text.slice(0, 200));
  const c2 = await find("Customer", { _id: c._id });
  expect(problems, "customer edit", c2.customerName, "MASS customer edited");
  expectClean(problems, "edited customer", c2);
  expect(problems, "customerId after edit", c2.customerId, c.customerId);
  expectNot(problems, "customer cashBalance after edit", c2.cashBalance, 777777);
  expectNot(problems, "customer totalSpent after edit", c2.totalSpent, 888888);

  const vend = await api("owner", "POST", "/vendors/vendors", { vendorName: "MASS vendor", contactPerson: "x", phone: "0501110001", address: "x", ...COMMON(), cashBalance: 777777, vendorId: "FORGED-V", enrollDate: "2001-01-01T00:00:00.000Z" });
  assert.ok(vend.status < 300, vend.text.slice(0, 300));
  const v = await find("Vendor", { vendorName: "MASS vendor" });
  expectClean(problems, "vendor", v);
  expectNot(problems, "vendor cashBalance", v.cashBalance, 777777);
  if (!/^VEND\d{7}$/.test(v.vendorId)) problems.push(`vendorId: ${v.vendorId}`);
  const vu = await api("owner", "PUT", `/vendors/vendors/${v._id}`, { vendorName: "MASS vendor edited", ...COMMON(), cashBalance: 777777, vendorId: "FORGED-V" });
  assert.ok(vu.status < 300, vu.text.slice(0, 200));
  const v2 = await find("Vendor", { _id: v._id });
  expect(problems, "vendor edit", v2.vendorName, "MASS vendor edited");
  expectClean(problems, "edited vendor", v2);
  expectNot(problems, "vendor cashBalance after edit", v2.cashBalance, 777777);

  // who created a record is the signed-in person, never what a body says
  const cat = await api("owner", "POST", "/categories/categories", { name: "MASS category", createdBy: "FORGED-USER", ...COMMON() });
  assert.ok(cat.status < 300, cat.text.slice(0, 300));
  const ct = await find("Category", { name: "MASS category" });
  expectClean(problems, "category", ct);
  const unit = await api("owner", "POST", "/uom/units", { unitName: "MASS unit", shortCode: "MSU", type: "Base", category: "Weight", ...COMMON() });
  assert.ok(unit.status < 300, unit.text.slice(0, 300));
  expectClean(problems, "unit", await find("UOM", { unitName: "MASS unit" }));
  const form = new FormData();
  for (const [k, v1] of Object.entries({ name: "MASS staff", designation: "x", contactNo: "0501234567", idNo: "784000000000077", joiningDate: today(), createdBy: "FORGED-USER", companyId: O, staffId: "FORGED-S", status: "Active", _id: FORGED_ID })) form.append(k, v1);
  const st = await call("POST", "/staff/staff", { token: R.tokens.owner, form });
  assert.ok(st.status < 300, st.text.slice(0, 300));
  const s = await find("Staff", { name: "MASS staff" });
  expectClean(problems, "staff", s);
  expectNot(problems, "staffId", s.staffId, "FORGED-S");
  expect(problems, "staff createdBy is the signed-in person", s.createdBy, owner);
  const exp = await api("owner", "POST", "/expense/categories", { name: "MASS expense category", createdBy: "FORGED-USER", companyId: O });
  if (exp.status < 300) { const e = await find("ExpenseCategory", { name: "MASS expense category" }); expectClean(problems, "expense category", e); }
  assert.deepEqual(problems, [], "masters");
});

// ================================================================================================================ people
test("people: nobody gives themselves a role, a type, permissions, a lock-free state or another organisation through a body", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const owner = String((await find("Admin", { email: { $regex: /^canary-a-owner-1@/i } }))._id);
  const stuff = () => ({ companyId: O, type: "super_admin", roleKey: "super_admin", permissions: ALL_KEYS, mustChangePassword: false, lockUntil: "2099-01-01T00:00:00.000Z", loginAttempts: 99, createdBy: "FORGED-USER", updatedBy: "FORGED-USER", twoFactor: { enabled: true, secretEnc: "FORGED" }, sessionsRevokedAt: "2001-01-01T00:00:00.000Z", _id: FORGED_ID, __v: 77, createdAt: "2001-01-01T00:00:00.000Z", lastLogin: "2001-01-01T00:00:00.000Z" });
  const clean = (label, a, { role = "viewer", fresh = false } = {}) => {
    expectClean(problems, label, a);
    expect(problems, `${label}: type`, a.type, role);
    expect(problems, `${label}: roleKey`, a.roleKey ?? null, null);
    expect(problems, `${label}: twoFactor`, Boolean(a.twoFactor?.enabled), false);
    if (!a.lockUntil || new Date(a.lockUntil).getFullYear() !== 2099) { /* fine */ } else problems.push(`${label}: lockUntil came from the body`);
    expectNot(problems, `${label}: loginAttempts`, a.loginAttempts, 99);
    expect(problems, `${label}: permissions are the type's, not the body's`, (a.permissions || []).length < ALL_KEYS.length, true);
    if (fresh) expect(problems, `${label}: a person an administrator adds must choose their own password`, a.mustChangePassword, true);
  };

  // the users API
  const made = await api("owner", "POST", "/access/users", { name: "MASS person", email: "mass-person@massorg.sec.test", password: H.PASSWORD, role: "viewer", ...stuff(), isActive: false, status: "inactive" });
  assert.equal(made.status, 201, made.text.slice(0, 300));
  const p1 = await find("Admin", { email: "mass-person@massorg.sec.test" });
  clean("POST /access/users", p1, { fresh: true });
  expect(problems, "POST /access/users: status", p1.status, "active");
  expect(problems, "POST /access/users: isActive", p1.isActive, true);
  expect(problems, "POST /access/users: createdBy", String(p1.createdBy), owner);
  const patched = await api("owner", "PATCH", `/access/users/${p1._id}`, { name: "MASS person edited", ...stuff() });
  assert.ok(patched.status < 300, patched.text.slice(0, 300));
  const p1b = await find("Admin", { _id: p1._id });
  expect(problems, "PATCH /access/users: the legitimate edit", p1b.name, "MASS person edited");
  clean("PATCH /access/users", p1b);
  expect(problems, "PATCH /access/users: createdBy", String(p1b.createdBy), owner);

  // the older account routes
  // (an owner may make another owner, so the legacy routes are stuffed without a type here; the next lines prove an administrator cannot)
  const legacyStuff = () => { const { type: _t, ...rest } = stuff(); return rest; };
  const legacy = await api("owner", "POST", "/", { name: "MASS legacy", email: "mass-legacy@massorg.sec.test", password: H.PASSWORD, type: "viewer", ...legacyStuff() });
  assert.equal(legacy.status, 201, legacy.text.slice(0, 300));
  const p2 = await find("Admin", { email: "mass-legacy@massorg.sec.test" });
  clean("POST /", p2, { fresh: true });
  expect(problems, "POST /: createdBy", String(p2.createdBy), owner);
  const legacyEdit = await api("owner", "PUT", `/${p2._id}`, { name: "MASS legacy edited", ...legacyStuff() });
  assert.ok(legacyEdit.status < 300, legacyEdit.text.slice(0, 300));
  const p2b = await find("Admin", { _id: p2._id });
  expect(problems, "PUT /:id: the legitimate edit", p2b.name, "MASS legacy edited");
  clean("PUT /:id", p2b);

  // a person's own profile: the name, and nothing else
  const meBefore = await find("Admin", { email: { $regex: /^canary-a-viewer-1@/i } });
  const me = await api("viewer", "PUT", "/profile/me", { name: "MASS me", email: "hijack@massorg.sec.test", password: "brand-new-pass-1", status: "inactive", isActive: false, branchId: R.extra.branchCode, mustChangePassword: false, ...stuff() });
  assert.ok(me.status < 300, me.text.slice(0, 300));
  const meAfter = await find("Admin", { _id: meBefore._id });
  expect(problems, "PUT /profile/me: the legitimate edit", meAfter.name, "MASS me");
  clean("PUT /profile/me", meAfter);
  for (const f of ["email", "status", "isActive", "branchId", "password", "mustChangePassword", "type"]) expect(problems, `PUT /profile/me: ${f}`, meAfter[f], meBefore[f]);
  assert.equal((await call("POST", "/login", { body: { email: meBefore.email, password: "brand-new-pass-1" } })).status >= 400, true, "the new password was not applied");
  assert.equal((await call("POST", "/login", { body: { email: meBefore.email, password: H.PASSWORD } })).status, 200, "the old password still works");
  assert.deepEqual(problems, [], "people");
});

test("roles and branches: a body cannot make a role built-in, rank it above its author or move it to another organisation, or make a second head office", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const made = await api("owner", "POST", "/access/roles", { key: "mass_role", name: "MASS role", rank: 30, permissions: ["sales.view"], companyId: O, builtIn: true, createdBy: "FORGED-USER", _id: FORGED_ID, __v: 77, isSystem: true });
  assert.equal(made.status, 201, made.text.slice(0, 300));
  const role = await find("Role", { key: "mass_role" });
  expectClean(problems, "created role", role);
  const edit = await api("owner", "PATCH", "/access/roles/mass_role", { name: "MASS role edited", key: "super_admin", rank: 30, companyId: O, createdBy: "FORGED-USER", builtIn: true });
  assert.ok(edit.status < 300, edit.text.slice(0, 300));
  const role2 = await find("Role", { key: "mass_role" });
  expect(problems, "role edit", role2.name, "MASS role edited");
  expectClean(problems, "edited role", role2);
  assert.equal(await find("Role", { key: "super_admin" }), null, "no role was created or renamed to a built-in key");
  const high = await api("owner", "PATCH", "/access/roles/mass_role", { rank: 100 });
  assert.ok(high.status >= 400, "a custom role cannot be given the owner's rank");
  expect(problems, "role rank", (await find("Role", { key: "mass_role" })).rank, 30);

  const br = await api("owner", "POST", "/branches", { code: "mzb", name: "MASS branch", isHeadOffice: true, companyId: O, createdBy: "FORGED-USER", _id: FORGED_ID });
  assert.ok(br.status < 300, br.text.slice(0, 300));
  const b = await find("Branch", { code: "mzb" });
  expectClean(problems, "branch", b);
  expect(problems, "branch isHeadOffice", b.isHeadOffice, false);
  expect(problems, "exactly one head office", await stack.raw(() => mongoose.model("Branch").countDocuments({ companyId: C, isHeadOffice: true })), 1);
  await api("owner", "PATCH", "/branches/mzb", { isHeadOffice: true, name: "MASS branch edited", companyId: O });
  expect(problems, "exactly one head office after an edit", await stack.raw(() => mongoose.model("Branch").countDocuments({ companyId: C, isHeadOffice: true })), 1);
  expectClean(problems, "branch after an edit", await find("Branch", { code: "mzb" }));
  assert.deepEqual(problems, [], "roles and branches");
});

// ================================================================================================================ organisation level
test("organisation settings and the company profile: the plan, features, limits, subscription, currency and secrets are not set by a body", { skip, timeout: 600000 }, async () => {
  const problems = [];
  const orgBefore = await stack.raw(() => mongoose.model("Organisation").findOne({ code: C }).lean());
  const settingsBefore = await stack.raw(() => mongoose.model("CompanySettings").findOne({ companyId: C }).lean());
  const orgFields = { planCode: "internal", featureOverrides: { multiBranch: true, einvoicing: true }, limitOverrides: { users: null, branches: null, documentsPerMonth: null }, subscription: { endsAt: "2099-12-31T00:00:00.000Z", graceDays: 9999, onExpiry: "readonly" }, status: "active", code: "hacked", baseCurrency: "USD", country: "US", timezone: "America/New_York", legalName: "FORGED LLC", provisioning: { complete: false } };
  const stuffed = { ...orgFields, companyId: O, ledgerPostingTouched: false, ledgerPostingEnabled: false, accountConfiguration: [], openingBalancesPostedAt: null, openingBalanceDate: "2001-01-01T00:00:00.000Z", _id: FORGED_ID, __v: 77 };

  const r1 = await api("owner", "PUT", "/accounting/settings", { profile: { legalName: "MASS legal" }, ...stuffed });
  log(`PUT /accounting/settings answered ${r1.status}`);
  const r2 = await api("owner", "PUT", "/company/profile", { companyInfo: { companyName: "MASS company" }, ...stuffed });
  log(`PUT /company/profile answered ${r2.status}`);
  const r3 = await api("owner", "PUT", "/messaging/settings", { provider: "console", fromName: "MASS sender", apiKeyEnc: "FORGED", smtpPassEnc: "FORGED", lastAuthFailureAt: "2001-01-01T00:00:00.000Z", ...stuffed });
  log(`PUT /messaging/settings answered ${r3.status}`);
  const r4 = await api("owner", "PUT", "/einvoice/settings", { participantId: "0235:100777111200003", webhookSecretEnc: "FORGED", ...stuffed });
  log(`PUT /einvoice/settings answered ${r4.status}`);
  const r5 = await api("owner", "PUT", "/auth/security-policy", { requireTwoFactor: false, ...stuffed });
  log(`PUT /auth/security-policy answered ${r5.status}`);
  const r6 = await apiRaw("owner", "PUT", "/accounting/settings", { profile: { legalName: "MASS legal 2" } });
  log(`PUT /accounting/settings (hostile) answered ${r6.status}`);

  const orgAfter = await stack.raw(() => mongoose.model("Organisation").findOne({ code: C }).lean());
  const strip = (o) => { const { updatedAt, ...rest } = o; return rest; };
  expect(problems, "the Organisation row (plan, features, limits, subscription, status, currency) is untouched", strip(orgAfter), strip(orgBefore));
  const settingsAfter = await stack.raw(() => mongoose.model("CompanySettings").findOne({ companyId: C }).lean());
  expectClean(problems, "settings", settingsAfter);
  for (const f of ["ledgerPostingEnabled", "baseCurrency", "openingBalanceDate", "openingBalancesPostedAt", "ledgerPostingTouched"]) expect(problems, `CompanySettings.${f}`, settingsAfter[f] ?? null, settingsBefore[f] ?? null);
  expect(problems, "the posting map", (settingsAfter.accountConfiguration || []).length, (settingsBefore.accountConfiguration || []).length);
  const msg = await stack.raw(() => mongoose.model("MessagingSettings").findOne({ companyId: C }).select("+apiKeyEnc +smtpPassEnc").lean());
  expectNot(problems, "messaging apiKeyEnc", msg.apiKeyEnc, "FORGED");
  expectNot(problems, "messaging smtpPassEnc", msg.smtpPassEnc, "FORGED");
  expectClean(problems, "messaging settings", { ...msg, apiKeyEnc: undefined, smtpPassEnc: undefined });
  const ein = await stack.raw(() => mongoose.model("EInvoiceSettings").findOne({ companyId: C }).select("+webhookSecretEnc").lean());
  expectNot(problems, "e-invoice webhookSecretEnc", ein.webhookSecretEnc, "FORGED");
  // nothing was written into the other organisation by naming it
  const otherOrg = await stack.raw(() => mongoose.model("Organisation").findOne({ code: O }).lean());
  expect(problems, "the other organisation's plan", otherOrg.planCode, "premium");
  const strayRows = await stack.raw(async () => {
    let n = 0;
    for (const name of mongoose.modelNames()) { const M = mongoose.model(name); if (!M.schema.path("companyId")) continue; n += await M.countDocuments({ companyId: O }); }
    return n;
  });
  log(`the other organisation holds ${strayRows} rows (its own provisioning only)`);
  const forgedOrg = await stack.raw(() => mongoose.model("Organisation").countDocuments({ code: "hacked" }));
  expect(problems, "no organisation named 'hacked'", forgedOrg, 0);
  assert.deepEqual(problems, [], "organisation settings");
});

test("quotations, delivery notes, accounts, tax codes, currencies and fiscal years: state, numbers and system flags are the server's", { skip, timeout: 900000 }, async () => {
  const problems = [];
  const owner = String((await find("Admin", { email: { $regex: /^canary-a-owner-1@/i } }))._id);
  const qStuff = () => ({ ...COMMON(), quotationNo: "FORGED-QT-1", revision: 9, revisionOf: FORGED_ID, supersededBy: FORGED_ID, convertedTo: { id: FORGED_ID }, convertedAt: "2001-01-01T00:00:00.000Z", sentAt: "2001-01-01T00:00:00.000Z", acceptedAt: "2001-01-01T00:00:00.000Z", acceptedBy: "FORGED", status: "ACCEPTED", branchId: R.extra.branchCode, pricing: { grandTotal: 1 }, totalAmount: 1 });
  const q = await api("owner", "POST", "/quotations", { partyId: R.ids.customer[0], notes: "MASS-quote", items: [{ itemId: R.ids.stock[0], qty: 2, price: 100, vatPercent: 5 }], ...qStuff() });
  assert.ok(q.status < 300, q.text.slice(0, 300));
  const qd = await find("Quotation", { notes: "MASS-quote" });
  expectClean(problems, "quotation", qd);
  expect(problems, "quotation status", qd.status, "DRAFT");
  if (!/^QT-\d{4}-\d{4}$/.test(qd.quotationNo)) problems.push(`quotationNo: ${qd.quotationNo}`);
  expect(problems, "quotation revision", qd.revision, 0);
  expect(problems, "quotation totalAmount", qd.totalAmount, 210);
  expect(problems, "quotation branchId", qd.branchId, "main");
  expect(problems, "quotation createdBy", String(qd.createdBy), owner);
  for (const f of ["convertedTo", "convertedAt", "sentAt", "acceptedAt", "acceptedBy", "supersededBy", "revisionOf"]) expect(problems, `quotation ${f}`, qd[f] || null, null);
  const qe = await api("owner", "PUT", `/quotations/${qd._id}`, { notes: "MASS-quote edited", ...qStuff() });
  assert.ok(qe.status < 300, qe.text.slice(0, 300));
  const qd2 = await find("Quotation", { _id: qd._id });
  expect(problems, "quotation edit", qd2.notes, "MASS-quote edited");
  expectClean(problems, "edited quotation", qd2);
  for (const f of ["status", "quotationNo", "revision", "totalAmount", "branchId", "createdBy"]) expect(problems, `quotation ${f} after edit`, qd2[f], qd[f]);

  // an account: its balance is the ledger's
  const acc = await api("owner", "POST", "/accounting/accounts", { accountName: "MASS account", groupId: R.ids.accountGroup[0], ...COMMON(), currentBalance: 123456.78, isSystemAccount: true, level: 9, allowDirectPosting: false });
  assert.ok(acc.status < 300, acc.text.slice(0, 300));
  const ad = await find("LedgerAccount", { accountName: "MASS account" });
  expectClean(problems, "ledger account", ad);
  expect(problems, "account currentBalance", ad.currentBalance, 0);
  expect(problems, "account isSystemAccount", ad.isSystemAccount ?? false, false);
  const accEdit = await api("owner", "PUT", `/accounting/accounts/${ad._id}`, { accountName: "MASS account edited", currentBalance: 123456.78, isSystemAccount: true, ...COMMON() });
  assert.ok(accEdit.status < 300, accEdit.text.slice(0, 200));
  const ad2 = await find("LedgerAccount", { _id: ad._id });
  expect(problems, "account edit", ad2.accountName, "MASS account edited");
  expect(problems, "account currentBalance after edit", ad2.currentBalance, 0);
  expect(problems, "account isSystemAccount after edit", ad2.isSystemAccount ?? false, false);
  expectClean(problems, "edited account", ad2);

  // a currency cannot make itself the base
  const cur = await api("owner", "POST", "/currencies", { code: "GBP", name: "MASS pound", symbol: "L", rate: 4.6, isBase: true, ...COMMON() });
  log(`POST /currencies answered ${cur.status}`);
  expect(problems, "exactly one base currency", await stack.raw(() => mongoose.model("Currency").countDocuments({ companyId: C, isBase: true })), 1);
  expectClean(problems, "currency", (await find("Currency", { code: "GBP" })) || { companyId: C });

  // a fiscal year is created open
  const y = new Date().getFullYear() + 3;
  const fy = await api("owner", "POST", "/accounting/fiscal-years", { code: `MASS${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31`, status: "closed", closedAt: "2001-01-01T00:00:00.000Z", closedBy: "FORGED", lockedThrough: "2099-12-31T00:00:00.000Z", monthCloses: [{ month: 1, closedBy: "FORGED" }], closing: { done: true }, ...COMMON() });
  log(`POST /accounting/fiscal-years answered ${fy.status}`);
  const fd = await find("FiscalYear", { code: `MASS${y}` });
  if (fd) {
    expectClean(problems, "fiscal year", fd);
    expect(problems, "fiscal year status", fd.status, "open");
    expect(problems, "fiscal year closedAt", fd.closedAt ?? null, null);
    expect(problems, "fiscal year lockedThrough", fd.lockedThrough ?? null, null);
    expect(problems, "fiscal year monthCloses", fd.monthCloses || [], []);
  }
  const tax = await api("owner", "POST", "/accounting/tax-codes", { name: "MASS tax", kind: "standard", ratePercent: 5, isDefault: true, ...COMMON() });
  if (tax.status < 300) {
    expectClean(problems, "tax code", await find("TaxCode", { name: "MASS tax" }));
    expect(problems, "exactly one default standard tax code", await stack.raw(() => mongoose.model("TaxCode").countDocuments({ companyId: C, kind: "standard", isDefault: true })) <= 1, true);
  }
  assert.deepEqual(problems, [], "documents and accounts");
});

// ================================================================================================================ prototype pollution
test("an administrator cannot make an owner or an administrator through the older account routes, whatever the body says", { skip, timeout: 300000 }, async () => {
  const problems = [];
  for (const type of ["super_admin", "admin"]) {
    const made = await api("admin", "POST", "/", { name: "MASS promoted", email: `mass-promoted-${type}@massorg.sec.test`, password: H.PASSWORD, type });
    expect(problems, `POST / as an administrator with type ${type}`, made.status, 403);
    expect(problems, `no ${type} was created`, await find("Admin", { email: `mass-promoted-${type}@massorg.sec.test` }), null);
  }
  const target = await find("Admin", { email: { $regex: /^canary-a-viewer-1@/i } });
  for (const patch of [{ type: "super_admin" }, { type: "admin" }, { type: "super_admin", roleKey: "super_admin", permissions: ALL_KEYS }]) {
    const r = await api("admin", "PUT", `/${target._id}`, { name: "MASS promoted", ...patch });
    expect(problems, `PUT /:id as an administrator with ${JSON.stringify(Object.keys(patch))}`, r.status, 403);
  }
  const after = await find("Admin", { _id: target._id });
  expect(problems, "the person's type", after.type, target.type);
  expect(problems, "the person's role key", after.roleKey ?? null, target.roleKey ?? null);
  // nor through the users API
  const viaApi = await api("admin", "POST", "/access/users", { name: "MASS promoted", email: "mass-promoted-api@massorg.sec.test", password: H.PASSWORD, role: "super_admin" });
  expect(problems, "POST /access/users as an administrator naming the owner role", viaApi.status, 403);
  assert.deepEqual(problems, []);
});

test("a body cannot switch off the plan's monthly document limit by calling itself an opening balance", { skip, timeout: 300000 }, async () => {
  const problems = [];
  const startOf = await stack.raw(() => mongoose.model("Transaction").countDocuments({ companyId: C, isOpening: { $ne: true } }));
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const thisMonth = await stack.raw(() => mongoose.model("Transaction").countDocuments({ companyId: C, isOpening: { $ne: true }, createdAt: { $gte: month } }));
  await stack.raw(() => mongoose.model("Organisation").updateOne({ code: C }, { $set: { "limitOverrides.documentsPerMonth": thisMonth } }));
  const body = (extra = {}) => ({ type: "sales_order", partyId: R.ids.customer[0], partyType: "Customer", partyTypeRef: "Customer", notes: "MASS-limit", items: [{ itemId: R.ids.stock[0], description: "x", qty: 1, price: 1, rate: 1, vatPercent: 5 }], ...extra });
  try {
    const plain = await api("owner", "POST", "/transactions/transactions", body());
    expect(problems, "the limit is reached, so a plain document is refused", [plain.status, plain.code], [403, "LIMIT_REACHED"]);
    for (const extra of [{ isOpening: true }, { isOpening: "true" }, { isOpening: 1 }]) {
      const sneaky = await api("owner", "POST", "/transactions/transactions", body(extra));
      expect(problems, `${JSON.stringify(extra)} does not get past the limit`, [sneaky.status, sneaky.code], [403, "LIMIT_REACHED"]);
    }
    expect(problems, "no document was made", await find("Transaction", { notes: "MASS-limit" }), null);
  } finally {
    await stack.raw(() => mongoose.model("Organisation").updateOne({ code: C }, { $unset: { "limitOverrides.documentsPerMonth": 1 } }));
  }
  assert.ok(startOf >= 0);
  assert.deepEqual(problems, []);
});

test("a body shaped like {__proto__: ...}, {constructor: {prototype: ...}} or {$set: ...} is sent to EVERY changing route: the server's prototypes stay clean and nothing crashes", { skip, timeout: 1500000 }, async () => {
  R.dbIds = await ownedIds(stack, C);
  const routes = inventory().filter((r) => r.identity === "organisation" && r.gate !== "public" && MUTATING.has(r.method) && r.method !== "DELETE" && r.gate !== "signedIn");
  assert.ok(routes.length >= 100, `only ${routes.length} changing routes`);
  const strings = { key: "mass_role", code: "mzb", branch: "mzb", type: "receipt", month: "1", customerId: R.extra.customerCode, org: C, token: "x.y" };
  // (a person the sweep may do anything to: never the owner whose token it is using)
  const victim = String((await find("Admin", { email: { $regex: /^canary-a-viewer-1@/i } }))._id);
  const idFor = (route, name) => strings[name] || ((modelsFor(route) || [])[0] === "Admin" ? victim : (modelsFor(route) || ["Customer"]).map((m) => R.dbIds[m]?.[0]).find(Boolean)) || FORGED_ID;
  const body = () => hostile({ name: "MASS pollution", notes: "MASS pollution", items: [{ itemId: R.ids.stock[0], qty: 1, price: 1 }], profile: { legalName: "MASS" }, companyInfo: { companyName: "MASS" } });
  // Requests that touch the SAME record go one after another (two at once on one quotation is a write conflict of the test's own making);
  // different records go side by side.
  const urlOf = (r) => r.path.slice("/api/v1".length).replace(/:([A-Za-z0-9_]+)/g, (_, n) => encodeURIComponent(idFor(r, n))) || "/";
  const groups = new Map();
  for (const r of routes) {
    const url = urlOf(r);
    const key = (url.match(/[0-9a-f]{24}/i) || [url.split("/").slice(0, 3).join("/")])[0];
    (groups.get(key) || groups.set(key, []).get(key)).push({ r, url });
  }
  const results = (await H.pool([...groups.values()], 10, async (group) => {
    const done = [];
    for (const { r, url } of group) {
      const res = await call(r.method, url, { token: R.tokens.owner, raw: body(), headers: { "Content-Type": "application/json" } });
      done.push({ r, url, res });
    }
    return done;
  })).flat();
  const crashed = results.filter(({ res }) => res.status >= 500 || res.status === 0).map(({ r, url, res }) => `${r.method} ${url} -> ${res.status} ${res.text.slice(0, 100)}`);
  log(`pollution sweep: ${results.length} routes, statuses ${JSON.stringify(results.reduce((m, { res }) => ((m[res.status] = (m[res.status] || 0) + 1), m), {}))}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const probe = stack.probeLines();
  assert.ok(probe.some((l) => l.includes("armed")), `the in-server probe was armed: ${probe.join(" | ")}`);
  assert.deepEqual(probe.filter((l) => l.includes("POLLUTED")), [], "something was added to a built-in prototype inside the server");
  assert.deepEqual(crashed, [], "a hostile body crashed a route");
  // nothing hostile reached any stored record
  const hits = await stack.raw(async () => {
    const found = [];
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (!M.schema.path("companyId")) continue;
      for (const d of await M.find({ companyId: C }).lean()) if (/polluted|"FORGED"|\$set|\$unset/.test(JSON.stringify(d).replace(/FORGED-?[A-Z0-9-]*/g, "FORGED"))) found.push(`${name} ${d._id}`);
    }
    return found;
  });
  assert.deepEqual(hits.filter((h) => !/ActivityLog/.test(h)), [], "a hostile key was stored");
  const alive = await call("GET", "/customers/customers", { token: R.tokens.owner });
  assert.equal(alive.status, 200, "and the server still works");
  assert.ok(!stack.exited(), "and has not crashed");
});

test("the in-server probe really can see pollution: a canary object added to Object.prototype in another process is reported", { skip: skip || false, timeout: 60000 }, async () => {
  // run the probe in a throwaway child process, arm it, then pollute: it must report. (Proves the 'POLLUTED' lines above would appear.)
  const { spawnSync } = require("child_process");
  const path = require("path");
  const fs = require("fs");
  const arm = path.join(require("os").tmpdir(), `probe-selftest-${Date.now()}`);
  const code = `fs.writeFileSync(${JSON.stringify(arm)}, "1"); setTimeout(() => { Object.prototype.polluted = "yes"; setTimeout(() => process.exit(0), 300); }, 300);`;
  const out = spawnSync(process.execPath, ["--require", path.join(__dirname, "support", "pollutionProbe.js"), "-e", `const fs = require("fs"); ${code}`], { env: { ...process.env, PROBE_ARM_FILE: arm }, encoding: "utf8", timeout: 20000 });
  try { fs.unlinkSync(arm); } catch (_) { /* gone */ }
  assert.match(out.stdout, /armed/);
  assert.match(out.stdout, /POLLUTED Object\.prototype: polluted/);
});
