// Linked returns, ageing, credit control, statement of account and the audit log, against a
// throwaway database (random name, dropped afterwards).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Returns: require("../orderPurchase/returnService"),
    Ageing: require("../financial/ageingService"),
    Credit: require("../financial/creditControlService"),
    Statement: require("../financial/statementService"),
    Audit: require("../core/auditService"),
    Financial: require("../financial/financialService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- pure rule ----
test("credit rule: limit and overdue breaches, and no breach when within limits", () => {
  const { evaluate } = require("../financial/creditControlService");
  // customer already owes 800 (balance -800), limit 1000, new order 300 -> 1100 > 1000
  const b = evaluate({ creditLimit: 1000, balance: -800, orderTotal: 300 });
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, "credit_limit");
  assert.equal(b[0].projected, 1100);
  assert.deepEqual(evaluate({ creditLimit: 1000, balance: -800, orderTotal: 200 }), []); // exactly at the limit
  assert.deepEqual(evaluate({ creditLimit: 0, balance: -99999, orderTotal: 500 }), [], "limit 0 means unlimited");
  assert.deepEqual(evaluate({ creditLimit: 1000, balance: 50, orderTotal: 900 }), [], "a customer in credit");

  const late = evaluate({
    creditLimit: 0, balance: 0, orderTotal: 10, overdueBlockDays: 30,
    overdueInvoices: [{ transactionNo: "SO-1", daysPastDue: 45, outstanding: 100 }, { transactionNo: "SO-2", daysPastDue: 10, outstanding: 50 }],
  });
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, "overdue");
  assert.equal(late[0].invoices.length, 1);
});

test("terms to days", () => {
  const { termDays } = require("../financial/ageingService");
  assert.equal(termDays("Net 30"), 30);
  assert.equal(termDays("45 days"), 45);
  assert.equal(termDays("COD"), 0);
  assert.equal(termDays("Cash on Delivery"), 0);
  assert.equal(termDays(undefined), 0);
});

// ---- shared fixtures ----
let vendor, customer, stock;
const day = (n) => new Date(Date.now() - n * 86400000);
const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });
const make = async (type, party, partyType, items, extra = {}) => {
  const t = await svc.Tx.createTransaction(
    { type, partyId: party._id, partyType, partyTypeRef: partyType, items, date: extra.date, returnOf: extra.returnOf }, "tester");
  if (extra.approve !== false) await svc.Tx.processTransaction(t._id, "approve", "tester", extra.options || {});
  return t;
};

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 2000 });
  stock = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  await make("purchase_order", vendor, "Vendor", [line(200, 10)]);
});

// ---- returns ----
test("returns: against an approved sale, partial returns accumulate and over-return is refused", { skip }, async () => {
  const sale = await make("sales_order", customer, "Customer", [line(10, 20)]);
  const lineId = sale.items[0]._id;

  const info = await svc.Returns.returnable(sale._id);
  assert.equal(info.lines[0].remainingQty, 10);

  const r1 = await make("sales_return", customer, "Customer", [line(4, 20, { returnOfLineId: lineId })], { returnOf: { transactionId: sale._id } });
  assert.equal(r1.returnOf.transactionNo, sale.transactionNo);
  assert.equal((await svc.Returns.returnable(sale._id)).lines[0].remainingQty, 6);

  // a 7-unit return would take the total to 11 of 10
  await assert.rejects(
    () => make("sales_return", customer, "Customer", [line(7, 20, { returnOfLineId: lineId })], { returnOf: { transactionId: sale._id }, approve: false }),
    { code: "OVER_RETURN" }
  );
  // the remaining 6 is fine
  const r2 = await make("sales_return", customer, "Customer", [line(6, 20, { returnOfLineId: lineId })], { returnOf: { transactionId: sale._id }, approve: false });
  assert.equal((await svc.Returns.returnable(sale._id)).lines[0].remainingQty, 0);

  // deleting a return frees its quantity (returned quantity is derived, never incremented)
  await svc.Tx.deleteTransaction(r2._id, "tester");
  assert.equal((await svc.Returns.returnable(sale._id)).lines[0].remainingQty, 6);

  // the value may not exceed what was invoiced either
  await assert.rejects(
    () => make("sales_return", customer, "Customer", [line(5, 99, { returnOfLineId: lineId })], { returnOf: { transactionId: sale._id }, approve: false }),
    { code: "OVER_RETURN_VALUE" }
  );
});

test("returns: wrong party, wrong type, unapproved original, unknown line", { skip }, async () => {
  const other = await svc.Customer.create({ customerId: "C9", customerName: "Other", contactPerson: "x" });
  const sale = await make("sales_order", customer, "Customer", [line(5, 20)]);
  const draft = await make("sales_order", customer, "Customer", [line(5, 20)], { approve: false });
  const ret = (original, party = customer, extra = {}) =>
    make("sales_return", party, "Customer", [line(1, 20, extra)], { returnOf: { transactionId: original._id }, approve: false });

  await assert.rejects(() => ret(sale, other), { code: "PARTY_MISMATCH" });
  await assert.rejects(() => ret(draft), { code: "ORIGINAL_NOT_APPROVED" });
  await assert.rejects(() => ret(sale, customer, { returnOfLineId: new mongoose.Types.ObjectId() }), { code: "LINE_NOT_IN_ORIGINAL" });
  await assert.rejects(
    () => make("purchase_return", vendor, "Vendor", [line(1, 10)], { returnOf: { transactionId: sale._id }, approve: false }),
    { code: "WRONG_ORIGINAL_TYPE" }
  );
  // with no explicit line, a single matching original line is accepted
  const ok = await ret(sale);
  assert.equal(String(ok.items[0].returnOfLineId), String(sale.items[0]._id));
});

test("returns: a linked sales return restores stock at the cost the goods were SOLD at", { skip }, async () => {
  // buy more at a different price so the average moves between the sale and the return
  const sale = await make("sales_order", customer, "Customer", [line(10, 50)]);
  const soldCost = (await svc.Movement.findOne({ referenceId: sale._id, isReversed: false })).totalValue;
  await make("purchase_order", vendor, "Vendor", [line(100, 30)]); // moves the average well above 10
  const avgNow = (await svc.Stock.findById(stock._id)).purchasePrice;
  assert.ok(avgNow > 10);

  const ret = await make("sales_return", customer, "Customer", [line(10, 50, { returnOfLineId: sale.items[0]._id })], { returnOf: { transactionId: sale._id } });
  const mv = await svc.Movement.findOne({ referenceId: ret._id, isReversed: false });
  assert.equal(mv.costBasis, "salesReturn");
  assert.equal(mv.totalValue, soldCost, "restored at the original sale cost, not today's average");
});

test("returns: the window and the 'link required' setting are enforced", { skip }, async () => {
  const sale = await make("sales_order", customer, "Customer", [line(5, 20)], { date: day(40) });
  await svc.Config.updateSettings({ returnWindowDays: 30 });
  await assert.rejects(
    () => make("sales_return", customer, "Customer", [line(1, 20)], { returnOf: { transactionId: sale._id }, approve: false }),
    { code: "RETURN_WINDOW_EXPIRED" }
  );
  await svc.Config.updateSettings({ returnWindowDays: 0, requireReturnLink: true });
  await assert.rejects(() => make("sales_return", customer, "Customer", [line(1, 20)], { approve: false }), { code: "RETURN_LINK_REQUIRED" });
  await svc.Config.updateSettings({ requireReturnLink: false });
});

// ---- ageing ----
test("ageing: invoices fall into buckets by due date and the buckets sum to the total", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C5", customerName: "Aged", contactPerson: "x", paymentTerms: "Net 30" });
  await make("sales_order", c, "Customer", [line(1, 100, { vatPercent: 0 })], { date: day(10) }); // due in 20 days -> current
  await make("sales_order", c, "Customer", [line(1, 200, { vatPercent: 0 })], { date: day(45) }); // 15 days late
  await make("sales_order", c, "Customer", [line(1, 300, { vatPercent: 0 })], { date: day(80) }); // 50 days late
  await make("sales_order", c, "Customer", [line(1, 400, { vatPercent: 0 })], { date: day(150) }); // 120 days late

  const r = await svc.Ageing.report({ type: "receivable" });
  const row = r.rows.find((x) => x.partyName === "Aged");
  assert.deepEqual(
    [row.buckets.current, row.buckets.d1_30, row.buckets.d31_60, row.buckets.d61_90, row.buckets.d90plus],
    [100, 200, 300, 0, 400]
  );
  assert.equal(row.total, 1000);
  const sum = Object.entries(row.buckets).reduce((t, [, v]) => t + v, 0);
  assert.equal(sum, row.total);
  assert.equal(r.totals.total, r.rows.reduce((t, x) => t + x.total, 0));
  assert.equal(r.overdue, r.totals.total - r.totals.current);

  const payable = await svc.Ageing.report({ type: "payable" });
  assert.ok(payable.rows.some((x) => x.partyName === "Vend"));
});

// ---- credit control ----
test("credit control: off passes, warn needs an acknowledgement, block refuses, returns are never gated", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C6", customerName: "Limited", contactPerson: "x", creditLimit: 500 });
  const over = () => make("sales_order", c, "Customer", [line(10, 100, { vatPercent: 0 })], { approve: false }); // 1000 > 500

  // off (default): approves
  const a = await over();
  await svc.Tx.processTransaction(a._id, "approve", "tester");

  // the customer now owes 1000. warn mode:
  await svc.Config.updateSettings({ creditControl: { mode: "warn" } });
  const b = await over();
  await assert.rejects(() => svc.Tx.processTransaction(b._id, "approve", "tester"), (e) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED");
    assert.equal(e.details.risk.acknowledgementField, "riskAck_limit_party_credit");
    return true;
  });
  assert.equal((await svc.Transaction.findById(b._id)).status, "DRAFT", "a refused approval leaves the document untouched");
  await svc.Tx.processTransaction(b._id, "approve", "tester", { acknowledged: true });
  assert.equal((await svc.Transaction.findById(b._id)).status, "APPROVED");

  // block mode: no override
  await svc.Config.updateSettings({ creditControl: { mode: "block" } });
  const d = await over();
  await assert.rejects(() => svc.Tx.processTransaction(d._id, "approve", "tester", { acknowledged: true }), { statusCode: 403, code: "RISK_LIMIT_BLOCKED" });

  // a return reduces exposure, so it is never blocked
  const ret = await make("sales_return", c, "Customer", [line(1, 100, { vatPercent: 0 })], { approve: false });
  await svc.Tx.processTransaction(ret._id, "approve", "tester");
  await svc.Config.updateSettings({ creditControl: { mode: "off" } });

  // both outcomes were audited
  const log = await svc.Audit.list(undefined, { entity: "Transaction" });
  const actions = log.rows.map((r) => r.action);
  assert.ok(actions.includes("CREDIT_WARNING_ACKNOWLEDGED"));
  assert.ok(actions.includes("CREDIT_BLOCKED"));
});

test("credit control: an overdue invoice blocks even when the limit has room", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C7", customerName: "Slow", contactPerson: "x", creditLimit: 100000, paymentTerms: "Net 30" });
  await make("sales_order", c, "Customer", [line(1, 100, { vatPercent: 0 })], { date: day(90) }); // 60 days overdue
  await svc.Config.updateSettings({ creditControl: { mode: "block", overdueBlockDays: 30 } });
  const next = await make("sales_order", c, "Customer", [line(1, 100, { vatPercent: 0 })], { approve: false });
  await assert.rejects(() => svc.Tx.processTransaction(next._id, "approve", "tester"), { code: "RISK_LIMIT_BLOCKED" });
  await svc.Config.updateSettings({ creditControl: { mode: "off", overdueBlockDays: 0 } });
});

// ---- statement ----
test("statement: opening + movement = closing, and closing equals the party ledger balance", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C8", customerName: "Stmt", contactPerson: "x" });
  await make("sales_order", c, "Customer", [line(1, 100, { vatPercent: 5 })], { date: day(40) }); // 105
  await make("sales_order", c, "Customer", [line(2, 100, { vatPercent: 5 })], { date: day(10) }); // 210

  const all = await svc.Statement.getStatement({ partyId: c._id, partyType: "Customer" });
  assert.equal(all.closing, 315);
  assert.equal(all.rows.length, 2);
  assert.equal(all.rows[1].balance, 315);

  const from = day(20);
  const partial = await svc.Statement.getStatement({ partyId: c._id, partyType: "Customer", from });
  assert.equal(partial.opening, 105);
  assert.equal(partial.rows.length, 1);
  assert.equal(partial.closing, 315);
  assert.equal(partial.opening + partial.totals.debit - partial.totals.credit, partial.closing);

  const v = await svc.Statement.getStatement({ partyId: vendor._id, partyType: "Vendor" });
  assert.ok(v.closing > 0, "a vendor balance reads positive when we owe them");
  await assert.rejects(() => svc.Statement.getStatement({ partyId: "nope", partyType: "Customer" }), { statusCode: 400 });
});

test("statement: with ledger posting off it is built from the approved documents, not left empty", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C9X", customerName: "NoPosting", contactPerson: "x" });
  await svc.Config.setPostingEnabled(false);
  try {
    await make("sales_order", c, "Customer", [line(1, 100, { vatPercent: 5 })], { date: day(5) }); // 105
    const draft = await make("sales_order", c, "Customer", [line(9, 100, { vatPercent: 5 })], { approve: false }); // never approved
    await svc.Financial.createVoucher(
      { voucherType: "receipt", customerId: c._id, paymentMode: "cash", totalAmount: 50, date: day(2) },
      new mongoose.Types.ObjectId()
    );
    const st = await svc.Statement.getStatement({ partyId: c._id, partyType: "Customer" });
    assert.equal(st.source, "documents");
    assert.equal(st.rows.length, 2, "the invoice and the receipt; the draft is not on the statement");
    assert.equal(st.rows[0].voucherType, "sales_order");
    assert.equal(st.totals.debit, 105);
    assert.equal(st.totals.credit, 50);
    assert.equal(st.closing, 55);
    assert.equal(st.rows[1].balance, 55);
    assert.ok(!st.rows.some((r) => String(r._id) === String(draft._id)));

    const from = await svc.Statement.getStatement({ partyId: c._id, partyType: "Customer", from: day(3) });
    assert.equal(from.opening, 105);
    assert.equal(from.rows.length, 1);
    assert.equal(from.closing, 55);
  } finally {
    await svc.Config.setPostingEnabled(true);
  }
  const back = await svc.Statement.getStatement({ partyId: c._id, partyType: "Customer" });
  assert.equal(back.source, "ledger");
});

test("audit log never throws and keeps secrets out", { skip }, async () => {
  await svc.Audit.log({ req: undefined, action: "TEST", entity: "X", entityId: "1", summary: "s", after: { password: "hunter2", nested: { apiKey: "k", ok: 1 } } });
  const { rows } = await svc.Audit.list(undefined, { action: "TEST" });
  assert.equal(rows[0].after.password, "[redacted]");
  assert.equal(rows[0].after.nested.apiKey, "[redacted]");
  assert.equal(rows[0].after.nested.ok, 1);
});
