// A bank is the institution; the company's account at it is a chart account under the Bank group whose
// bank details name it. This pins the two reads that join them - the count on the bank list, and one
// bank's accounts - and that neither crosses to another organisation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let Banks, LedgerAccount, ctx;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  Banks = require("../banking/bankMasterService");
  LedgerAccount = require("../../models/modules/financial/financialModels").LedgerAccount;
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const inOrg = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const SOMEBODY = new mongoose.Types.ObjectId(); // every account records who made it
const account = (name, code, bankId, extra = {}) =>
  LedgerAccount.create({ accountName: name, accountCode: code, accountType: "asset", subType: "current_asset", createdBy: SOMEBODY, bank: { bankId, accountNumber: "9567675315", iban: "", branchCode: "", accountHolder: "" }, ...extra });

test("the bank list counts the accounts at each bank, and one bank lists its own", { skip }, async () => {
  await inOrg("orgA", async () => {
    const esaf = await Banks.create({ bankName: "RAZAL ESAF", bankCode: "RESAF", country: "IN", city: "Malappuram" });
    const nbd = await Banks.create({ bankName: "Emirates NBD", bankCode: "ENBD", country: "AE" });
    await account("ESAF Current", "1102", esaf._id);
    await account("ESAF Savings", "1103", esaf._id, { isActive: false, currentBalance: 0 });
    await LedgerAccount.create({ accountName: "Petty cash", accountCode: "1101", accountType: "asset", subType: "current_asset", createdBy: SOMEBODY }); // no bank at all

    const banks = await Banks.list();
    const byCode = new Map(banks.map((b) => [b.bankCode, b]));
    assert.deepEqual(byCode.get("RESAF").accounts, { total: 2, active: 1 }, "both accounts counted, one of them switched off");
    assert.deepEqual(byCode.get("ENBD").accounts, { total: 0, active: 0 }, "a bank with no account says none, not nothing");

    const { bank, accounts } = await Banks.accounts(esaf._id);
    assert.equal(bank.bankName, "RAZAL ESAF");
    assert.deepEqual(accounts.map((a) => a.accountCode), ["1102", "1103"], "in account-code order");
    assert.equal(accounts[0].bank.accountNumberMasked, "•••• 5315", "the number is masked for the list");
    assert.equal(accounts[0].bank.bankName, "RAZAL ESAF");
    assert.equal(accounts[1].isActive, false, "a switched-off account is listed too: it is why the bank cannot be switched off");
    assert.ok(!accounts.some((a) => a.accountName === "Petty cash"), "an account with no bank is not one of them");

    // the other bank is not carrying the first one's accounts
    assert.equal((await Banks.accounts(nbd._id)).accounts.length, 0);
  });
});

test("one organisation's accounts are never counted or listed for another's bank", { skip }, async () => {
  const theirs = await inOrg("orgA", async () => {
    const bank = await Banks.create({ bankName: "Shared Name Bank", bankCode: "SHARED" });
    await account("Their account", "1201", bank._id);
    return bank._id;
  });
  await inOrg("orgB", async () => {
    const mine = await Banks.create({ bankName: "Shared Name Bank", bankCode: "SHARED" }); // the same name and code is fine in another organisation
    const banks = await Banks.list();
    assert.deepEqual(banks.map((b) => b.bankCode), ["SHARED"], "only this organisation's banks");
    assert.deepEqual(banks[0].accounts, { total: 0, active: 0 }, "the other organisation's account is not counted here");
    assert.equal((await Banks.accounts(mine._id)).accounts.length, 0);
    await assert.rejects(() => Banks.accounts(theirs), (e) => e.statusCode === 404, "another organisation's bank is simply not found");
  });
});
