// Opening balances (go-live): account balances against Opening Balance Equity, customer / vendor open
// invoices, opening stock with batches, the guards that keep those documents out of VAT, e-invoicing,
// returns, catch-up posting and the sales analysis, reversal, the period lock and idempotency.
// Throwaway database, see accountingFoundation.test.js.
//
//   node --test services/__tests__/openingBalances.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const by = { adminId: admin };

// The seeded fiscal year is the current Dubai calendar year, so every date here sits inside it.
const Y = new Date(Date.now() + 4 * 3600e3).getUTCFullYear();
const GO_LIVE = `${Y}-06-30`;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
let alNoor, gulfCo, limited, millsVendor, oldVendor;
let rice, flour, milk, sugar;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    OB: require("../financial/openingBalanceService"),
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Returns: require("../orderPurchase/returnService"),
    Posting: require("../financial/postingService"),
    Ageing: require("../financial/ageingService"),
    Statement: require("../financial/statementService"),
    Credit: require("../financial/creditControlService"),
    Financial: require("../financial/financialService"),
    PartyAccounts: require("../financial/partyAccounts"),
    FiscalYear: require("../core/fiscalYearService"),
    Reports: require("../reports/ledgerReportsService"),
    StockReports: require("../reports/stockReportsService"),
    EI: require("../einvoice/einvoiceService"),
    Inbound: require("../einvoice/inboundService"),
    ...require("../../models/modules/financial/financialModels"),
    VATReport: require("../../models/modules/financial/VATReport"),
    OBVoucher: require("../../models/modules/financial/openingBalanceModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Batch: require("../../models/modules/stockBatchModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    CreditLog: require("../../models/modules/CreditLog"),
    DebitLog: require("../../models/modules/DebitLog"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    NumberSeries: require("../core/numberSeriesService"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault(); // an account must belong to an organisation that exists, as the server arranges at start-up
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
const net = async (accountId, extra = {}) => {
  const [r] = await svc.LedgerEntry.aggregate([
    { $match: { accountId: new mongoose.Types.ObjectId(String(accountId)), isReversed: { $ne: true }, ...extra } },
    { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
  ]);
  return r2((r?.d || 0) - (r?.c || 0));
};
const ledgerCount = () => svc.LedgerEntry.countDocuments({});
const line = (stock, qty, price, extra = {}) => ({ itemId: stock._id, description: stock.itemName, qty, price, rate: price, vatPercent: 0, ...extra });
const trade = async (type, party, partyType, items, extra = {}) => {
  const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, date: extra.date }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
};

// ------------------------------------------------------------------------------------ pure rules

test("account lines: a spare row is ignored; both sides, negatives and repeats are refused", () => {
  const { normaliseAccountLines, equityDifference } = svc ? svc.OB : require("../financial/openingBalanceService");
  const id1 = String(new mongoose.Types.ObjectId());
  const id2 = String(new mongoose.Types.ObjectId());
  assert.deepEqual(normaliseAccountLines([{ accountId: "", debit: "", credit: "" }, { accountId: id1, debit: "10.005" }]), [{ accountId: id1, debit: 10.01, credit: 0 }]);
  assert.throws(() => normaliseAccountLines([{ accountId: id1, debit: 5, credit: 5 }]), { code: "BOTH_SIDES" });
  assert.throws(() => normaliseAccountLines([{ accountId: id1, debit: -5 }]), { code: "NEGATIVE_AMOUNT" });
  assert.throws(() => normaliseAccountLines([{ accountId: id1 }]), { code: "AMOUNT_REQUIRED" });
  assert.throws(() => normaliseAccountLines([{ debit: 5 }]), { code: "ACCOUNT_REQUIRED" });
  assert.throws(() => normaliseAccountLines([{ accountId: id1, debit: 5 }, { accountId: id1, credit: 5 }]), { code: "DUPLICATE_ACCOUNT" });

  // the difference lands on the side that is short
  const d = equityDifference([{ debit: 100, credit: 0 }, { debit: 0, credit: 30 }]);
  assert.deepEqual([d.debit, d.credit, d.amount, d.side], [100, 30, 70, "credit"]);
  assert.equal(equityDifference([{ debit: 10, credit: 0 }, { debit: 0, credit: 25 }]).side, "debit");
  assert.deepEqual(equityDifference([{ debit: 10, credit: 0 }, { debit: 0, credit: 10 }]), { debit: 10, credit: 10, amount: 0, side: null });
  assert.ok(id2);
});

test("party and stock rows are validated before anything is written", () => {
  const { normalisePartyRows, normaliseStockRows, parseDay } = require("../financial/openingBalanceService");
  const day = parseDay("2026-06-30");
  const p = String(new mongoose.Types.ObjectId());
  const ok = normalisePartyRows([{ partyId: p, reference: " INV-1 ", date: "2026-05-01", dueDate: "2026-05-31", amount: "1,000.5" }], day);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].amount, 1000.5);
  assert.equal(ok[0].reference, "INV-1", "the reference is trimmed");
  assert.throws(() => normalisePartyRows([{ partyId: p, amount: 0, reference: "x" }], day), { code: "AMOUNT_REQUIRED" });
  assert.throws(() => normalisePartyRows([{ partyId: p, amount: 5, date: "2026-07-01" }], day), { code: "DATE_AFTER_GO_LIVE" });
  assert.throws(() => normalisePartyRows([{ partyId: p, amount: 5, date: "2026-05-10", dueDate: "2026-05-01" }], day), { code: "INVALID_DUE_DATE" });
  assert.throws(() => normalisePartyRows([{ partyId: "", amount: 5 }], day), { code: "PARTY_REQUIRED" });
  assert.equal(normalisePartyRows([{ partyId: "", reference: "", amount: "" }], day).length, 0, "a blank spare row is skipped");
  assert.equal(normalisePartyRows([{ partyId: p, amount: 5 }], day)[0].date.toISOString().slice(0, 10), "2026-06-30", "no invoice date means the go-live day");

  assert.throws(() => normaliseStockRows([{ itemId: "x", qty: 0, unitCost: 1 }]), { code: "INVALID_QTY" });
  assert.throws(() => normaliseStockRows([{ itemId: "x", qty: 1 }]), { code: "INVALID_COST" });
  assert.throws(() => normaliseStockRows([{ itemId: "x", qty: 1, unitCost: -1 }]), { code: "INVALID_COST" });
  assert.throws(() => normaliseStockRows([{ qty: 1, unitCost: 1 }]), { code: "ITEM_REQUIRED" });
  assert.equal(normaliseStockRows([{ itemId: "x", qty: 2, unitCost: 0 }])[0].unitCost, 0, "a free item is allowed");
  assert.throws(() => parseDay("2026-02-30"), { code: "INVALID_DATE" });
});

test("allocateMany hands out consecutive numbers from one increment", { skip }, async () => {
  const a = await svc.NumberSeries.allocateMany("OSI", 3, new Date(`${GO_LIVE}T00:00:00Z`));
  assert.deepEqual(a, [`OSI-${Y}-0001`, `OSI-${Y}-0002`, `OSI-${Y}-0003`]);
  const next = await svc.NumberSeries.allocate("OSI", new Date(`${GO_LIVE}T00:00:00Z`));
  assert.equal(next, `OSI-${Y}-0004`);
  await svc.NumberSeries.allocateMany("OSI", 0, new Date()); // nothing to allocate
  // keep the counter clean for the real numbers below
  await mongoose.connection.collection("numberseries").deleteMany({ series: "OSI" });
});

// -------------------------------------------------------------------------------------- fixtures

test("setup: parties, items, earlier activity, go-live date and the warning about it", { skip }, async () => {
  alNoor = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30" });
  gulfCo = await svc.Customer.create({ customerId: "C2", customerName: "Gulf Co", contactPerson: "x", paymentTerms: "Net 30" });
  limited = await svc.Customer.create({ customerId: "C3", customerName: "Limited", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 1000 });
  millsVendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y", paymentTerms: "Net 45", trnNO: "100123456700003" });
  oldVendor = await svc.Vendor.create({ vendorId: "V2", vendorName: "Old Vendor", contactPerson: "x", address: "y" });
  const category = new mongoose.Types.ObjectId();
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category });
  flour = await svc.Stock.create({ itemId: "FLOUR", sku: "FLOUR", itemName: "Flour", category, purchasePrice: 1 });
  milk = await svc.Stock.create({ itemId: "MILK", sku: "MILK", itemName: "Milk", category, batchNumber: "M-TEMPLATE", expiryDate: new Date(`${Y + 1}-01-01`) });
  sugar = await svc.Stock.create({ itemId: "SUGAR", sku: "SUGAR", itemName: "Sugar", category });

  // ordinary activity BEFORE the go-live day: 100 sugar at 10
  await trade("purchase_order", oldVendor, "Vendor", [line(sugar, 100, 10)], { date: `${Y}-02-10` });

  const r = await svc.OB.setGoLiveDate(GO_LIVE);
  assert.equal(r.date.toISOString().slice(0, 10), GO_LIVE);
  const w = r.warnings.find((x) => x.code === "TRANSACTIONS_BEFORE_GO_LIVE");
  assert.ok(w, "the earlier purchase is flagged, not blocked");
  assert.ok(w.documents >= 1);
  assert.deepEqual((await svc.OB.goLive()).date, new Date(`${GO_LIVE}T00:00:00Z`));
  await assert.rejects(() => svc.OB.setGoLiveDate("30/06/2026"), { code: "INVALID_DATE" });
});

// -------------------------------------------------------------------------------- 1. accounts

test("accounts: refuses party, inventory and equity accounts", { skip }, async () => {
  const party = await svc.PartyAccounts.ensurePartyAccount("customer", alNoor._id, "Al Noor");
  const inventory = await acct("Inventory Stock");
  const obe = await acct("Opening Balance Equity");
  const cash = await acct("Cash in Hand");
  const before = await ledgerCount();
  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: party._id, debit: 10 }] }, by), { code: "PARTY_ACCOUNT_RESERVED" });
  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: inventory._id, debit: 10 }] }, by), { code: "INVENTORY_ACCOUNT_RESERVED" });
  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: obe._id, credit: 10 }] }, by), { code: "EQUITY_ACCOUNT_RESERVED" });
  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [] }, by), { code: "NO_LINES" });
  await assert.rejects(() => svc.OB.postAccounts({ date: addDays(GO_LIVE, 1), lines: [{ accountId: cash._id, debit: 10 }] }, by), { code: "GO_LIVE_DATE_MISMATCH" });
  assert.equal(await ledgerCount(), before, "a refused submission writes nothing");
});

let accountsVoucher;
test("accounts: one balanced voucher, the difference goes to Opening Balance Equity", { skip }, async () => {
  const [cash, bank, vehicles, loan, capital, obe] = await Promise.all(["Cash in Hand", "Bank Account", "Vehicles", "Bank Loan", "Owner's Capital", "Opening Balance Equity"].map(acct));
  accountsVoucher = await svc.OB.postAccounts({
    date: GO_LIVE,
    lines: [
      { accountId: cash._id, debit: 5000 }, { accountId: bank._id, debit: 20000 }, { accountId: vehicles._id, debit: 30000 },
      { accountId: loan._id, credit: 15000 }, { accountId: capital._id, credit: 10000 },
    ],
  }, by);
  assert.match(accountsVoucher.voucherNo, new RegExp(`^OBV-${Y}-0001$`));
  assert.deepEqual([accountsVoucher.totalDebit, accountsVoucher.totalCredit], [55000, 25000]);
  assert.deepEqual({ amount: accountsVoucher.difference.amount, side: accountsVoucher.difference.side }, { amount: 30000, side: "credit" });

  const entries = await svc.LedgerEntry.find({ voucherId: accountsVoucher._id }).lean();
  assert.equal(entries.length, 6);
  assert.ok(entries.every((e) => e.voucherType === "opening" && new Date(e.date).toISOString().slice(0, 10) === GO_LIVE), "all dated the go-live day");
  assert.equal(r2(entries.reduce((t, e) => t + e.debitAmount, 0)), r2(entries.reduce((t, e) => t + e.creditAmount, 0)), "the voucher balances");
  const eq = entries.find((e) => String(e.accountId) === String(obe._id));
  assert.equal(eq.creditAmount, 30000);

  // account balances follow, with the right sign for each category
  assert.equal((await svc.LedgerAccount.findById(cash._id)).currentBalance, 5000);
  assert.equal((await svc.LedgerAccount.findById(loan._id)).currentBalance, 15000);
  assert.equal((await svc.LedgerAccount.findById(obe._id)).currentBalance, 30000);
  assert.equal(await net(cash._id), 5000);
  assert.equal(await net(loan._id), -15000);

  // shows on the trial balance and the day book
  const gl = await svc.Reports.generalLedger({ from: GO_LIVE, to: GO_LIVE });
  assert.equal(gl.totals.debit, gl.totals.credit);
  const book = await svc.Reports.dayBook({ from: GO_LIVE, to: GO_LIVE, type: "opening" });
  assert.equal(book.rows[0].typeLabel, "Opening balance");
});

test("accounts: entered accounts are listed read-only and no longer offered; a second entry is refused", { skip }, async () => {
  const cash = await acct("Cash in Hand");
  const list = await svc.OB.listAccounts({});
  assert.equal(list.entered.length, 5);
  const row = list.entered.find((e) => e.accountName === "Cash in Hand");
  assert.deepEqual([row.debit, row.credit, row.source], [5000, 0, "opening-balances"]);
  assert.equal(String(row.voucherId), String(accountsVoucher._id));
  const names = list.available.map((a) => a.accountName);
  assert.ok(!names.includes("Cash in Hand") && !names.includes("Bank Loan"), "entered accounts are not offered again");
  assert.ok(!names.includes("Opening Balance Equity") && !names.includes("Inventory Stock"), "equity and inventory are not offered");
  assert.ok(!names.some((n) => /^Customer - /.test(n)), "party accounts are not offered");
  assert.ok(names.includes("Rent Expense") && names.includes("Petty Cash"));
  assert.equal(list.vouchers[0].difference.side, "credit");

  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: cash._id, debit: 1 }] }, by), { code: "ALREADY_HAS_OPENING" });
});

test("accounts: an opening balance set when the account was created counts as entered", { skip }, async () => {
  const Chart = require("../financial/chartOfAccountsService");
  const AccountGroup = require("../../models/modules/financial/accountGroupModel");
  const bankGroup = await AccountGroup.findOne({ name: "Bank" });
  const created = await Chart.createAccount({ accountName: "ENBD Savings", groupId: bankGroup._id, openingBalance: 100, openingSide: "debit", openingDate: GO_LIVE }, {}, admin);
  const list = await svc.OB.listAccounts({});
  const row = list.entered.find((e) => e.accountName === "ENBD Savings");
  assert.ok(row);
  assert.equal(row.source, "account-created");
  assert.equal(row.voucherId, null, "it cannot be reversed from here");
  await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: created._id, debit: 1 }] }, by), { code: "ALREADY_HAS_OPENING" });
});

test("accounts: reversing the whole voucher lets the account be entered again (idempotent correction)", { skip }, async () => {
  const [cash, bank, vehicles, loan, capital, obe] = await Promise.all(["Cash in Hand", "Bank Account", "Vehicles", "Bank Loan", "Owner's Capital", "Opening Balance Equity"].map(acct));
  const rev = await svc.OB.reverseAccounts(accountsVoucher._id, by);
  assert.equal(rev.status, "reversed");
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: accountsVoucher._id, isReversed: { $ne: true } }), 0);
  for (const a of [cash, loan]) assert.equal((await svc.LedgerAccount.findById(a._id)).currentBalance, 0, `${a.accountName} is back to nothing`);
  // only the 100 set when ENBD Savings was created is left in equity
  assert.equal((await svc.LedgerAccount.findById(obe._id)).currentBalance, 100);
  assert.equal(await net(cash._id), 0);
  await assert.rejects(() => svc.OB.reverseAccounts(accountsVoucher._id, by), { code: "ALREADY_REVERSED" });
  assert.equal((await svc.OB.listAccounts({})).entered.some((e) => e.accountName === "Cash in Hand"), false);

  // the corrected figures
  accountsVoucher = await svc.OB.postAccounts({
    date: GO_LIVE,
    lines: [
      { accountId: cash._id, debit: 5500 }, { accountId: bank._id, debit: 20000 }, { accountId: vehicles._id, debit: 30000 },
      { accountId: loan._id, credit: 15000 }, { accountId: capital._id, credit: 10000 },
    ],
  }, by);
  assert.equal(accountsVoucher.voucherNo, `OBV-${Y}-0002`, "numbers are never reused");
  assert.deepEqual({ amount: accountsVoucher.difference.amount, side: accountsVoucher.difference.side }, { amount: 30500, side: "credit" });
  assert.equal(await net(cash._id), 5500);
});

test("period lock: a closed fiscal year refuses every opening post and reversal", { skip }, async () => {
  const fy = await svc.FiscalYear.getForDate(new Date(`${GO_LIVE}T00:00:00Z`));
  const petty = await acct("Petty Cash");
  await svc.FiscalYear.setStatus(fy._id, "closed", admin);
  try {
    const before = await ledgerCount();
    await assert.rejects(() => svc.OB.postAccounts({ date: GO_LIVE, lines: [{ accountId: petty._id, debit: 50 }] }, by), { code: "PERIOD_CLOSED" });
    await assert.rejects(() => svc.OB.postParties({ type: "customer", date: GO_LIVE, rows: [{ partyId: alNoor._id, reference: "LOCK-1", amount: 10 }] }, by), { code: "PERIOD_CLOSED" });
    await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: rice._id, qty: 1, unitCost: 1 }] }, by), { code: "PERIOD_CLOSED" });
    await assert.rejects(() => svc.OB.reverseAccounts(accountsVoucher._id, by), { code: "PERIOD_CLOSED" });
    await assert.rejects(() => svc.OB.setGoLiveDate(GO_LIVE), { code: "PERIOD_CLOSED" });
    assert.equal(await ledgerCount(), before);
    assert.ok((await svc.OB.warnings(new Date(`${GO_LIVE}T00:00:00Z`))).some((w) => w.code === "PERIOD_CLOSED"), "the screen is told");
  } finally {
    await svc.FiscalYear.setStatus(fy._id, "open", admin);
  }
  assert.ok(await svc.OB.reverseAccounts(accountsVoucher._id, by).then(() => true).catch(() => false) === true, "open again: it can be reversed");
  accountsVoucher = await svc.OB.postAccounts({
    date: GO_LIVE,
    lines: [{ accountId: (await acct("Cash in Hand"))._id, debit: 5500 }, { accountId: (await acct("Bank Account"))._id, debit: 20000 }, { accountId: (await acct("Vehicles"))._id, debit: 30000 },
      { accountId: (await acct("Bank Loan"))._id, credit: 15000 }, { accountId: (await acct("Owner's Capital"))._id, credit: 10000 }],
  }, by);
  assert.equal(accountsVoucher.voucherNo, `OBV-${Y}-0003`);
});

// ---------------------------------------------------------------------------- 2. customers

let opening = {};
test("customers: open invoices become approved documents with no lines, posted Dr customer / Cr equity", { skip }, async () => {
  const obe = await acct("Opening Balance Equity");
  const obeBefore = await net(obe._id);
  const res = await svc.OB.postParties({
    type: "customer", date: GO_LIVE,
    rows: [
      { partyId: alNoor._id, reference: "INV-1001", date: `${Y}-05-01`, dueDate: `${Y}-06-10`, amount: 1200.5 },
      { partyId: alNoor._id, reference: "INV-1002", date: `${Y}-06-20`, amount: 800 },
      { partyId: gulfCo._id, reference: "", amount: 750 }, // lump sum: no invoice reference
      { partyId: limited._id, reference: "INV-9001", date: `${Y}-06-01`, amount: 900 },
    ],
  }, by);
  assert.equal(res.count, 4);
  assert.equal(res.total, 3650.5);
  assert.deepEqual(res.equityOffset, { account: "Opening Balance Equity", side: "credit", amount: 3650.5 });
  assert.deepEqual(res.created.map((c) => c.transactionNo), [`OSI-${Y}-0001`, `OSI-${Y}-0002`, `OSI-${Y}-0003`, `OSI-${Y}-0004`]);

  const docs = await svc.Transaction.find({ isOpening: true }).sort({ transactionNo: 1 });
  assert.equal(docs.length, 4);
  for (const d of docs) {
    assert.equal(d.type, "sales_order");
    assert.equal(d.status, "APPROVED");
    assert.equal(d.items.length, 0);
    assert.equal(d.paidAmount, 0);
    assert.equal(d.outstandingAmount, d.totalAmount);
    assert.equal(d.charges.length, 0);
    assert.equal(d.pricing?.grandTotal ?? null, null, "no server pricing: nothing to tax");
  }
  const [a, b, lump, lim] = docs;
  opening = { a, b, lump, lim };
  assert.equal(a.docno, "INV-1001");
  assert.equal(a.vendorReference, "INV-1001");
  assert.equal(a.dueDate.toISOString().slice(0, 10), `${Y}-06-10`);
  assert.equal(a.date.toISOString().slice(0, 10), `${Y}-05-01`, "the document keeps the original invoice date for ageing");
  assert.equal(lump.docno, null);
  assert.equal(lump.notes, "Opening balance");
  assert.equal(lump.date.toISOString().slice(0, 10), GO_LIVE);

  // ledger: Dr the customer's own account / Cr Opening Balance Equity, dated the go-live day, per document
  const acc = await acct("Customer - Al Noor");
  assert.ok(acc, "the customer account is created on first use");
  const es = await svc.LedgerEntry.find({ voucherId: a._id }).lean();
  assert.equal(es.length, 2);
  assert.ok(es.every((e) => e.voucherType === "opening" && e.referenceType === "opening_invoice" && e.voucherNo === a.transactionNo));
  assert.equal(new Date(es[0].date).toISOString().slice(0, 10), GO_LIVE);
  assert.equal(es.find((e) => String(e.accountId) === String(acc._id)).debitAmount, 1200.5);
  assert.equal(es.find((e) => String(e.accountId) === String(obe._id)).creditAmount, 1200.5);
  assert.equal(await net(acc._id), 2000.5);
  assert.equal(await net(obe._id), r2(obeBefore - 3650.5));
  assert.equal((await svc.LedgerAccount.findById(acc._id)).currentBalance, 2000.5);

  // the party's running balance and statement log read as an approved invoice leaves them
  assert.equal((await svc.Customer.findById(alNoor._id)).cashBalance, -2000.5);
  const logs = await svc.CreditLog.find({ customerId: alNoor._id }).sort({ createdAt: 1 });
  assert.deepEqual(logs.map((l) => [l.invNo, l.amount, l.balance, l.status]), [[a.transactionNo, -1200.5, -1200.5, "UNPAID"], [b.transactionNo, -800, -2000.5, "UNPAID"]]);
});

test("customers: duplicates, a second lump sum and late dates are refused", { skip }, async () => {
  const before = await svc.Transaction.countDocuments({ isOpening: true });
  await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: alNoor._id, reference: "INV-1001", amount: 5 }] }, by), { code: "DUPLICATE_REFERENCE" });
  await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: gulfCo._id, amount: 5 }] }, by), { code: "DUPLICATE_LUMP_SUM" });
  await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: alNoor._id, reference: "X", amount: 5 }, { partyId: alNoor._id, reference: "X", amount: 5 }] }, by), { code: "DUPLICATE_REFERENCE" });
  await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: alNoor._id, reference: "LATE", amount: 5, date: addDays(GO_LIVE, 1) }] }, by), { code: "DATE_AFTER_GO_LIVE" });
  await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: new mongoose.Types.ObjectId(), reference: "Z", amount: 5 }] }, by), { code: "PARTY_NOT_FOUND" });
  await assert.rejects(() => svc.OB.postParties({ type: "supplier", rows: [] }, by), { code: "INVALID_TYPE" });
  assert.equal(await svc.Transaction.countDocuments({ isOpening: true }), before, "nothing was half-written");
});

test("customers: they age by their own due date or the party's terms, and show in the statement and party balances", { skip }, async () => {
  const asOf = new Date(`${GO_LIVE}T00:00:00Z`);
  const rep = await svc.Ageing.report({ type: "receivable", asOf });
  const row = rep.rows.find((x) => x.partyName === "Al Noor");
  assert.equal(row.buckets.d1_30, 1200.5, "INV-1001 was due 10 June: 20 days late");
  assert.equal(row.buckets.current, 800, "INV-1002 falls due on the party's Net 30 terms");
  assert.equal(row.total, 2000.5);
  const inv = row.invoices.find((i) => i.transactionNo === opening.a.transactionNo);
  assert.equal(inv.daysPastDue, 20);
  assert.equal(inv.isOpening, true);
  assert.equal(rep.rows.find((x) => x.partyName === "Gulf Co").buckets.current, 750);

  // statement from the ledger: dated the go-live day, one row per document
  const st = await svc.Statement.getStatement({ partyId: alNoor._id, partyType: "Customer" });
  assert.equal(st.source, "ledger");
  assert.equal(st.closing, 2000.5);
  assert.equal(st.rows.length, 2);
  assert.match(st.rows[0].narration, /Opening invoice INV-100/);
  // and from the documents (while ledger posting is off): the original invoice dates, labelled
  const docs = await svc.Statement.documentMovements(alNoor._id, "Customer");
  assert.equal(r2(docs.reduce((t, m) => t + m.debit - m.credit, 0)), 2000.5);
  assert.ok(docs.every((m) => /^Opening sales invoice/.test(m.narration)));

  const pb = await svc.Reports.partyBalances({ type: "customer", asOn: GO_LIVE });
  const mine = pb.rows.find((r) => r.partyName === "Al Noor");
  assert.equal(mine.balance, 2000.5);
  assert.equal(mine.overdue, 1200.5);
  assert.equal(pb.rows.find((r) => r.partyName === "Gulf Co").balance, 750);
});


test("customers: a receipt settles part of an opening invoice, and a settled one cannot be removed", { skip }, async () => {
  const a = opening.a;
  const acc = await acct("Customer - Al Noor");
  const rv = await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: alNoor._id, totalAmount: 700.5, date: addDays(GO_LIVE, 2), paymentMode: "cash",
    linkedInvoices: [{ invoiceId: a._id, amount: 700.5, balance: 500 }],
  }, admin);
  assert.equal(rv.status, "approved");
  const inv = await svc.Transaction.findById(a._id);
  assert.deepEqual([inv.paidAmount, inv.outstandingAmount, inv.status], [700.5, 500, "APPROVED"], "paid and outstanding move; the status stays APPROVED");
  assert.equal(await net(acc._id), 1300);

  await assert.rejects(() => svc.OB.reverseParty(a._id, by), { code: "OPENING_INVOICE_SETTLED" });
  // "as at" is what was open ON that day: the receipt was made two days after go-live, so at go-live the whole invoice was open
  const rep = await svc.Ageing.report({ type: "receivable", asOf: new Date(`${GO_LIVE}T00:00:00Z`) });
  assert.equal(rep.rows.find((x) => x.partyName === "Al Noor").buckets.d1_30, 1200.5);
  const after = await svc.Ageing.report({ type: "receivable", asOf: new Date(`${addDays(GO_LIVE, 2)}T23:59:59Z`) });
  assert.equal(after.rows.find((x) => x.partyName === "Al Noor").buckets.d1_30, 500, "and from the day of the receipt, what is left");
  const list = await svc.OB.listParties("customer");
  const row = list.rows.find((r) => r.reference === "INV-1001");
  assert.deepEqual([row.amount, row.paid, row.outstanding, row.canReverse], [1200.5, 700.5, 500, false]);
  assert.equal(list.rows.find((r) => r.reference === "INV-1002").canReverse, true);
  assert.ok(list.available.some((p) => p.name === "Al Noor"), "the picker lists the customers");
});

test("customers: the document list the receipt form reads returns them, flagged, with no lines", { skip }, async () => {
  const r = await svc.Tx.getAllTransactions({ type: "sales_order", partyId: String(alNoor._id), status: "APPROVED" });
  assert.equal(r.transactions.length, 2);
  for (const t of r.transactions) {
    assert.equal(t.isOpening, true);
    assert.deepEqual(t.items, []);
    assert.equal(t.status, "APPROVED");
    assert.equal(t.partyName, "Al Noor");
    assert.ok(t.outstandingAmount > 0);
  }
  const a = r.transactions.find((t) => t.docno === "INV-1001");
  assert.deepEqual([a.totalAmount, a.paidAmount, a.outstandingAmount], [1200.5, 700.5, 500]);
  assert.equal(a.dueDate.toISOString().slice(0, 10), `${Y}-06-10`);
});

test("customers: an unsettled opening invoice can be removed, undoing its ledger entries and the party's balance", { skip }, async () => {
  const acc = await acct("Customer - Gulf Co");
  const cashBefore = (await svc.Customer.findById(gulfCo._id)).cashBalance;
  const netBefore = await net(acc._id);
  const r = await svc.OB.postParties({ type: "customer", rows: [{ partyId: gulfCo._id, reference: "TEMP-1", amount: 40 }] }, by);
  const id = r.created[0]._id;
  assert.equal((await svc.Customer.findById(gulfCo._id)).cashBalance, cashBefore - 40);
  assert.equal(await net(acc._id), netBefore + 40);

  const gone = await svc.OB.reverseParty(id, by);
  assert.equal(gone.removed, true);
  assert.equal(await svc.Transaction.findById(id), null);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: id, isReversed: { $ne: true } }), 0);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: id }), 4, "the entries and their reversal stay on record");
  assert.equal((await svc.Customer.findById(gulfCo._id)).cashBalance, cashBefore);
  assert.equal(await net(acc._id), netBefore);
  assert.ok(await svc.CreditLog.exists({ customerId: gulfCo._id, type: "sales_order_reversed" }));
  await assert.rejects(() => svc.OB.reverseParty(id, by), { code: "NOT_FOUND" });
});

test("customers: an opening balance counts in credit control", { skip }, async () => {
  // Limited owes 900 from the old books and has a 1,000 limit
  const clean = await svc.Customer.create({ customerId: "C4", customerName: "Clean", contactPerson: "x", creditLimit: 1000 });
  await svc.Config.updateSettings({ creditControl: { mode: "block" } });
  try {
    const sale = (party) => svc.Tx.createTransaction(
      { type: "sales_order", partyId: party._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(sugar, 2, 100)], date: addDays(GO_LIVE, 3) }, "tester");
    const blocked = await sale(limited);
    await assert.rejects(() => svc.Tx.processTransaction(blocked._id, "approve", "tester"), { statusCode: 403, code: "RISK_LIMIT_BLOCKED" });
    const fine = await sale(clean); // same sale, same limit, no opening balance
    await svc.Tx.processTransaction(fine._id, "approve", "tester");
    assert.equal((await svc.Transaction.findById(fine._id)).status, "APPROVED");
    await svc.Transaction.deleteOne({ _id: blocked._id });
  } finally {
    await svc.Config.updateSettings({ creditControl: { mode: "off" } });
  }
});

// ------------------------------------------------------------------------------- 3. vendors

let vendorInv;
test("vendors: Dr equity / Cr the vendor's account, payable ageing, statement and payment allocation", { skip }, async () => {
  const obe = await acct("Opening Balance Equity");
  const obeBefore = await net(obe._id);
  const res = await svc.OB.postParties({ type: "vendor", rows: [{ partyId: millsVendor._id, reference: "INV-V-77", date: `${Y}-05-15`, amount: 3000 }] }, by);
  assert.equal(res.created[0].transactionNo, `OPI-${Y}-0001`);
  assert.deepEqual(res.equityOffset, { account: "Opening Balance Equity", side: "debit", amount: 3000 });
  vendorInv = await svc.Transaction.findById(res.created[0]._id);
  assert.deepEqual([vendorInv.type, vendorInv.isOpening, vendorInv.status, vendorInv.docno, vendorInv.vendorReference], ["purchase_order", true, "APPROVED", "INV-V-77", "INV-V-77"]);
  assert.equal(vendorInv.items.length, 0);

  const acc = await acct("Vendor - Gulf Mills");
  const es = await svc.LedgerEntry.find({ voucherId: vendorInv._id }).lean();
  assert.equal(es.find((e) => String(e.accountId) === String(obe._id)).debitAmount, 3000);
  assert.equal(es.find((e) => String(e.accountId) === String(acc._id)).creditAmount, 3000);
  assert.equal(await net(acc._id), -3000);
  assert.equal(await net(obe._id), r2(obeBefore + 3000));
  assert.equal((await svc.Vendor.findById(millsVendor._id)).cashBalance, 3000, "we owe the vendor: positive, as an approved purchase leaves it");
  const log = await svc.DebitLog.findOne({ vendorId: millsVendor._id });
  assert.deepEqual([log.type, log.invNo, log.amount, log.balance, log.status], ["purchase_order", vendorInv.transactionNo, 3000, 3000, "UNPAID"]);

  const rep = await svc.Ageing.report({ type: "payable", asOf: new Date(`${GO_LIVE}T00:00:00Z`) });
  assert.equal(rep.rows.find((x) => x.partyName === "Gulf Mills").buckets.d1_30, 3000, "15 May + Net 45 = due 29 June: one day late");
  const st = await svc.Statement.getStatement({ partyId: millsVendor._id, partyType: "Vendor" });
  assert.equal(st.closing, 3000);
  assert.equal((await svc.Reports.partyBalances({ type: "vendor", asOn: GO_LIVE })).rows.find((r) => r.partyName === "Gulf Mills").balance, 3000);

  await svc.Financial.createVoucher({
    voucherType: "payment", vendorId: millsVendor._id, totalAmount: 1000, date: addDays(GO_LIVE, 2), paymentMode: "cash",
    linkedInvoices: [{ invoiceId: vendorInv._id, amount: 1000, balance: 2000 }],
  }, admin);
  const paid = await svc.Transaction.findById(vendorInv._id);
  assert.deepEqual([paid.paidAmount, paid.outstandingAmount], [1000, 2000]);
  assert.equal(await net(acc._id), -2000);
  await assert.rejects(() => svc.OB.reverseParty(vendorInv._id, by), { code: "OPENING_INVOICE_SETTLED" });
});

// ---------------------------------------------------------------------------------- guards

test("guard: an opening invoice is not in the VAT return and nothing is written to the old VAT report table", { skip }, async () => {
  assert.equal(await svc.VATReport.countDocuments({}), 0, "the old VAT report table is no longer written");
  const lines = await require("../reports/vatReturnService").collect({ from: "2000-01-01", to: "2100-01-01" });
  assert.ok(!lines.some((l) => /^OSI|^OPI/.test(l.docNo)), "opening invoices carry no VAT of this period");
});

test("guard: opening invoices are not e-invoice documents and cannot be built or sent", { skip }, async () => {
  const docs = await svc.EI.documents({}, { limit: 100 });
  assert.ok(!docs.some((d) => /^OSI-/.test(d.transactionNo)), "not in the e-invoice list");
  await assert.rejects(() => svc.EI.build(opening.a._id, {}), { code: "NOT_ELIGIBLE" });
});

test("guard: an inbound supplier e-invoice is never matched to an opening purchase invoice", { skip }, async () => {
  const doc = { sellerVatTrn: "100123456700003", invoiceRef: "INV-V-77", documentId: "D-77", totals: { payable: 3000 } };
  const m = await svc.Inbound.match(doc, "default");
  assert.equal(String(m.vendorId), String(millsVendor._id), "the vendor is found by its TRN");
  assert.equal(m.purchaseOrderId, null);
  await svc.Transaction.updateOne({ _id: vendorInv._id }, { isOpening: false });
  assert.equal(String((await svc.Inbound.match(doc, "default")).purchaseOrderId), String(vendorInv._id), "without the flag it would have matched");
  await svc.Transaction.updateOne({ _id: vendorInv._id }, { isOpening: true });
});

test("guard: an opening invoice has nothing to return", { skip }, async () => {
  await assert.rejects(() => svc.Returns.returnable(opening.b._id), { statusCode: 422, code: "OPENING_NOT_RETURNABLE" });
  await assert.rejects(
    () => svc.Tx.createTransaction({ type: "sales_return", partyId: alNoor._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(rice, 1, 10)], returnOf: { transactionId: opening.b._id } }, "t"),
    { code: "OPENING_NOT_RETURNABLE" }
  );
  await assert.rejects(
    () => svc.Tx.createTransaction({ type: "purchase_return", partyId: millsVendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(rice, 1, 10)], returnOf: { transactionId: vendorInv._id } }, "t"),
    { code: "OPENING_NOT_RETURNABLE" }
  );
});

test("guard: catch-up posting skips opening invoices and never doubles anything", { skip }, async () => {
  const before = await ledgerCount();
  const first = await svc.Posting.catchUp();
  assert.deepEqual([first.posted, first.failed.length], [0, 0]);
  assert.equal(await ledgerCount(), before, "every opening invoice already has its entries; nothing is added");

  // and the posting entry point itself refuses to run the sales template for one
  assert.equal(await svc.Posting.postTransaction(opening.a, { createdBy: admin }), null);
  assert.equal(await ledgerCount(), before);

  // even an opening document with no entries is not run through the sales template
  const orphan = await svc.Transaction.create({
    transactionNo: "OSI-ORPHAN", type: "sales_order", partyId: alNoor._id, partyType: "Customer", partyTypeRef: "Customer",
    status: "APPROVED", totalAmount: 55, outstandingAmount: 55, isOpening: true, docno: "ORPH", createdBy: "t",
  });
  const second = await svc.Posting.catchUp();
  assert.equal(second.posted, 0);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: orphan._id }), 0);
  // contrast: the same document as an ordinary sale is posted
  await svc.Transaction.updateOne({ _id: orphan._id }, { isOpening: false });
  assert.equal((await svc.Posting.catchUp()).posted, 1);
  await svc.Posting.reverseTransaction({ _id: orphan._id });
  await svc.Transaction.deleteOne({ _id: orphan._id });
});

test("guard: an opening invoice moves no stock, cannot be approved again, edited or deleted as a sale", { skip }, async () => {
  const moves = await svc.Movement.countDocuments({});
  assert.deepEqual(await svc.Tx.processTransactionStock(opening.a._id, opening.a, "t", null), []);
  assert.equal(await svc.Tx.reverseTransactionStock(opening.a._id, opening.a, "t", null), undefined);
  assert.equal(await svc.Movement.countDocuments({}), moves);
  assert.equal(await svc.Movement.countDocuments({ referenceId: opening.a._id }), 0);

  await assert.rejects(() => svc.Tx.deleteTransaction(opening.a._id, "t"), { statusCode: 409, code: "OPENING_DOCUMENT" });
  await assert.rejects(() => svc.Tx.processTransaction(opening.a._id, "cancel", "t"), { statusCode: 400 });
  await assert.rejects(() => svc.Tx.updateTransaction(opening.a._id, { notes: "edit" }, "t"), { statusCode: 400 });
  assert.ok(await svc.Transaction.exists({ _id: opening.a._id }));
});

test("guard: the sales analysis leaves opening invoices out", { skip }, async () => {
  const crafted = await svc.Customer.create({ customerId: "C5", customerName: "Crafted Co", contactPerson: "x" });
  const doc = await svc.Transaction.create({
    transactionNo: "OSI-CRAFT", type: "sales_order", partyId: crafted._id, partyType: "Customer", partyTypeRef: "Customer", status: "APPROVED",
    isOpening: true, date: new Date(`${GO_LIVE}T00:00:00Z`), totalAmount: 500, outstandingAmount: 500, createdBy: "t",
    items: [{ itemId: rice._id, itemCode: "RICE", description: "Rice", qty: 5, price: 100, lineTotal: 500, vatAmount: 0 }],
  });
  const names = async () => (await svc.StockReports.salesAnalysis({ from: `${Y}-01-01`, to: `${Y}-12-31`, groupBy: "customer" })).rows.map((r) => r.name);
  assert.ok(!(await names()).includes("Crafted Co"));
  await svc.Transaction.updateOne({ _id: doc._id }, { isOpening: false });
  assert.ok((await names()).includes("Crafted Co"), "without the flag it is revenue");
  await svc.Transaction.deleteOne({ _id: doc._id });
});

// ------------------------------------------------------------------------------------ 4. stock

const stockVouchers = {};

test("stock: refused for an item with movements or stock on hand, a tracked item without batch and expiry, bad numbers", { skip }, async () => {
  const legacy = await svc.Stock.create({ itemId: "LEGACY", sku: "LEGACY", itemName: "Legacy", category: new mongoose.Types.ObjectId(), currentStock: 10 });
  const movesBefore = await svc.Movement.countDocuments({});
  const batchesBefore = await svc.Batch.countDocuments({});
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: sugar._id, qty: 5, unitCost: 2 }] }, by), (e) => {
    assert.equal(e.code, "ITEM_HAS_MOVEMENTS");
    assert.equal(e.statusCode, 409);
    assert.match(e.message, /stock adjustment/);
    assert.deepEqual(e.details.items.map((i) => i.itemId), ["SUGAR"]);
    return true;
  });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: legacy._id, qty: 5, unitCost: 2 }] }, by), { code: "ITEM_HAS_MOVEMENTS" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: milk._id, qty: 5, unitCost: 2 }] }, by), { code: "BATCH_REQUIRED" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: milk._id, qty: 5, unitCost: 2, batchNo: "M1" }] }, by), { code: "BATCH_REQUIRED" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: rice._id, qty: 0, unitCost: 2 }] }, by), { code: "INVALID_QTY" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: rice._id, qty: 1, unitCost: -2 }] }, by), { code: "INVALID_COST" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: new mongoose.Types.ObjectId(), qty: 1, unitCost: 2 }] }, by), { code: "ITEM_NOT_FOUND" });
  assert.equal(await svc.Movement.countDocuments({}), movesBefore);
  assert.equal(await svc.Batch.countDocuments({}), batchesBefore);
  assert.equal((await svc.Stock.findById(rice._id)).currentStock, 0);
});

test("stock: two rows of one item at different costs: weighted average, movements, batches and ONE ledger voucher", { skip }, async () => {
  const inv = await acct("Inventory Stock");
  const obe = await acct("Opening Balance Equity");
  const invBefore = await net(inv._id);
  const obeBefore = await net(obe._id);
  const res = await svc.OB.postStock({
    date: GO_LIVE,
    rows: [
      { itemId: rice._id, qty: 10, unitCost: 5, batchNo: "R-B1", expiryDate: `${Y + 1}-03-01` },
      { itemId: rice._id, qty: 30, unitCost: 7, batchNo: "R-B2", expiryDate: addDays(GO_LIVE, -5) },
    ],
  }, by);
  stockVouchers.rice = res;
  assert.match(res.voucherNo, new RegExp(`^OST-${Y}-0001$`));
  assert.equal(res.totalValue, 260);
  assert.equal(res.warnings.length, 1);
  assert.deepEqual([res.warnings[0].code, res.warnings[0].row], ["EXPIRED_AT_GO_LIVE", 2], "a batch already expired at go-live warns, it does not block");
  assert.deepEqual(res.items, [{ itemId: "RICE", itemName: "Rice", qty: 40, avgCost: 6.5, value: 260 }]);

  const s = await svc.Stock.findById(rice._id);
  assert.deepEqual([s.currentStock, s.costValue, s.purchasePrice], [40, 260, 6.5]);
  assert.ok(Math.abs(s.purchasePrice - s.costValue / s.currentStock) < 1e-5);

  const mv = await svc.Movement.find({ stockId: "RICE" }).sort({ _id: 1 });
  assert.equal(mv.length, 2);
  assert.ok(mv.every((m) => m.eventType === "OPENING_STOCK" && m.costBasis === "opening" && m.referenceNumber === res.voucherNo && String(m.referenceId) === String(res._id)));
  assert.equal(mv[0].date.toISOString().slice(0, 10), GO_LIVE, "dated the go-live day");
  const shape = (m) => [m.previousStock, m.newStock, m.unitCost, m.totalValue, m.rateBefore, m.rateAfter, m.costPoolAfter, m.poolQtyAfter];
  assert.deepEqual(shape(mv[0]), [0, 10, 5, 50, 0, 5, 50, 10]);
  assert.deepEqual(shape(mv[1]), [10, 40, 7, 210, 5, 6.5, 260, 40]);

  const batches = await svc.Batch.find({ stockId: rice._id }).sort({ receivedQty: 1 });
  assert.deepEqual(batches.map((b) => [b.batchNumber, b.qtyOnHand, b.unitCost]), [["R-B1", 10, 5], ["R-B2", 30, 7]]);
  assert.equal(batches[0].expiryDate.toISOString().slice(0, 10), `${Y + 1}-03-01`);
  assert.ok(batches.every((b) => String(b.sourceTransactionId) === String(res._id) && b.sourceTransactionNo === res.voucherNo));

  const es = await svc.LedgerEntry.find({ voucherId: res._id }).lean();
  assert.equal(es.length, 2, "one voucher for the whole submission");
  assert.ok(es.every((e) => e.voucherType === "opening_stock"));
  assert.equal(es.find((e) => String(e.accountId) === String(inv._id)).debitAmount, 260);
  assert.equal(es.find((e) => String(e.accountId) === String(obe._id)).creditAmount, 260);
  assert.equal(await net(inv._id), r2(invBefore + 260));
  assert.equal(await net(obe._id), r2(obeBefore - 260));

  // the ledger's inventory equals the stock value at the go-live day
  const v = await svc.StockReports.valuation({ asOn: GO_LIVE });
  assert.equal(v.reconciliation.reconciles, true, JSON.stringify(v.reconciliation));
  assert.equal(v.reconciliation.difference, 0);
  const row = v.rows.find((r) => r.itemId === "RICE");
  assert.deepEqual([row.qty, row.value, row.avgCost], [40, 260, 6.5]);
  assert.ok(v.reconciliation.lines.some((l) => l.key === "opening" && l.stock === 260 && l.ledger === 260 && l.difference === 0), "the opening source reconciles line by line");
});

test("stock: the average cost equals total cost / total quantity to 5 decimals", { skip }, async () => {
  const res = await svc.OB.postStock({
    date: GO_LIVE,
    rows: [{ itemId: flour._id, qty: 7, unitCost: 3.3333, batchNo: "F-1" }, { itemId: flour._id, qty: 3, unitCost: 2.1111 }],
  }, by);
  stockVouchers.flour = res;
  assert.equal(res.voucherNo, `OST-${Y}-0002`);
  assert.equal(res.totalValue, 29.66, "23.33 + 6.33, each row to 2 dp");
  const s = await svc.Stock.findById(flour._id);
  assert.deepEqual([s.currentStock, s.costValue, s.purchasePrice], [10, 29.66, 2.966]);
  assert.ok(Math.abs(s.purchasePrice - 29.66 / 10) < 1e-5);
  const batches = await svc.Batch.find({ stockId: flour._id }).sort({ receivedQty: -1 });
  assert.equal(batches[0].batchNumber, "F-1");
  assert.equal(batches[1].batchNumber, `${res.voucherNo}-2`, "an unnumbered row gets a batch number of its own");
});

test("stock: a second entry for an item (by id or by code) is refused", { skip }, async () => {
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: rice._id, qty: 1, unitCost: 1 }] }, by), { code: "ITEM_HAS_MOVEMENTS" });
  await assert.rejects(() => svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: "RICE", qty: 1, unitCost: 1 }] }, by), { code: "ITEM_HAS_MOVEMENTS" });
  assert.equal((await svc.Stock.findById(rice._id)).currentStock, 40);
});

test("stock: reversing writes the paired movements, removes the batches and restores the cost pool; the item can then be entered again", { skip }, async () => {
  const inv = await acct("Inventory Stock");
  const invBefore = await net(inv._id);
  const res = stockVouchers.flour;
  const done = await svc.OB.reverseStock(res._id, by);
  assert.equal(done.status, "reversed");

  const s = await svc.Stock.findById(flour._id);
  assert.deepEqual([s.currentStock, s.costValue, s.purchasePrice], [0, 0, 1], "back to nothing, and the master's own price as before");
  const mv = await svc.Movement.find({ stockId: "FLOUR" }).sort({ _id: 1 });
  assert.equal(mv.length, 4);
  const originals = mv.filter((m) => !/^REV-/.test(m.referenceNumber));
  const reversals = mv.filter((m) => /^REV-/.test(m.referenceNumber));
  assert.ok(originals.every((m) => m.isReversed && m.reversalReference), "each original points at its reversal");
  assert.deepEqual(reversals.map((m) => m.quantity).sort(), [-7, -3].sort());
  assert.ok(reversals.every((m) => m.referenceNumber === `REV-${res.voucherNo}` && m.eventType === "OPENING_STOCK"));
  assert.equal(await svc.Batch.countDocuments({ stockId: flour._id }), 0);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: res._id, isReversed: { $ne: true } }), 0);
  assert.equal(await net(inv._id), r2(invBefore - 29.66));
  assert.equal((await svc.OBVoucher.findById(res._id)).status, "reversed");
  await assert.rejects(() => svc.OB.reverseStock(res._id, by), { code: "ALREADY_REVERSED" });
  assert.equal((await svc.StockReports.valuation({ asOn: GO_LIVE })).reconciliation.reconciles, true, "stock and ledger still agree");

  // entered again, with the tracked item (batch number and expiry required) in the same submission
  const again = await svc.OB.postStock({
    date: GO_LIVE,
    rows: [{ itemId: flour._id, qty: 10, unitCost: 3 }, { itemId: milk._id, qty: 24, unitCost: 2.5, batchNo: "MILK-01", expiryDate: `${Y + 1}-02-01` }],
  }, by);
  stockVouchers.again = again;
  assert.equal(again.voucherNo, `OST-${Y}-0003`);
  assert.equal(again.totalValue, 90);
  assert.equal(again.warnings.length, 0);
  assert.deepEqual([(await svc.Stock.findById(flour._id)).purchasePrice, (await svc.Stock.findById(milk._id)).currentStock], [3, 24]);
  assert.equal((await svc.Batch.findOne({ stockId: milk._id })).batchNumber, "MILK-01");
});

test("stock: a later movement blocks the reversal and the list says why", { skip }, async () => {
  const sale = await trade("sales_order", gulfCo, "Customer", [line(rice, 5, 20)], { date: addDays(GO_LIVE, 1) });
  const mv = await svc.Movement.findOne({ referenceId: sale._id });
  assert.equal(mv.cogsAmount, 32.5, "5 units at the opening average of 6.50");
  assert.equal((await svc.Batch.findOne({ batchNumber: "R-B1" })).qtyOnHand, 5, "first-expiry-first-out skips the batch that expired");

  await assert.rejects(() => svc.OB.reverseStock(stockVouchers.rice._id, by), (e) => {
    assert.equal(e.code, "STOCK_HAS_MOVEMENTS");
    assert.match(e.message, /Rice/);
    return true;
  });
  assert.equal((await svc.Stock.findById(rice._id)).currentStock, 35, "nothing changed");

  const list = await svc.OB.listStock();
  const v = list.vouchers.find((x) => String(x._id) === String(stockVouchers.rice._id));
  assert.deepEqual([v.canReverse, v.blockedBy], [false, ["Rice"]]);
  assert.equal(list.vouchers.find((x) => String(x._id) === String(stockVouchers.again._id)).canReverse, true);
  assert.equal(list.vouchers.find((x) => String(x._id) === String(stockVouchers.flour._id)).status, "reversed");
  const byCode = Object.fromEntries(list.items.map((i) => [i.itemId, i]));
  assert.equal(byCode.SUGAR.canEnter, false);
  assert.match(byCode.SUGAR.reason, /movements/);
  assert.equal(byCode.LEGACY.canEnter, false);
  assert.equal(byCode.MILK.batchTracked, true);
  assert.equal(byCode.RICE.entered, true);
});

test("stock: a cost replay treats opening stock as a purchase at its entered cost", { skip }, async () => {
  const Recost = require("../stock/recostService");
  const before = await svc.Stock.findById(rice._id);
  const moves = async () => (await svc.Movement.find({ stockId: "RICE" }).sort({ _id: 1 }).lean()).map((m) => [m.totalValue, m.rateAfter, m.costPoolAfter, m.poolQtyAfter]);
  const mvBefore = await moves();
  const deltas = await Recost.recostItem(rice._id, new Date(`${GO_LIVE}T00:00:00Z`));
  assert.equal(deltas.size, 0, "nothing changes: the 5 sold were already costed at the opening average");
  const after = await svc.Stock.findById(rice._id);
  assert.deepEqual([after.currentStock, after.costValue, after.purchasePrice], [before.currentStock, before.costValue, before.purchasePrice]);
  assert.deepEqual([after.currentStock, after.costValue, after.purchasePrice], [35, 227.5, 6.5]);
  assert.deepEqual(await moves(), mvBefore);
});

// ---------------------------------------------------------------------------------- summary

test("summary: sections, the opening trial balance, Opening Balance Equity and the stock reconciliation", { skip }, async () => {
  const sum = await svc.OB.summary({});
  assert.equal(sum.goLive.toISOString().slice(0, 10), GO_LIVE);
  assert.ok(sum.postedAt);
  assert.deepEqual(
    { rows: sum.sections.accounts.rows, vouchers: sum.sections.accounts.vouchers, debit: sum.sections.accounts.debit, credit: sum.sections.accounts.credit, difference: sum.sections.accounts.difference },
    { rows: 6, vouchers: 1, debit: 55600, credit: 25000, difference: 30500 },
    "five lines of the voucher plus the account whose balance was set when it was created"
  );
  assert.deepEqual(sum.sections.customers, { rows: 4, parties: 3, total: 3650.5, outstanding: 2950 });
  assert.deepEqual(sum.sections.vendors, { rows: 1, parties: 1, total: 3000, outstanding: 2000 });
  assert.deepEqual(sum.sections.stock, { rows: 4, items: 3, vouchers: 2, value: 350 }, "the reversed voucher no longer counts");

  assert.equal(sum.trialBalance.balanced, true);
  assert.equal(sum.trialBalance.debit, sum.trialBalance.credit);
  // Opening Balance Equity: accounts 30,500 + ENBD 100 + customers 3,650.50 - vendors 3,000 + stock 350
  assert.equal(sum.trialBalance.equity.openingBalance, 31600.5);
  assert.equal(sum.trialBalance.equity.balance, 31600.5);
  assert.equal(sum.trialBalance.equity.accountName, "Opening Balance Equity");

  assert.equal(sum.stockReconciliation.available, true);
  assert.equal(sum.stockReconciliation.reconciles, true);
  assert.deepEqual(sum.missing, []);
  assert.ok(sum.warnings.some((w) => w.code === "TRANSACTIONS_BEFORE_GO_LIVE"));

  // the opening entries really are a balanced trial balance, straight from the ledger
  const [t] = await svc.LedgerEntry.aggregate([
    { $match: { voucherType: { $in: ["opening", "opening_stock"] }, isReversed: { $ne: true } } },
    { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
  ]);
  assert.equal(r2(t.d), r2(t.c));
});

test("customers: a party whose own account already carries an opening balance cannot also get opening invoices", { skip }, async () => {
  const Chart = require("../financial/chartOfAccountsService");
  const held = await svc.Customer.create({ customerId: "C6", customerName: "Held Co", contactPerson: "x" });
  const acc = await svc.PartyAccounts.ensurePartyAccount("customer", held._id, "Held Co");
  // what the chart's account form does when an opening balance is typed in
  await Chart.postOpening(acc, { opening: 250, side: "debit", date: new Date(`${GO_LIVE}T00:00:00Z`), adminId: admin });
  try {
    await assert.rejects(() => svc.OB.postParties({ type: "customer", rows: [{ partyId: held._id, reference: "H-1", amount: 10 }] }, by), { code: "PARTY_HAS_ACCOUNT_OPENING" });
    const row = (await svc.OB.listAccounts({})).entered.find((e) => e.accountName === "Customer - Held Co");
    assert.deepEqual([row.party, row.debit, row.source], [true, 250, "account-created"], "listed, and marked as a party account");
    assert.equal(await svc.Transaction.countDocuments({ partyId: held._id }), 0);
  } finally {
    await svc.Financial.reverseLedgerEntries(acc._id);
  }
});

test("a double submit enters the balance once", { skip }, async () => {
  const util = await acct("Utilities");
  const body = { date: GO_LIVE, lines: [{ accountId: util._id, debit: 75 }] };
  const results = await Promise.allSettled([svc.OB.postAccounts(body, by), svc.OB.postAccounts(body, by)]);
  const done = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(done.length, 1, JSON.stringify(results.map((r) => r.reason?.message || "ok")));
  assert.equal(refused[0].reason.code, "ALREADY_HAS_OPENING");
  assert.equal(await net(util._id), 75);
  await svc.OB.reverseAccounts(done[0].value._id, by);
  assert.equal(await net(util._id), 0);
});

test("the go-live date is fixed once opening entries exist", { skip }, async () => {
  await assert.rejects(() => svc.OB.setGoLiveDate(addDays(GO_LIVE, 1)), { code: "GO_LIVE_DATE_LOCKED" });
  assert.ok(await svc.OB.setGoLiveDate(GO_LIVE), "the same date again is fine");
});

test("running catch-up after everything posts nothing twice and the books balance", { skip }, async () => {
  const before = await ledgerCount();
  const r = await svc.Posting.catchUp();
  assert.deepEqual([r.posted, r.failed.length], [0, 0]);
  assert.equal(await ledgerCount(), before);
  const [t] = await svc.LedgerEntry.aggregate([{ $match: { isReversed: { $ne: true } } }, { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(r2(t.d), r2(t.c), "debits equal credits across the whole ledger");
  // each account's stored balance still agrees with its entries
  const cash = await acct("Cash in Hand");
  assert.equal((await svc.LedgerAccount.findById(cash._id)).currentBalance, await net(cash._id));
  const obe = await acct("Opening Balance Equity");
  assert.equal((await svc.LedgerAccount.findById(obe._id)).currentBalance, -(await net(obe._id)));
});

// -------------------------------------------------------------------------------------- HTTP

test("HTTP: the routes, the roles and the response shape", { skip }, async () => {
  const express = require("express");
  const adminService = require("../core/adminService");
  const Admin = require("../../models/core/adminModel");
  const router = require("../../routes/financial/openingBalanceRoutes");
  const errorHandler = require("../../utils/errorHandler");
  await new Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  await new Admin({ name: "Viewer", email: "viewer@test.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();
  const boss = (await adminService.loginAdmin("boss@test.uae", "12312312")).tokens.accessToken;
  const viewer = (await adminService.loginAdmin("viewer@test.uae", "12312312")).tokens.accessToken;

  const app = express();
  app.use(express.json());
  app.use("/api/v1/opening-balances", router);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/opening-balances`;
  const call = async (method, url, token, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await call("GET", "/summary")).status, 401);
    const sum = await call("GET", "/summary", boss);
    assert.equal(sum.status, 200);
    assert.equal(sum.body.success, true);
    assert.equal(sum.body.data.sections.customers.rows, 4);
    assert.equal(sum.body.data.trialBalance.balanced, true);

    const parties = await call("GET", "/parties?type=customer", boss);
    assert.equal(parties.body.data.rows.length, 4);
    assert.ok(parties.body.data.available.some((p) => p.name === "Al Noor"));
    const bad = await call("GET", "/parties?type=nope", boss);
    assert.deepEqual([bad.status, bad.body.success, bad.body.errorCode], [400, false, "INVALID_TYPE"]);
    assert.ok(Array.isArray((await call("GET", "/accounts", boss)).body.data.available));
    assert.ok((await call("GET", "/stock", boss)).body.data.items.some((i) => i.itemId === "SUGAR"));

    // a viewer can read, not post
    assert.equal((await call("GET", "/summary", viewer)).status, 200);
    assert.equal((await call("POST", "/parties", viewer, { type: "customer", rows: [] })).status, 403);
    assert.equal((await call("PUT", "/go-live", viewer, { date: GO_LIVE })).status, 403);

    assert.equal((await call("PUT", "/go-live", boss, { date: "nonsense" })).body.errorCode, "INVALID_DATE");
    assert.equal((await call("POST", "/accounts", boss, { lines: [] })).body.errorCode, "NO_LINES");
    assert.equal((await call("DELETE", "/stock/not-an-id", boss)).body.errorCode, "INVALID_ID");

    const made = await call("POST", "/parties", boss, { type: "customer", rows: [{ partyId: String(limited._id), reference: "HTTP-1", amount: 12.5 }] });
    assert.equal(made.status, 201);
    assert.equal(made.body.data.count, 1);
    const gone = await call("DELETE", `/parties/${made.body.data.created[0]._id}`, boss);
    assert.deepEqual([gone.status, gone.body.data.removed], [200, true]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
