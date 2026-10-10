// The report review of 10 Oct 2026 (financial statements, ledger and party reports, VAT / stock / dashboard), one test per
// confirmed defect, against a throwaway database:
//   ageing "as at" a past day is what was open then; the ageing page ties to the party accounts
//   a vendor's statement carries their advance account
//   credit control reads what the BOOKS say a customer owes, not Customer.cashBalance
//   sales discounts reduce revenue (IFRS 15.47); net profit does not move
//   the legacy balance sheet does not net a bank in credit, and finds the right year on any host
//   a range that runs backwards, or a day that does not exist, is refused
//   the VAT return: the whole organisation only, the emirate said when assumed, a change since filing shown
//   the dashboard compares a year with the year, a quarter with the quarter, and leaves the settlement journal out of the VAT trend
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const at = (ymd) => new Date(`${ymd}T12:00:00+04:00`); // midday in Dubai
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
let ctx = {};

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Chart: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    Reports: require("../reports/ledgerReportsService"),
    Ageing: require("../financial/ageingService"),
    Statement: require("../financial/statementService"),
    Credit: require("../financial/creditControlService"),
    Vat: require("../reports/vatReturnService"),
    Dashboard: require("../reports/dashboardService"),
    Ifrs: require("../reports/ifrsReportsService"),
    PartyAccounts: require("../financial/partyAccounts"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    tenant: require("../../utils/tenantContext"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  await svc.FiscalYear.deleteMany({}); // no fiscal year defined: posting is allowed on any day

  const customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 0, paymentTerms: "Net 30" });
  const limited = await svc.Customer.create({ customerId: "C2", customerName: "Limited Trading", contactPerson: "x", creditLimit: 1000 });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  const stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const std = await svc.TaxCode.findOne({ kind: "standard" });
  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  ctx = { customer, limited, vendor, stock, std, cash: await acct("Cash in Hand"), rent: await acct("Rent Expense"), capital: await acct("Owner's Capital") };
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const line = (qty, price, extra = {}) => ({ itemId: ctx.stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, taxCodeId: ctx.std._id, ...extra });
const sale = async (party, qty, price, day, extra = {}) => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: party._id, partyType: "Customer", partyTypeRef: "Customer", date: at(day), items: [line(qty, price, extra.line)], ...(extra.doc || {}) }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return svc.Transaction.findById(t._id).lean();
};
const buy = async (qty, price, day) => {
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: ctx.vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", date: at(day), items: [line(qty, price)] }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return svc.Transaction.findById(t._id).lean();
};
const receipt = (party, amount, day, invoice) =>
  svc.Financial.createVoucher({
    voucherType: "receipt", customerId: party._id, totalAmount: amount, date: at(day), paymentMode: "cash",
    linkedInvoices: invoice ? [{ invoiceId: invoice._id, amount, balance: r2(invoice.outstandingAmount - amount) }] : [],
  }, admin);

// ================================================================================== ageing
test("ageing as at a past day is what was open on that day, including an invoice paid since", { skip }, async () => {
  await buy(500, 10, "2024-02-01"); // stock to sell
  const inv = await sale(ctx.customer, 10, 100, "2024-03-01"); // 1,000 + 50 VAT = 1,050
  await receipt(ctx.customer, 1050, "2024-04-15", inv);

  const before = await svc.Ageing.report({ type: "receivable", asOf: svc.Reports.dayEnd("2024-04-10") });
  assert.equal(before.totals.total, 1050, "on 10 April the invoice was still open (it was paid on the 15th)");
  const after = await svc.Ageing.report({ type: "receivable", asOf: svc.Reports.dayEnd("2024-04-15") });
  assert.equal(after.totals.total, 0, "from the day of the receipt nothing is open");
  const early = await svc.Ageing.report({ type: "receivable", asOf: svc.Reports.dayEnd("2024-02-20") });
  assert.equal(early.totals.total, 0, "before the invoice existed");
  const today = await svc.Ageing.report({ type: "receivable", asOf: new Date() });
  assert.equal(today.totals.total, 0, "today's figure is unchanged");
});

test("a return not set against an invoice is shown as the difference between the open invoices and the party accounts", { skip }, async () => {
  const inv = await sale(ctx.customer, 10, 100, "2024-05-01"); // 1,050 open
  // a credit note with no invoice named: it lowers the party's account but no invoice
  const discounts = await svc.LedgerAccount.findOne({ accountName: "Sales Discounts Given" });
  await svc.Financial.createVoucher({
    voucherType: "credit_note", partyType: "Customer", partyId: ctx.customer._id, date: at("2024-05-10"),
    lines: [{ accountId: discounts._id, description: "Rebate", amount: 200 }],
  }, admin);
  const rep = await svc.Ageing.report({ type: "receivable", asOf: svc.Reports.dayEnd("2024-05-31") });
  const tie = await svc.Reports.ageingReconciliation({ type: "receivable", asOf: svc.Reports.dayEnd("2024-05-31"), ageingTotal: rep.totals.total });
  assert.equal(inv.status, "APPROVED");
  assert.equal(tie.ageing, rep.totals.total);
  assert.equal(tie.unapplied, -200, "the 200 credit note is in the accounts and in no invoice");
  assert.equal(r2(tie.ageing + tie.unapplied), tie.ledger, "ageing + unapplied = what the party accounts hold");
});

// ================================================================================== statements
test("a vendor's statement carries the advance account, so it closes at the party balance", { skip }, async () => {
  const adv = await svc.Financial.createVoucher({
    voucherType: "payment", vendorId: ctx.vendor._id, totalAmount: 400, date: at("2024-06-01"), paymentMode: "cash", linkedInvoices: [],
  }, admin);
  assert.equal(adv.status, "approved");
  const st = await svc.Statement.getStatement({ partyId: String(ctx.vendor._id), partyType: "Vendor" });
  const balances = await svc.Reports.partyBalances({ type: "vendor", asOn: "2024-12-31" });
  const row = balances.rows.find((r) => r.partyName === "Gulf Mills");
  assert.equal(st.closing, row.balance, "statement and party balances agree, with the advance in both");
  assert.equal(row.onAccount, 400, "and the advance is reported as an advance");
});

// ================================================================================== credit control
test("credit control judges what the books say the customer owes, not Customer.cashBalance", { skip }, async () => {
  // a customer who has always paid: their ledger exposure is nil, but cashBalance is whatever the old flow left
  await svc.Customer.updateOne({ _id: ctx.limited._id }, { cashBalance: -50000 });
  const exposure = await svc.Credit.exposure(await svc.Customer.findById(ctx.limited._id).lean(), ctx.limited._id, {});
  assert.equal(exposure, 0, "nothing is owed");
  // a sale below the limit passes; before, the stored balance made every sale breach
  await svc.Config.updateSettings({ creditControl: { mode: "block" } });
  try {
    const ok = await sale(ctx.limited, 5, 100, "2024-07-01"); // 525 against a limit of 1,000
    assert.equal(ok.status, "APPROVED");
    const exposureAfter = await svc.Credit.exposure(await svc.Customer.findById(ctx.limited._id).lean(), ctx.limited._id, {});
    assert.equal(exposureAfter, -525, "owes 525 (negative is what evaluate() reads)");
    await assert.rejects(() => sale(ctx.limited, 6, 100, "2024-07-02"), { code: "RISK_LIMIT_BLOCKED" }); // 525 + 630 > 1,000
  } finally {
    await svc.Config.updateSettings({ creditControl: { mode: "off" } });
  }
});

// ================================================================================== presentation
test("sales discounts reduce revenue (IFRS 15.47) and gross profit follows; net profit is unchanged", { skip }, async () => {
  const sd = await svc.LedgerAccount.findOne({ accountName: "Sales Discounts Given" });
  await buy(100, 10, "2024-08-01");
  await sale(ctx.customer, 10, 100, "2024-08-10", { line: { discountAmount: 100 } }); // 1,000 gross, 100 off: 900 net
  const pl = await svc.Reports.profitAndLoss({ from: "2024-08-01", to: "2024-08-31" });
  assert.equal(pl.revenue.total, 900, "revenue is what the customer was charged");
  const group = pl.revenue.groups.find((g) => g.groupId === "sales-discounts");
  assert.equal(group.total, -100);
  assert.equal(pl.operatingExpenses.groups.flatMap((g) => g.accounts).some((a) => String(a.accountId) === String(sd._id)), false, "and the discount is no longer an expense");
  assert.equal(pl.grossProfit, 900 - pl.directCosts.total);
  // the IFRS statement reads the same
  const ifrs = await svc.Ifrs.profitOrLoss({ from: "2024-08-01", to: "2024-08-31", compare: "none" });
  assert.equal(ifrs.revenue.amount, 900);
});

test("the legacy balance sheet shows a bank in credit as an overdraft and finds the closed year on any host", { skip }, async () => {
  const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
  const bank = await svc.Chart.createAccount({ accountName: "Review Bank", groupId: bankGroup._id }, {}, admin);
  await svc.Financial.createVoucher({
    voucherType: "journal", date: at("2024-09-05"), narration: "Rent paid from an empty account",
    lines: [{ accountId: ctx.rent._id, debit: 300 }, { accountId: bank._id, credit: 300 }],
  }, admin);
  const bs = await svc.Financial.getBalanceSheet("2024-09-30");
  assert.equal(bs.assets.some((a) => a.accountName === "Review Bank"), false, "not a negative asset");
  const od = bs.liabilities.find((a) => a.accountName === "Review Bank");
  assert.deepEqual([od.groupName, od.amount], ["Bank overdrafts", 300]);
  assert.equal(bs.isBalanced, true);

  // a year closed on the last day: "2024-12-31T23:59:59.999" with no zone is the organisation's wall clock on any host
  const [from, to] = [new Date("2023-12-31T20:00:00.000Z"), new Date("2024-12-31T19:59:59.999Z")];
  await svc.FiscalYear.create({ code: "2024", name: "2024", startDate: from, endDate: to, status: "open" });
  try {
    const last = await svc.Financial.getBalanceSheet("2024-12-31T23:59:59.999");
    assert.equal(last.isBalanced, true);
    const year = await svc.FiscalYear.findOne({ code: "2024" }).lean();
    assert.ok(year, "the year exists");
    // profit to date is the year's own profit, not zero because the day was read as 1 January of the next year
    const tb = await svc.Financial.getTrialBalance(year.startDate, "2024-12-31T23:59:59.999");
    const income = tb.trialBalance.filter((a) => a.category === "INCOME").reduce((t, a) => t + a.balance, 0);
    const expense = tb.trialBalance.filter((a) => a.category === "EXPENSE").reduce((t, a) => t + a.balance, 0);
    assert.equal(last.profitToDate, r2(income - expense));
  } finally {
    await svc.FiscalYear.deleteMany({});
  }
});

test("a range that runs backwards, or a day that does not exist, is refused", { skip }, async () => {
  await assert.rejects(() => svc.Reports.generalLedger({ from: "2024-09-30", to: "2024-09-01" }), { code: "INVALID_RANGE" });
  await assert.rejects(() => svc.Reports.profitAndLoss({ from: "2024-02-30", to: "2024-03-31" }), { code: "INVALID_DATE" });
  assert.throws(() => svc.Reports.dayStart("2024-00-10"), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Reports.cashFlow({ from: "2024-09-30", to: "2024-09-01" }), { code: "INVALID_RANGE" });
});

// ================================================================================== VAT return
test("the VAT return says when it assumed Dubai, and is saved only from the whole-organisation view", { skip }, async () => {
  const first = await svc.Vat.compute({ from: "2024-08-01", to: "2024-08-31" });
  assert.deepEqual([first.emirate, first.emirateAssumed], ["Dubai", true], "no emirate in the profile: assumed, and said");
  await svc.Config.updateSettings({ profile: { emirate: "Sharjah", legalName: "Review Trading LLC", trn: "100123456789012" } });
  const set = await svc.Vat.compute({ from: "2024-08-01", to: "2024-08-31" });
  assert.deepEqual([set.emirate, set.emirateAssumed], ["Sharjah", false]);

  // a branch view is one slice of the organisation: it must not be saved as the return
  await assert.rejects(
    () => svc.tenant.runWithTenant({ companyId: "default", branchId: "main", branchView: "main" }, () => svc.Vat.createDraft({ from: "2024-08-01", to: "2024-08-31" }, admin)),
    { code: "ALL_BRANCHES_REQUIRED" }
  );
  const draft = await svc.Vat.createDraft({ from: "2024-08-01", to: "2024-08-31" }, admin);
  assert.equal(draft.status, "DRAFT");
});

test("a finalised return shows what has changed in its period since", { skip }, async () => {
  const draft = await svc.Vat.createDraft({ from: "2024-10-01", to: "2024-10-31" }, admin);
  const done = await svc.Vat.finalize(draft._id, admin, { allowUnclassified: true });
  assert.equal(done.status, "FINALIZED");
  assert.equal((await svc.Vat.get(done._id)).changedSince, null, "nothing has moved yet");
  // an expense with VAT dated inside the period, posted afterwards (a bank fee found on a statement)
  await svc.Financial.createVoucher({
    voucherType: "expense", ledgerBased: true, expenseAccountId: ctx.rent._id, amount: 100, taxCodeId: ctx.std._id,
    description: "Bank fee found later", paymentMode: "cash", date: at("2024-10-20"),
  }, admin);
  const changed = (await svc.Vat.get(done._id)).changedSince;
  assert.equal(changed.recoverableVat, 5, "5 of input VAT that the filed return does not have");
  assert.equal(changed.netPayable, -5);
});

// ================================================================================== dashboard
test("the dashboard compares a year with the year before, and a quarter with the quarter before", { skip }, async () => {
  const p = (from, to) => svc.Dashboard.resolvePeriod({ from, to }, "2026-10-10");
  // the year so far against the same days of last year (it used to be compared with the 283 days before 1 January)
  let r = p("2026-01-01", "2026-10-09");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2025-01-01", "2025-10-09"]);
  // a quarter against the quarter before it, across a year end too
  r = p("2026-01-01", "2026-03-31");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2025-10-01", "2025-12-31"]);
  r = p("2026-04-01", "2026-06-30");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2026-01-01", "2026-03-31"]);
  // a whole calendar year
  r = p("2025-01-01", "2025-12-31");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2024-01-01", "2024-12-31"]);
  // a quarter so far (the screen sends the quarter's first day to a day not yet reached): the same stretch of the quarter before
  r = p("2026-10-01", "2026-12-31");
  assert.deepEqual([r.id, r.to, r.previousFrom, r.previousTo], ["custom", "2026-10-10", "2026-07-01", "2026-07-10"]);
  // a stretch from a month or quarter start that is not a whole one keeps the contract: the same number of days just before
  r = p("2026-10-01", "2026-10-10");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2026-09-21", "2026-09-30"], "ten days, so the ten days before");
  r = p("2026-03-01", "2026-03-31");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2026-01-29", "2026-02-28"]);
  // anything else: the same number of days just before
  r = p("2026-02-10", "2026-02-19");
  assert.deepEqual([r.previousFrom, r.previousTo], ["2026-01-31", "2026-02-09"]);
  // a day that does not exist is refused, not read as the next one
  assert.throws(() => p("2026-02-01", "2026-02-30"), { code: "INVALID_PERIOD" });
  assert.throws(() => p("2026-00-10", "2026-10-09"), { code: "INVALID_PERIOD" });
});

test("the dashboard's VAT trend does not show the settlement journal as negative output VAT", { skip }, async () => {
  const outVat = await svc.LedgerAccount.findOne({ accountName: "Output VAT" });
  const bank = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" });
  // the quarter's VAT is paid: Dr Output VAT, Cr cash, by journal (the documents above created the output VAT)
  const owed = await svc.Reports.accountMovements({ to: "2024-12-31", accountIds: [outVat._id] });
  const credit = owed[0].periodCredit;
  await svc.Financial.createVoucher({ voucherType: "journal", date: at("2024-11-05"), narration: "VAT paid to the FTA", lines: [{ accountId: outVat._id, debit: credit }, { accountId: bank._id, credit }] }, admin);
  const Q = require("../reports/dashboardQueries");
  const series = await Q.accountMonthly("vat-sales", ["2024-08", "2024-11"], "2024-11-30", "credit", { excludeJournals: true });
  assert.ok(series.values[1] >= 0, "November holds only what the documents made, not the payment");
  const raw = await Q.accountMonthly("vat-sales", ["2024-08", "2024-11"], "2024-11-30", "credit");
  assert.equal(raw.values[1], -credit, "the ledger's own movement is the payment (what the old trend showed)");
});
