// Currency master, exchange rates, and foreign-currency receipts / payments (phase 1): the ledger
// stays in AED, a foreign voucher is converted once at the master rate, and everything downstream
// (payment modes, cheques, cards, allocation, reversal) runs on the AED amount. Throwaway database;
// see bankingAndVouchers.test.js.
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { dubaiDay, dubaiDayStart } = require("../../utils/fx");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();

let svc;
let customer;
let vendor;
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Cheques: require("../banking/chequeService"),
    Chart: require("../financial/chartOfAccountsService"),
    Currencies: require("../financial/currencyService"),
    Fx: require("../financial/fxVoucherService"),
    ...require("../banking/cardService"),
    ...require("../../models/modules/banking/bankingModels"),
    ...require("../../models/modules/financial/financialModels"),
    ...require("../../models/modules/financial/currencyModels"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault(); // an account must belong to an organisation that exists, as the server arranges at start-up
  await svc.seed({ log: () => {} });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6 });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- helpers -------------------------------------------------------------------------------
const r2 = (n) => Math.round(n * 100) / 100;
const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
const balance = async (name) => r2((await acct(name))?.currentBalance ?? 0);
const day = (n = 0) => new Date(Date.now() + n * 86400000);
const ymd = (n = 0) => dubaiDay(day(n));
const receipt = (extra) => svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: day(), ...extra }, admin);
const payment = (extra) => svc.Financial.createVoucher({ voucherType: "payment", vendorId: vendor._id, totalAmount: 100, date: day(), ...extra }, admin);
const live = async (voucher) => (await svc.LedgerEntry.find({ voucherId: voucher._id, isReversed: { $ne: true } }).lean());
const legs = async (voucher) => (await live(voucher)).map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`);
const entry = async (voucher, name) => (await svc.LedgerEntry.find({ voucherId: voucher._id, accountName: name, isReversed: { $ne: true } }).lean())[0];

// ---- the master ----------------------------------------------------------------------------
test("the base currency is seeded once: AED is active, rate 1, locked; the starter list is switched off with no rates", { skip }, async () => {
  const list = await svc.Currencies.list({});
  assert.deepEqual(list.map((c) => c.code), ["AED", "BHD", "EUR", "GBP", "INR", "KWD", "OMR", "QAR", "SAR", "USD"], "base first, then the rest by code");
  const aed = list[0];
  assert.equal(aed.isBase, true);
  assert.equal(aed.isActive, true);
  assert.equal(aed.latestRate, 1);
  for (const c of list.slice(1)) {
    assert.equal(c.isActive, false, `${c.code} starts switched off`);
    assert.equal(c.latestRate, null);
    assert.equal(c.rateCount, 0);
  }
  assert.equal(list.find((c) => c.code === "KWD").decimals, 3, "dinars have three decimals");
  assert.equal(list.filter((c) => c.isBase).length, 1);

  await svc.Currencies.list({});
  assert.equal(await svc.Currency.countDocuments({}), 10, "listing again does not seed again");

  await assert.rejects(() => svc.Currencies.update("AED", { isActive: false }, {}), { code: "BASE_CURRENCY_LOCKED" });
  await assert.rejects(() => svc.Currencies.update("AED", { name: "Dirham" }, {}), { code: "BASE_CURRENCY_LOCKED" });
  await assert.rejects(() => svc.Currencies.remove("AED", {}), { code: "BASE_CURRENCY_LOCKED" });
  await assert.rejects(() => svc.Currencies.addRate("AED", { rate: 1.1 }, {}), { code: "BASE_CURRENCY_NO_RATE" });
  assert.equal((await svc.Currencies.rateOn("AED", new Date())).rate, 1, "the base currency is always 1");
  assert.deepEqual(await svc.Currencies.getSettings({}), { baseCurrency: "AED", fxTolerancePercent: 5 });
});

test("currency validation: three-letter ISO code, name, decimals, no duplicates", { skip }, async () => {
  await assert.rejects(() => svc.Currencies.create({ code: "US", name: "x" }, {}), { code: "INVALID_CURRENCY_CODE" });
  await assert.rejects(() => svc.Currencies.create({ code: "US1", name: "x" }, {}), { code: "INVALID_CURRENCY_CODE" });
  await assert.rejects(() => svc.Currencies.create({ code: "JOD", name: "  " }, {}), { code: "NAME_REQUIRED" });
  await assert.rejects(() => svc.Currencies.create({ code: "JOD", name: "Jordanian Dinar", decimals: 5 }, {}), { code: "INVALID_DECIMALS" });
  await assert.rejects(() => svc.Currencies.create({ code: "JOD", name: "Jordanian Dinar", decimals: 1.5 }, {}), { code: "INVALID_DECIMALS" });
  await assert.rejects(() => svc.Currencies.create({ code: "usd", name: "Dollar again" }, {}), { code: "DUPLICATE_CURRENCY" });
  await assert.rejects(() => svc.Currencies.update("ZZZ", { name: "x" }, {}), { code: "CURRENCY_NOT_FOUND" });

  const jod = await svc.Currencies.create({ code: "jod", name: "Jordanian Dinar", symbol: "JD", decimals: 3 }, {});
  assert.equal(jod.code, "JOD", "stored upper-case");
  assert.equal(jod.isActive, true, "a currency you add is ready to use");
  assert.equal(jod.isBase, false);

  const off = await svc.Currencies.update("JOD", { isActive: false }, {});
  assert.equal(off.isActive, false);
  assert.ok(await svc.ActivityLog.findOne({ action: "CURRENCY_DISABLED", summary: /JOD/ }));
  await svc.Currencies.update("JOD", { isActive: true, name: "Jordan Dinar" }, {});
});

test("rate validation: positive, at most six decimals, real calendar day, known source", { skip }, async () => {
  await svc.Currencies.update("USD", { isActive: true }, {});
  const add = (extra) => svc.Currencies.addRate("USD", { rate: 3.6725, effectiveDate: ymd(-90), ...extra }, {});
  for (const bad of [0, -3.6, "abc", "", null, undefined, NaN, Infinity]) {
    await assert.rejects(() => add({ rate: bad }), { code: "INVALID_RATE" }, `rate ${String(bad)}`);
  }
  await assert.rejects(() => add({ rate: 3.6725001 }), { code: "INVALID_RATE" }, "seven decimals");
  await assert.rejects(() => add({ rate: 1e9 }), { code: "INVALID_RATE" });
  await assert.rejects(() => add({ effectiveDate: "2026-02-30" }), { code: "INVALID_DATE" });
  await assert.rejects(() => add({ effectiveDate: "not a date" }), { code: "INVALID_DATE" });
  await assert.rejects(() => add({ source: "bloomberg" }), { code: "INVALID_SOURCE" });
  await assert.rejects(() => svc.Currencies.addRate("ZZZ", { rate: 1 }, {}), { code: "CURRENCY_NOT_FOUND" });
  assert.equal(await svc.ExchangeRate.countDocuments({}), 0, "nothing was recorded by any refused attempt");

  const ok = await add({ rate: 3.123456, effectiveDate: ymd(-90), source: "import", note: "opening load" });
  assert.equal(ok.rate, 3.123456, "six decimals are kept");
  assert.equal(ok.source, "import");
  assert.equal(ok.effectiveDay, ymd(-90));
  assert.equal(ok.replaced, false);
});

test("rates are looked up as of the day: a rate holds until the next one, none before the first is NO_RATE", { skip }, async () => {
  const first = ymd(-40); // "the 1st"
  const later = ymd(-20);
  await svc.Currencies.addRate("USD", { rate: 3.6, effectiveDate: first, source: "cbuae" }, {});
  await svc.Currencies.addRate("USD", { rate: 3.65, effectiveDate: later }, {});
  const on = (n) => svc.Currencies.rateOn("USD", ymd(n));

  assert.equal((await on(-40)).rate, 3.6, "on the day itself");
  assert.equal((await on(-30)).rate, 3.6, "set on the 1st, used on the 15th");
  assert.equal((await on(-21)).rate, 3.6);
  assert.equal((await on(-20)).rate, 3.65, "the next rate takes over on its own day");
  assert.equal((await on(0)).rate, 3.65);
  assert.equal((await on(-30)).rateDay, first);
  assert.equal((await on(-30)).source, "cbuae");

  // the rate dated ymd(-90) from the validation test is older than both
  assert.equal((await on(-89)).rate, 3.123456);
  const beforeAll = ymd(-91);
  await assert.rejects(() => svc.Currencies.rateOn("USD", beforeAll), (e) => {
    assert.equal(e.code, "NO_RATE");
    assert.equal(e.statusCode, 422);
    const [y, m, d] = beforeAll.split("-");
    assert.equal(e.message, `No USD rate on or before ${d}/${m}/${y}. Add one under Currencies.`);
    return true;
  });
  await assert.rejects(() => svc.Currencies.rateOn("EUR", new Date()), { code: "NO_RATE" }, "a currency with no rates never answers 1");

  // a Dubai calendar day: 21:30 UTC is 01:30 the next day in Dubai
  const edge = dubaiDayStart(later).getTime();
  assert.equal((await svc.Currencies.rateOn("USD", new Date(edge - 30 * 60000))).rate, 3.6, "23:30 Dubai the evening before");
  assert.equal((await svc.Currencies.rateOn("USD", new Date(edge + 30 * 60000))).rate, 3.65, "00:30 Dubai on the day");
  assert.equal((await svc.Currencies.rateOn("USD", later)).rate, 3.65, "a plain YYYY-MM-DD is that calendar day");

  await assert.rejects(() => svc.Currencies.rateOn("USD", "garbage"), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Currencies.rateOn("US", new Date()), { code: "INVALID_CURRENCY_CODE" });
});

test("a rate for a day already recorded replaces it and the old value goes to the audit log; a future rate waits", { skip }, async () => {
  const d = ymd(-20);
  const again = await svc.Currencies.addRate("USD", { rate: 3.66, effectiveDate: d, note: "corrected" }, { admin: { id: String(admin) } });
  assert.equal(again.replaced, true);
  assert.equal(again.previousRate, 3.65);
  assert.equal(await svc.ExchangeRate.countDocuments({ code: "USD", effectiveDate: dubaiDayStart(d) }), 1, "still one row for that day");
  assert.equal((await svc.Currencies.rateOn("USD", d)).rate, 3.66);

  const log = await svc.ActivityLog.findOne({ action: "EXCHANGE_RATE_REPLACED", entity: "ExchangeRate" });
  assert.ok(log, "the correction is audited");
  assert.equal(log.before.rate, 3.65);
  assert.equal(log.after.rate, 3.66);
  assert.ok(await svc.ActivityLog.findOne({ action: "EXCHANGE_RATE_ADDED" }));

  // put it back the way the later tests expect, and add the rate vouchers of "today" will use
  await svc.Currencies.addRate("USD", { rate: 3.65, effectiveDate: d }, {});
  await svc.Currencies.addRate("USD", { rate: 3.6725, effectiveDate: ymd(-3), source: "cbuae" }, {});
  const future = await svc.Currencies.addRate("USD", { rate: 3.9, effectiveDate: ymd(5) }, {});
  assert.equal(future.replaced, false);
  assert.equal((await svc.Currencies.rateOn("USD", new Date())).rate, 3.6725, "a rate dated in the future is not used yet");
  assert.equal((await svc.Currencies.rateOn("USD", ymd(5))).rate, 3.9);

  const history = await svc.Currencies.rateHistory("USD", {});
  assert.deepEqual(history.map((r) => r.effectiveDay), [ymd(5), ymd(-3), ymd(-20), ymd(-40), ymd(-90)], "newest first");
  assert.equal(history.length, 5);
  const ranged = await svc.Currencies.rateHistory("USD", {}, { from: ymd(-40), to: ymd(-20) });
  assert.deepEqual(ranged.map((r) => r.rate), [3.65, 3.6]);

  const usd = (await svc.Currencies.list({})).find((c) => c.code === "USD");
  assert.equal(usd.latestRate, 3.6725, "the list shows the rate that applies today");
  assert.equal(usd.latestRateDate, ymd(-3));
  assert.equal(usd.rateCount, 5);
});

// ---- foreign receipts -----------------------------------------------------------------------
test("a USD cash receipt posts in AED at the master rate, with the foreign amount stamped on the money leg", { skip }, async () => {
  const cashBefore = await balance("Cash in Hand");
  // the AED total the form sent (100) is ignored: the server converts
  const r = await receipt({ currency: "USD", foreignAmount: 1000, paymentMode: "cash" });

  assert.equal(r.totalAmount, 3672.5);
  assert.equal(r.currency, "USD");
  assert.equal(r.exchangeRate, 3.6725);
  assert.equal(r.foreignAmount, 1000);
  assert.equal(r.rateSource, "cbuae");
  assert.equal(dubaiDay(r.rateDate), ymd(-3), "the day of the master rate it came from");
  assert.ok(!r.rateOverridden);
  assert.deepEqual((await legs(r)).sort(), ["Cash in Hand:Dr3672.5", "Customer Advance - Al Noor:Cr3672.5"].sort());
  assert.equal(await balance("Cash in Hand"), r2(cashBefore + 3672.5), "the cash account is an AED account and moves by the AED amount");

  const cash = await entry(r, "Cash in Hand");
  assert.equal(cash.currency, "USD");
  assert.equal(cash.exchangeRate, 3.6725);
  assert.equal(cash.amountForeign, 1000);
  assert.equal(cash.debitAmount, 3672.5, "the ledger amount itself is AED");
  const party = await entry(r, "Customer Advance - Al Noor");
  assert.equal(party.currency, undefined, "only the money side is stamped");
  assert.equal(party.amountForeign, undefined);

  // an AED receipt is untouched by all of this
  const plain = await receipt({ paymentMode: "cash" });
  assert.equal(plain.currency, "AED");
  assert.equal(plain.exchangeRate, 1);
  assert.equal(plain.foreignAmount, undefined);
  assert.equal(plain.totalAmount, 100);
  assert.equal((await entry(plain, "Cash in Hand")).amountForeign, undefined);
  // naming AED with stray foreign fields: they are ignored, not stored
  const stray = await receipt({ currency: "AED", foreignAmount: 5, exchangeRate: 9, paymentMode: "cash" });
  assert.equal(stray.foreignAmount, undefined);
  assert.equal(stray.totalAmount, 100);
});

test("a foreign voucher is refused without a usable currency, amount or rate", { skip }, async () => {
  await assert.rejects(() => receipt({ currency: "ZZZ", foreignAmount: 10, paymentMode: "cash" }), { code: "CURRENCY_NOT_FOUND" });
  await assert.rejects(() => receipt({ currency: "usd1", foreignAmount: 10, paymentMode: "cash" }), { code: "INVALID_CURRENCY_CODE" });
  await assert.rejects(() => receipt({ currency: "EUR", foreignAmount: 10, paymentMode: "cash" }), { code: "CURRENCY_INACTIVE" }, "switched off");
  await svc.Currencies.update("EUR", { isActive: true }, {});
  await assert.rejects(() => receipt({ currency: "EUR", foreignAmount: 10, paymentMode: "cash" }), { code: "NO_RATE" }, "enabled but no rate: never a silent 1");
  await assert.rejects(() => receipt({ currency: "EUR", foreignAmount: 10, exchangeRate: 4, paymentMode: "cash" }), { code: "NO_RATE" }, "a typed rate with nothing to check it against is refused too");

  for (const bad of [undefined, 0, -5, "", "x"]) {
    await assert.rejects(() => receipt({ currency: "USD", foreignAmount: bad, paymentMode: "cash" }), { code: "FOREIGN_AMOUNT_REQUIRED" }, `amount ${String(bad)}`);
  }
  await assert.rejects(() => receipt({ currency: "USD", foreignAmount: 10.005, paymentMode: "cash" }), { code: "INVALID_AMOUNT" }, "USD has two decimals");
  await assert.rejects(() => receipt({ currency: "USD", foreignAmount: 0.001, paymentMode: "cash" }), { code: "INVALID_AMOUNT" }, "too small for 0.01 AED");

  // the failed attempts left nothing behind
  const strays = await svc.Voucher.countDocuments({ currency: { $in: ["ZZZ", "EUR"] } });
  assert.equal(strays, 0);

  // a currency with three decimals takes three, and rounds the AED value half up
  await svc.Currencies.update("KWD", { isActive: true }, {});
  await svc.Currencies.addRate("KWD", { rate: 11.95, effectiveDate: ymd(-3) }, {});
  const k = await receipt({ currency: "KWD", foreignAmount: 10.5, paymentMode: "cash" });

  assert.equal(k.totalAmount, 125.48, "10.500 KWD x 11.95 = 125.475 -> 125.48");
  await assert.rejects(() => receipt({ currency: "KWD", foreignAmount: 10.5555, paymentMode: "cash" }), { code: "INVALID_AMOUNT" });
});

test("only receipts and payments take a foreign currency: other vouchers refuse one rather than post it as AED", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const lines = [{ accountId: rent._id, debit: 10 }, { accountId: cash._id, credit: 10 }];
  const journal = (extra) => svc.Financial.createVoucher({ voucherType: "journal", date: day(), lines, ...extra }, admin);
  await assert.rejects(() => journal({ currency: "USD" }), { code: "FOREIGN_CURRENCY_NOT_SUPPORTED" });
  await assert.rejects(() => journal({ foreignAmount: 10 }), { code: "FOREIGN_CURRENCY_NOT_SUPPORTED" });
  await assert.rejects(
    () => svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 5, description: "x", paymentMode: "cash", currency: "USD", date: day() }, admin),
    { code: "FOREIGN_CURRENCY_NOT_SUPPORTED" }
  );
  const ok = await journal({ currency: "AED" }); // naming the base currency is fine
  assert.equal(ok.totalAmount, 10);
  await assert.rejects(() => svc.Financial.updateVoucher(ok._id, { currency: "USD", forceUpdate: true }, admin), { code: "FOREIGN_CURRENCY_NOT_SUPPORTED" });
});

test("rate tolerance: a typed rate near the master passes, a distant one needs a reason, the reason is kept", { skip }, async () => {
  const usd = (extra) => receipt({ currency: "USD", foreignAmount: 100, paymentMode: "cash", ...extra });

  const equal = await usd({ exchangeRate: 3.6725 });
  assert.equal(equal.rateSource, "cbuae", "the master's own rate keeps the master's source");


  const near = await usd({ exchangeRate: 3.7 }); // 0.75% away

  assert.equal(near.exchangeRate, 3.7);
  assert.equal(near.totalAmount, 370);
  assert.equal(near.rateSource, "voucher", "typed on the voucher");
  assert.ok(!near.rateOverridden, "inside the tolerance: no override");

  await assert.rejects(() => usd({ exchangeRate: 3.9 }), (e) => {
    assert.equal(e.code, "RATE_OUT_OF_TOLERANCE");
    assert.equal(e.statusCode, 422);
    assert.equal(e.details.masterRate, 3.6725);
    assert.equal(e.details.tolerancePercent, 5);
    assert.match(e.message, /6\.19% away/);
    return true;
  });
  await assert.rejects(() => usd({ exchangeRate: 3.9, rateOverrideReason: "  " }), { code: "RATE_OUT_OF_TOLERANCE" });
  await assert.rejects(() => usd({ exchangeRate: 3.9, rateOverrideReason: "x" }), { code: "RATE_OUT_OF_TOLERANCE" });

  const over = await usd({ exchangeRate: 3.9, rateOverrideReason: "Agreed with customer on the phone" });

  assert.equal(over.rateOverridden, true);
  assert.equal(over.rateOverrideReason, "Agreed with customer on the phone");
  assert.equal(over.totalAmount, 390);
  assert.equal((await entry(over, "Cash in Hand")).exchangeRate, 3.9);

  await assert.rejects(() => usd({ exchangeRate: 0 }), { code: "INVALID_RATE" });
  await assert.rejects(() => usd({ exchangeRate: -1 }), { code: "INVALID_RATE" });
  await assert.rejects(() => usd({ exchangeRate: 3.6725001 }), { code: "INVALID_RATE" });

  // the tolerance is a company setting
  await assert.rejects(() => svc.Currencies.updateSettings({ fxTolerancePercent: -1 }, {}), { code: "INVALID_TOLERANCE" });
  await assert.rejects(() => svc.Currencies.updateSettings({ fxTolerancePercent: 101 }, {}), { code: "INVALID_TOLERANCE" });
  await assert.rejects(() => svc.Currencies.updateSettings({ fxTolerancePercent: "abc" }, {}), { code: "INVALID_TOLERANCE" });
  assert.equal((await svc.Currencies.updateSettings({ fxTolerancePercent: 10 }, {})).fxTolerancePercent, 10);
  const wide = await usd({ exchangeRate: 3.9 }); // 6.2% is now inside

  assert.ok(!wide.rateOverridden);
  await svc.Currencies.updateSettings({ fxTolerancePercent: 0 }, {});
  await assert.rejects(() => usd({ exchangeRate: 3.673 }), { code: "RATE_OUT_OF_TOLERANCE" }, "0% allows no difference at all");
  assert.equal((await svc.Currencies.updateSettings({ fxTolerancePercent: 5 }, {})).fxTolerancePercent, 5);
  assert.ok(await svc.ActivityLog.findOne({ action: "FX_SETTINGS_UPDATED" }));
});

test("a USD cheque posts to cheques-in-hand in AED, is recorded with its foreign value, and clears at the same AED value", { skip }, async () => {
  const bank = await acct("Bank Account");
  const bankBefore = await balance("Bank Account");
  const r = await receipt({
    currency: "USD", foreignAmount: 500, paymentMode: "cheque",
    paymentDetails: { chequeNo: "USD-001", chequeDate: day(), drawnOnBankName: "Citibank", accountId: bank._id },
  });

  assert.equal(r.totalAmount, 1836.25);
  assert.ok((await legs(r)).includes("Cheques in Hand:Dr1836.25"));
  const pdc = await entry(r, "Cheques in Hand");
  assert.equal(pdc.currency, "USD");
  assert.equal(pdc.amountForeign, 500);
  assert.equal(await balance("Bank Account"), bankBefore, "not in the bank yet");

  const row = await svc.Cheque.findOne({ voucherId: r._id });
  assert.equal(row.amount, 1836.25, "the register's amount stays AED");
  assert.equal(row.currency, "USD");
  assert.equal(row.foreignAmount, 500);
  assert.equal(row.exchangeRate, 3.6725);

  await svc.Cheques.clear(row._id, {}, {}, admin);
  assert.equal(await balance("Cheques in Hand"), 0);
  assert.equal(await balance("Bank Account"), r2(bankBefore + 1836.25));
  const clearing = await svc.LedgerEntry.find({ voucherId: r._id, voucherType: "cheque_clearance" }).lean();
  assert.equal(clearing.length, 2);
  assert.ok(clearing.every((e) => e.currency === "USD" && e.amountForeign === 500), "the clearing entries carry the foreign value too");

  // a cheque that bounces is reversed in full, stamps included
  const r2nd = await receipt({
    currency: "USD", foreignAmount: 100, paymentMode: "cheque",
    paymentDetails: { chequeNo: "USD-002", chequeDate: day(), drawnOnBankName: "Citibank", accountId: bank._id },
  });
  const row2 = await svc.Cheque.findOne({ voucherId: r2nd._id });
  await svc.Cheques.bounce(row2._id, { reason: "Insufficient funds" }, {}, admin);
  assert.equal(await balance("Cheques in Hand"), 0);
  const v2 = await svc.Voucher.findById(r2nd._id);
  assert.equal(v2.status, "bounced");
  assert.equal(v2.foreignAmount, 100, "the foreign fields stay on a bounced voucher");
});

test("a USD card receipt: the terminal's fee is worked on the AED amount and the legs still add to it", { skip }, async () => {
  const bank = await acct("Bank Account");
  const visa = await svc.CardTypeService.create({ name: "Visa", feePercent: 2.5 }, {});
  const pos = await svc.CardService.create({ label: "POS 1", kind: "terminal", cardTypeId: visa._id, accountId: bank._id, terminalId: "T-001" }, {}, admin);
  const before = await balance("Bank Account");
  const r = await receipt({ currency: "USD", foreignAmount: 200, paymentMode: "card", paymentDetails: { cardId: pos._id, approvalCode: "A1B2C3" } });

  assert.equal(r.totalAmount, 734.5);
  // 2.5% of 734.50 = 18.3625 -> 18.36; the bank gets 716.14
  assert.deepEqual((await legs(r)).sort(), ["Bank Account:Dr716.14", "Card Processing Fees:Dr18.36", "Customer Advance - Al Noor:Cr734.5"].sort());
  assert.equal(r.paymentDetails.cardFee, 18.36);
  assert.equal(await balance("Bank Account"), r2(before + 716.14));
  const stamped = (await live(r)).filter((e) => e.currency === "USD");
  assert.equal(stamped.length, 2, "both money-side legs");
  assert.equal(r2(stamped.reduce((t, e) => t + e.amountForeign, 0)), 200, "their foreign shares add back to the amount received");
});

test("a USD receipt settles AED invoices in AED: allocation is checked against the AED amount, the rest stays on account", { skip }, async () => {
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: stock._id, description: "Rice", qty: 200, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
  const sale = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty: 100, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(sale._id, "approve", "t");
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 1050);

  // USD 100 = AED 367.25: allocating 400 AED is more than the receipt
  await assert.rejects(
    () => receipt({ currency: "USD", foreignAmount: 100, paymentMode: "cash", linkedInvoices: [{ invoiceId: sale._id, amount: 400, balance: 650 }] }),
    /Allocated amount cannot exceed total amount/
  );
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 1050, "the refused voucher touched nothing");

  const onAccountBefore = (await svc.Customer.findById(customer._id)).cashBalance || 0;
  const r = await receipt({ currency: "USD", foreignAmount: 200, paymentMode: "cash", linkedInvoices: [{ invoiceId: sale._id, amount: 600, balance: 450 }] });

  assert.equal(r.totalAmount, 734.5);
  assert.equal(r.linkedInvoices[0].allocatedAmount, 600);
  assert.equal(r2(r.onAccountAmount), 134.5, "734.50 received, 600.00 against the invoice, the rest on account");
  const inv = await svc.Transaction.findById(sale._id);
  assert.equal(inv.outstandingAmount, 450);
  assert.equal(inv.paidAmount, 600);
  assert.equal(inv.status, "APPROVED");
  assert.equal(r2((await svc.Customer.findById(customer._id)).cashBalance - onAccountBefore), 134.5);

  // deleting it reverses everything, in AED, and keeps the foreign record
  const cashBefore = await balance("Cash in Hand");
  await svc.Financial.deleteVoucher(r._id, admin);
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 1050, "the invoice is open again");
  assert.equal(await balance("Cash in Hand"), r2(cashBefore - 734.5));
  const dead = await svc.Voucher.findById(r._id);
  assert.equal(dead.status, "cancelled");
  assert.equal(dead.foreignAmount, 200);
  assert.equal(dead.currency, "USD");
  const all = await svc.LedgerEntry.find({ voucherId: r._id, accountName: "Cash in Hand" }).lean();
  assert.equal(all.length, 2, "the entry and its reversal");
  assert.ok(all.every((e) => e.currency === "USD" && e.amountForeign === 200), "the reversal carries the same stamp");
  assert.equal(r2(all.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 0);
  assert.equal(r2((await svc.Customer.findById(customer._id)).cashBalance), r2(onAccountBefore), "the on-account balance is put back");

  // a settled-then-reopened invoice can be paid again, now by a USD receipt allocated in full
  const again = await receipt({ currency: "USD", foreignAmount: 300, paymentMode: "cash", linkedInvoices: [{ invoiceId: sale._id, amount: 1050, balance: 0 }] });

  assert.equal(again.totalAmount, 1101.75);
  assert.equal(r2(again.onAccountAmount), 51.75);
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 0);
});

// ---- foreign payments -----------------------------------------------------------------------
test("a USD payment to a vendor credits the bank in AED; a credit-card limit is judged in AED", { skip }, async () => {
  const bankBefore = await balance("Bank Account");
  const p = await payment({ currency: "USD", foreignAmount: 500, paymentMode: "bank" });

  assert.equal(p.totalAmount, 1836.25);
  assert.deepEqual((await legs(p)).sort(), ["Bank Account:Cr1836.25", "Advance to Vendor - Gulf Mills:Dr1836.25"].sort());
  assert.equal(await balance("Bank Account"), r2(bankBefore - 1836.25));
  const bank = await entry(p, "Bank Account");
  assert.equal(bank.currency, "USD");
  assert.equal(bank.amountForeign, 500);
  assert.equal(p.partyType, "Vendor");

  // against the vendor's invoice
  const buy = await svc.Transaction.findOne({ type: "purchase_order", partyId: vendor._id });
  const against = await payment({ currency: "USD", foreignAmount: 300, paymentMode: "bank", linkedInvoices: [{ invoiceId: buy._id, amount: 1101.75, balance: r2(buy.outstandingAmount - 1101.75) }] });

  assert.equal((await svc.Transaction.findById(buy._id)).paidAmount, 1101.75);

  // the company card has a limit in AED; USD 1,000 = AED 3,672.50 fits, a further USD 500 does not
  const amex = await svc.CardService.create({ label: "Company Amex", kind: "credit", cardTypeId: (await svc.CardType.findOne({ name: "Visa" }))._id, holderName: "Boss", last4: "4242", creditLimit: 5000 }, {}, admin);
  const onCard = await payment({ currency: "USD", foreignAmount: 1000, paymentMode: "card", paymentDetails: { cardId: amex._id } });

  assert.ok((await legs(onCard)).includes("Credit Card - Company Amex:Cr3672.5"));
  await assert.rejects(() => payment({ currency: "USD", foreignAmount: 500, paymentMode: "card", paymentDetails: { cardId: amex._id } }), { code: "CARD_LIMIT_EXCEEDED" });
});

// ---- edit, delete, consistency ----------------------------------------------------------------
test("editing a foreign voucher: it keeps the rate it was made at; a new day, currency or typed rate is looked up and judged afresh", { skip }, async () => {
  await svc.Currencies.update("GBP", { isActive: true }, {});
  await svc.Currencies.addRate("GBP", { rate: 4.6, effectiveDate: ymd(-6) }, {});
  await svc.Currencies.addRate("GBP", { rate: 4.8, effectiveDate: ymd(-1) }, {});
  const v = await receipt({ currency: "GBP", foreignAmount: 100, paymentMode: "cash", date: day(-3) });

  assert.equal(v.exchangeRate, 4.6);
  assert.equal(v.totalAmount, 460);
  const cash0 = await balance("Cash in Hand");

  // the master for that day is corrected afterwards; the voucher keeps the rate it was made at
  await svc.Currencies.addRate("GBP", { rate: 4.55, effectiveDate: ymd(-6) }, {});
  const bigger = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, foreignAmount: 200, forceUpdate: true }, admin);
  assert.equal(bigger.exchangeRate, 4.6, "same rate, even though the master moved");
  assert.equal(bigger.totalAmount, 920);
  assert.equal(bigger.foreignAmount, 200);
  assert.equal(bigger.rateSource, "manual");
  assert.equal(await balance("Cash in Hand"), r2(cash0 + 460), "the ledger moved by the difference only");
  const cash = await entry(v, "Cash in Hand");
  assert.equal(cash.amountForeign, 200);
  assert.equal(cash.debitAmount, 920);
  assert.equal((await svc.LedgerEntry.find({ voucherId: v._id, accountName: "Cash in Hand", isReversed: { $ne: true } })).length, 1, "one live entry; the old one is reversed");

  // a form that sends the voucher's own rate back is not a new rate, even if the master is now far from it
  await svc.Currencies.addRate("GBP", { rate: 5.5, effectiveDate: ymd(-6) }, {});
  const resent = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, exchangeRate: 4.6, foreignAmount: 200, forceUpdate: true }, admin);
  assert.equal(resent.exchangeRate, 4.6);
  assert.equal(resent.totalAmount, 920);
  assert.ok(!resent.rateOverridden);

  // a new day looks the rate up again
  const moved = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, date: day(0), forceUpdate: true }, admin);
  assert.equal(moved.exchangeRate, 4.8);
  assert.equal(moved.totalAmount, 960);
  assert.equal(dubaiDay(moved.rateDate), ymd(-1));

  // a typed rate is judged like on a new voucher, and a refusal leaves the voucher as it was
  const snapshot = { total: moved.totalAmount, cash: await balance("Cash in Hand") };
  await assert.rejects(() => svc.Financial.updateVoucher(v._id, { customerId: customer._id, exchangeRate: 6, forceUpdate: true }, admin), { code: "RATE_OUT_OF_TOLERANCE" });
  const unchanged = await svc.Voucher.findById(v._id);
  assert.equal(unchanged.totalAmount, snapshot.total);
  assert.equal(unchanged.exchangeRate, 4.8);
  assert.equal(await balance("Cash in Hand"), snapshot.cash, "the refused edit rolled back");
  const typed = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, exchangeRate: 4.9, forceUpdate: true }, admin);
  assert.equal(typed.exchangeRate, 4.9);
  assert.equal(typed.totalAmount, 980);
  assert.equal(typed.rateSource, "voucher");

  // into another currency: the master is consulted for it
  const usd = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, currency: "USD", foreignAmount: 100, forceUpdate: true }, admin);
  assert.equal(usd.currency, "USD");
  assert.equal(usd.exchangeRate, 3.6725);
  assert.equal(usd.totalAmount, 367.25);
  assert.ok(!usd.rateOverridden, "the old typed rate's override does not follow it");
  assert.equal((await entry(v, "Cash in Hand")).currency, "USD");

  // and back to AED: nothing foreign is left behind
  const back = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, currency: "AED", totalAmount: 500, forceUpdate: true }, admin);
  assert.equal(back.currency, "AED");
  assert.equal(back.exchangeRate, 1);
  assert.equal(back.totalAmount, 500);
  for (const f of ["foreignAmount", "rateDate", "rateSource", "rateOverridden", "rateOverrideReason"]) assert.equal(back[f], undefined, f);
  const aed = await entry(v, "Cash in Hand");
  assert.equal(aed.debitAmount, 500);
  assert.equal(aed.currency, undefined);
  assert.equal(aed.amountForeign, undefined);

  // and out again
  const out = await svc.Financial.updateVoucher(v._id, { customerId: customer._id, currency: "GBP", foreignAmount: 50, forceUpdate: true }, admin);
  assert.equal(out.exchangeRate, 4.8);
  assert.equal(out.totalAmount, 240);

});

test("a used currency cannot be deleted, or have its decimals changed; it can be switched off, which stops new use", { skip }, async () => {
  await assert.rejects(() => svc.Currencies.remove("USD", {}), { code: "CURRENCY_IN_USE" });
  await assert.rejects(() => svc.Currencies.update("USD", { decimals: 3 }, {}), { code: "CURRENCY_IN_USE" });
  assert.equal((await svc.Currencies.update("USD", { decimals: 2, name: "United States Dollar" }, {})).name, "United States Dollar", "an unchanged decimals value is fine");
  assert.equal((await svc.Currencies.list({})).find((c) => c.code === "USD").used, true);

  await svc.Currencies.update("USD", { isActive: false }, {});
  await assert.rejects(() => receipt({ currency: "USD", foreignAmount: 1, paymentMode: "cash" }), { code: "CURRENCY_INACTIVE" });
  assert.ok(await svc.Voucher.findOne({ currency: "USD" }), "existing vouchers are untouched");
  await svc.Currencies.update("USD", { isActive: true }, {});

  // a currency that was never used goes only if it has no rate history either
  await svc.Currencies.create({ code: "CHF", name: "Swiss Franc", decimals: 2 }, {});
  await svc.Currencies.addRate("CHF", { rate: 4.1, effectiveDate: ymd(-1) }, {});
  await assert.rejects(() => svc.Currencies.remove("CHF", {}), { code: "CURRENCY_HAS_RATES" });
  await svc.Currencies.create({ code: "CAD", name: "Canadian Dollar" }, {});
  assert.deepEqual(await svc.Currencies.remove("CAD", {}), { code: "CAD" });
  assert.equal(await svc.Currency.countDocuments({ code: "CAD" }), 0);
  assert.ok(await svc.ActivityLog.findOne({ action: "CURRENCY_DELETED", summary: /CAD/ }));
  await assert.rejects(() => svc.Currencies.remove("CAD", {}), { code: "CURRENCY_NOT_FOUND" });
});

// ---- the register ------------------------------------------------------------------------------
test("the currency register lists foreign vouchers with totals and an average rate per currency and direction", { skip }, async () => {
  const gone = await receipt({ currency: "USD", foreignAmount: 40, paymentMode: "cash" });
  await svc.Financial.deleteVoucher(gone._id, admin); // listed, but not counted

  const reg = await svc.Fx.register({}, {});
  assert.ok(reg.rows.every((r) => r.foreignAmount > 0 && r.currency !== "AED"), "no AED voucher is listed");
  assert.ok(reg.rows.find((r) => String(r._id) === String(gone._id) && r.status === "cancelled"), "a cancelled voucher is listed as such");
  assert.equal(reg.truncated, false);

  // totals worked out independently, by hand from the posted (approved) foreign vouchers
  const posted = await svc.Voucher.find({ foreignAmount: { $exists: true }, status: "approved" }).lean();
  assert.ok(posted.length >= 12);
  const want = new Map();
  for (const v of posted) {
    const k = `${v.currency}|${v.voucherType}`;
    const t = want.get(k) || { count: 0, foreign: 0, aed: 0 };
    t.count += 1; t.foreign += v.foreignAmount; t.aed += v.totalAmount;
    want.set(k, t);
  }
  assert.equal(reg.totals.length, want.size, "one total per currency and direction");
  for (const [k, t] of want) {
    const [currency, type] = k.split("|");
    const row = reg.totals.find((x) => x.currency === currency && x.type === type);
    assert.ok(row, `totals for ${k}`);
    assert.equal(row.count, t.count, `${k} count`);
    assert.equal(r2(row.foreign), r2(t.foreign), `${k} foreign`);
    assert.equal(r2(row.aed), r2(t.aed), `${k} AED`);
  }
  assert.ok(!reg.totals.some((t) => t.count === 0));
  const usdIn = reg.totals.find((t) => t.currency === "USD" && t.type === "receipt");
  assert.equal(usdIn.averageRate, Math.round((usdIn.aed / usdIn.foreign) * 1e6) / 1e6, "average rate is AED per unit of USD, weighted by amount");
  assert.ok(usdIn.averageRate > 3.6 && usdIn.averageRate < 3.95);
  assert.equal(reg.totals.find((t) => t.currency === "USD" && t.type === "payment").count, 3);
  assert.ok(reg.totals.find((t) => t.currency === "KWD" && t.type === "receipt"));

  // exact figures for a slice that is easy to count: the USD payments made above
  const pay = await svc.Fx.register({}, { currency: "usd", type: "payment" });
  assert.deepEqual(pay.totals.map((t) => [t.currency, t.type, t.count, t.foreign, t.aed, t.averageRate]), [["USD", "payment", 3, 1800, 6610.5, 3.6725]]);
  assert.ok(pay.rows.every((r) => r.voucherType === "payment" && r.currency === "USD"));
  assert.equal(pay.rows[0].partyName, "Gulf Mills");

  // filters
  const none = await svc.Fx.register({}, { from: ymd(1), to: ymd(9) });
  assert.deepEqual(none.rows, []);
  assert.deepEqual(none.totals, []);
  const today = await svc.Fx.register({}, { from: ymd(0), to: ymd(0) });
  assert.ok(today.rows.length > 0, "today's vouchers are in a range that is today");
  const gbp = await svc.Fx.register({}, { currency: "GBP" });
  assert.deepEqual(gbp.totals.map((t) => [t.currency, t.type, t.count, t.foreign, t.aed]), [["GBP", "receipt", 1, 50, 240]]);

  await assert.rejects(() => svc.Fx.register({}, { from: "04/10/2026" }), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Fx.register({}, { type: "journal" }), { code: "INVALID_TYPE" });
  await assert.rejects(() => svc.Fx.register({}, { currency: "dollars" }), { code: "INVALID_CURRENCY_CODE" });
});

// ---- over HTTP ---------------------------------------------------------------------------------
test("the router: auth, role gating, route order, response shapes", { skip }, async () => {
  const express = require("express");
  const { generateTokens } = require("../core/adminService");
  const boss = await new svc.Admin({ name: "Boss", email: "boss@fx.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const viewer = await new svc.Admin({ name: "Viewer", email: "viewer@fx.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();
  const token = (a) => generateTokens({ id: a._id, email: a.email, type: a.type, permissions: a.permissions, name: a.name }).accessToken;

  const app = express();
  app.use(express.json());
  app.use("/api/v1/currencies", require("../../routes/financial/currencyRoutes"));
  app.use(require("../../utils/errorHandler"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/currencies`;
  const call = async (method, url, { body, as = boss } = {}) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await call("GET", "/", { as: null })).status, 401, "no token, no access");

    const list = await call("GET", "/");
    assert.equal(list.status, 200);
    assert.equal(list.json.success, true);
    assert.equal(list.json.data[0].code, "AED");

    const rate = await call("GET", `/rate?code=usd&date=${ymd(-30)}`);
    assert.equal(rate.status, 200);
    assert.deepEqual(
      { code: rate.json.data.code, rate: rate.json.data.rate, rateDate: rate.json.data.rateDate, date: rate.json.data.date, tolerancePercent: rate.json.data.tolerancePercent, decimals: rate.json.data.decimals },
      { code: "USD", rate: 3.6, rateDate: ymd(-40), date: ymd(-30), tolerancePercent: 5, decimals: 2 }
    );
    assert.equal((await call("GET", "/rate?code=AED")).json.data.rate, 1);
    const none = await call("GET", `/rate?code=USD&date=${ymd(-200)}`);
    assert.equal(none.status, 422);
    assert.equal(none.json.errorCode, "NO_RATE");
    assert.match(none.json.message, /^No USD rate on or before \d\d\/\d\d\/\d{4}\. Add one under Currencies\.$/);
    assert.equal((await call("GET", "/rate")).status, 400);

    const hist = await call("GET", "/USD/rates");
    assert.equal(hist.status, 200);
    assert.ok(hist.json.data.length >= 5 && hist.json.data[0].effectiveDay);

    const reg = await call("GET", "/register?currency=USD&type=receipt");
    assert.equal(reg.status, 200);
    assert.ok(Array.isArray(reg.json.data.rows) && Array.isArray(reg.json.data.totals));
    assert.equal((await call("GET", "/register?type=nope")).status, 400);

    assert.equal((await call("GET", "/settings")).json.data.fxTolerancePercent, 5);

    // reading is for everyone signed in, changing is for admins
    assert.equal((await call("GET", "/", { as: viewer })).status, 200);
    assert.equal((await call("POST", "/", { as: viewer, body: { code: "NOK", name: "Norwegian Krone" } })).status, 403);
    assert.equal((await call("POST", "/USD/rates", { as: viewer, body: { rate: 3.7 } })).status, 403);
    assert.equal((await call("PUT", "/settings", { as: viewer, body: { fxTolerancePercent: 9 } })).status, 403);
    assert.equal((await call("DELETE", "/USD", { as: viewer })).status, 403);

    const made = await call("POST", "/", { body: { code: "NOK", name: "Norwegian Krone", symbol: "kr" } });
    assert.equal(made.status, 201);
    const added = await call("POST", "/NOK/rates", { body: { rate: 0.34, effectiveDate: ymd(0), source: "manual", note: "test" } });
    assert.equal(added.status, 201);
    assert.equal(added.json.data.replaced, false);
    assert.equal((await call("PUT", "/NOK", { body: { isActive: false } })).json.data.isActive, false);
    assert.equal((await call("PUT", "/AED", { body: { isActive: false } })).json.errorCode, "BASE_CURRENCY_LOCKED");
    assert.equal((await call("DELETE", "/USD")).json.errorCode, "CURRENCY_IN_USE");
    assert.equal((await call("PUT", "/settings", { body: { fxTolerancePercent: 7.5 } })).json.data.fxTolerancePercent, 7.5);
    await call("PUT", "/settings", { body: { fxTolerancePercent: 5 } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("everything posted in this file keeps the books balanced, in AED", { skip }, async () => {
  const t = await svc.LedgerEntry.aggregate([{ $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(Math.round((t[0].d - t[0].c) * 100), 0);
  // every foreign-stamped entry is a money-side leg of a foreign voucher
  const stamped = await svc.LedgerEntry.find({ amountForeign: { $exists: true } }).lean();
  assert.ok(stamped.length > 0);
  assert.ok(stamped.every((e) => e.currency && e.currency !== "AED" && e.exchangeRate > 0));
});
