// Payment modes (cash / bank / transfer / cheque / card), the bank, card and card-type masters, the
// cheque register, and the journal / contra / expense / debit-note / credit-note vouchers posted to
// the chart of accounts. Throwaway database; see accountingFoundation.test.js.
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
    Banks: require("../banking/bankMasterService"),
    Cheques: require("../banking/chequeService"),
    PaymentModes: require("../banking/paymentModeService"),
    Chart: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    ...require("../banking/cardService"),
    ...require("../../models/modules/banking/bankingModels"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  await mongoose.connection.syncIndexes();
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
const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
const balance = async (name) => (await acct(name))?.currentBalance ?? 0;
const group = (name) => svc.AccountGroup.findOne({ name });
const day = (n = 0) => new Date(Date.now() + n * 86400000);
const receipt = (extra) => svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: day(), ...extra }, admin);
const payment = (extra) => svc.Financial.createVoucher({ voucherType: "payment", vendorId: vendor._id, totalAmount: 100, date: day(), ...extra }, admin);
const legs = async (voucher) => (await svc.LedgerEntry.find({ voucherId: voucher._id, isReversed: { $ne: true } }).lean()).map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`);
const newBank = async (name, bankId) => svc.Chart.createAccount({ accountName: name, groupId: (await group("Bank"))._id, bank: bankId ? { bankId, accountNumber: "0123456789" } : undefined }, {}, admin);

// ---- masters -------------------------------------------------------------------------------
test("bank master: unique name and code, SWIFT checked, in-use banks cannot be switched off", { skip }, async () => {
  const b = await svc.Banks.create({ bankName: "Emirates NBD", bankCode: "enbd", swiftCode: "EBILAEAD", city: "Dubai" }, {});
  assert.equal(b.bankCode, "ENBD");
  await assert.rejects(() => svc.Banks.create({ bankName: "emirates nbd", bankCode: "X1" }, {}), { code: "DUPLICATE_BANK" });
  await assert.rejects(() => svc.Banks.create({ bankName: "Other", bankCode: "ENBD" }, {}), { code: "DUPLICATE_BANK" });
  await assert.rejects(() => svc.Banks.create({ bankName: "Bad Swift", bankCode: "BS", swiftCode: "12" }, {}));

  const acc = await newBank("ENBD Current", b._id);
  assert.equal(String(acc.bank.bankId), String(b._id));
  await assert.rejects(() => svc.Banks.update(b._id, { isActive: false }, {}), { code: "BANK_IN_USE" });
});

test("bank account details: the IBAN is checksum-validated and the number is masked in lists", { skip }, async () => {
  const bank = await svc.Banks.create({ bankName: "RAKBANK", bankCode: "RAK" }, {});
  const good = "AE070331234567890123456"; // a valid UAE IBAN
  const ok = await svc.Chart.createAccount({ accountName: "RAK Current", groupId: (await group("Bank"))._id, bank: { bankId: bank._id, accountNumber: "5551234567", iban: good } }, {}, admin);
  assert.equal(ok.bank.iban, good);
  await assert.rejects(
    async () => svc.Chart.createAccount({ accountName: "RAK Bad", groupId: (await group("Bank"))._id, bank: { iban: "AE070331234567890123457" } }, {}, admin),
    { code: "INVALID_IBAN" }
  );
  const opts = await svc.PaymentModes.options({});
  const row = opts.bankAccounts.find((a) => a.accountName === "RAK Current");
  assert.equal(row.bank.accountNumberMasked, "•••• 4567");
  assert.equal(row.bank.bankName, "RAKBANK");
});

test("card types and cards: only the last four digits are kept; credit and prepaid cards get their own account", { skip }, async () => {
  const visa = await svc.CardTypeService.create({ name: "Visa", feePercent: 2.5 }, {});
  await assert.rejects(() => svc.CardTypeService.create({ name: "visa" }, {}), { code: "DUPLICATE_CARD_TYPE" });
  await assert.rejects(() => svc.CardTypeService.create({ name: "Bad", feePercent: 120 }, {}), { code: "INVALID_FEE" });

  const bank = await newBank("Settlement Bank");
  const terminal = await svc.CardService.create({ label: "POS 1", kind: "terminal", cardTypeId: visa._id, accountId: bank._id, terminalId: "T-001" }, {}, admin);
  assert.equal(terminal.effectiveFeePercent, 2.5, "the card type's fee applies unless the terminal overrides it");

  const credit = await svc.CardService.create({ label: "Company Amex", kind: "credit", cardTypeId: visa._id, holderName: "Boss", last4: "4242", creditLimit: 5000, expiryMonth: 12, expiryYear: new Date().getFullYear() + 2 }, {}, admin);
  const liab = await svc.LedgerAccount.findById(credit.accountId);
  assert.equal(liab.accountType, "liability");
  assert.equal(liab.accountName, "Credit Card - Company Amex");

  await assert.rejects(() => svc.CardService.create({ label: "Leaky", kind: "debit", cardTypeId: visa._id, holderName: "x", accountId: bank._id, last4: "4242424242424242" }, {}, admin), { code: "ONLY_LAST4" });
  await assert.rejects(() => svc.CardService.create({ label: "Cvv", kind: "debit", cardTypeId: visa._id, holderName: "x", accountId: bank._id, cvv: "123" }, {}, admin), { code: "NO_FULL_NUMBER" });
  await assert.rejects(() => svc.CardService.create({ label: "Old", kind: "debit", cardTypeId: visa._id, holderName: "x", accountId: bank._id, expiryMonth: 1, expiryYear: 2020 }, {}, admin), { code: "CARD_EXPIRED" });
  await assert.rejects(() => svc.CardService.create({ label: "NoLimit", kind: "credit", cardTypeId: visa._id, holderName: "x" }, {}, admin), { code: "LIMIT_REQUIRED" });
  await assert.rejects(() => svc.CardService.update(credit._id, { kind: "debit" }, {}), { code: "KIND_LOCKED" });
  await assert.rejects(() => svc.CardTypeService.update(visa._id, { isActive: false }, {}), { code: "CARD_TYPE_IN_USE" });
});

// ---- cash / bank / transfer -----------------------------------------------------------------
test("cash receipt and payment use the cash account; legacy 'online' is a transfer", { skip }, async () => {
  const r = await receipt({ paymentMode: "cash" });
  assert.deepEqual(await legs(r), ["Cash in Hand:Dr100", "Customer Advance - Al Noor:Cr100"]);
  assert.equal(await balance("Cash in Hand"), 100);

  const p = await payment({ paymentMode: "cash", totalAmount: 40 });
  assert.ok((await legs(p)).includes("Cash in Hand:Cr40"));
  assert.equal(await balance("Cash in Hand"), 60);

  await assert.rejects(() => receipt({ paymentMode: "barter" }), { code: "INVALID_PAYMENT_MODE" });
  await assert.rejects(async () => receipt({ paymentMode: "cash", paymentDetails: { accountId: (await acct("Bank Account"))._id } }), { code: "NOT_A_CASH_ACCOUNT" });
});

test("bank and transfer: with several banks the account must be chosen, and a transfer needs its reference", { skip }, async () => {
  // there is more than one bank account by now
  await assert.rejects(() => receipt({ paymentMode: "bank" }), { code: "BANK_ACCOUNT_REQUIRED" });
  const enbd = await acct("ENBD Current");
  const r = await receipt({ paymentMode: "bank", paymentDetails: { accountId: enbd._id, reference: "SLIP-9" } });
  assert.ok((await legs(r)).includes("ENBD Current:Dr100"));
  assert.equal(r.paymentDetails.reference, "SLIP-9");

  await assert.rejects(() => receipt({ paymentMode: "transfer", paymentDetails: { accountId: enbd._id } }), { code: "REFERENCE_REQUIRED" });
  const t = await receipt({ paymentMode: "transfer", paymentDetails: { accountId: enbd._id, reference: "TRF-1", referenceDate: day() } });
  assert.equal(t.paymentMode, "transfer");
  const legacy = await receipt({ paymentMode: "online", paymentDetails: { accountId: enbd._id, onlineDetails: { transactionId: "OLD-7" } } });
  assert.equal(legacy.paymentMode, "transfer", "the old name still works and is stored as transfer");
  assert.equal(legacy.paymentDetails.reference, "OLD-7");

  await assert.rejects(async () => payment({ paymentMode: "transfer", paymentDetails: { accountId: (await acct("Cash in Hand"))._id, reference: "x" } }), { code: "NOT_A_BANK_ACCOUNT" });
});

// ---- cheques --------------------------------------------------------------------------------
test("cheque received: waits in cheques-in-hand, clears into the bank, and cannot clear before its date", { skip }, async () => {
  const enbd = await acct("ENBD Current");
  const before = await balance("ENBD Current");
  const chq = { chequeNo: "100200", chequeDate: day(10), drawnOnBankName: "Mashreq", accountId: enbd._id };
  const r = await receipt({ paymentMode: "cheque", paymentDetails: chq });
  assert.ok((await legs(r)).includes("Cheques in Hand:Dr100"), "not in the bank yet");
  assert.equal(await balance("ENBD Current"), before);
  assert.equal(await balance("Cheques in Hand"), 100);

  const row = await svc.Cheque.findOne({ voucherId: r._id });
  assert.equal(row.status, "pending");
  assert.equal(row.isPDC, true);
  assert.equal(row.direction, "receipt");

  await assert.rejects(() => svc.Cheques.clear(row._id, { clearedOn: day(2) }, {}, admin), { code: "CHEQUE_NOT_MATURE" });
  const done = await svc.Cheques.clear(row._id, { clearedOn: day(10) }, {}, admin);
  assert.equal(done.status, "cleared");
  assert.equal(await balance("Cheques in Hand"), 0);
  assert.equal(await balance("ENBD Current"), before + 100);
  await assert.rejects(() => svc.Cheques.clear(row._id, {}, {}, admin), { code: "CHEQUE_NOT_PENDING" });
});

test("cheque rules: required fields, stale cheques, duplicates", { skip }, async () => {
  const enbd = await acct("ENBD Current");
  await assert.rejects(() => receipt({ paymentMode: "cheque", paymentDetails: { chequeDate: day(), drawnOnBankName: "X", accountId: enbd._id } }), { code: "CHEQUE_NUMBER_REQUIRED" });
  await assert.rejects(() => receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "123", accountId: enbd._id, drawnOnBankName: "X" } }), { code: "INVALID_DATE" });
  await assert.rejects(() => receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "777", chequeDate: day(-200), drawnOnBankName: "X", accountId: enbd._id } }), { code: "STALE_CHEQUE" });
  await assert.rejects(() => receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "778", chequeDate: day(), accountId: enbd._id } }), { code: "DRAWN_ON_BANK_REQUIRED" });

  await receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "555", chequeDate: day(), drawnOnBankName: "Mashreq", accountId: enbd._id } });
  await assert.rejects(
    () => receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "555", chequeDate: day(), drawnOnBankName: "mashreq", accountId: enbd._id } }),
    { code: "DUPLICATE_CHEQUE" }
  );
  // the same number from a different bank is a different cheque
  await receipt({ paymentMode: "cheque", paymentDetails: { chequeNo: "555", chequeDate: day(), drawnOnBankName: "ADCB", accountId: enbd._id } });
});

test("a bounced cheque reopens the invoice it settled and reverses the receipt", { skip }, async () => {
  // a purchase to have stock, then a sale of 100 + VAT to settle by cheque
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: stock._id, description: "Rice", qty: 100, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
  const sale = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty: 10, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(sale._id, "approve", "t");
  const invoice = await svc.Transaction.findById(sale._id);
  assert.equal(invoice.outstandingAmount, 105);

  const enbd = await acct("ENBD Current");
  const r = await receipt({
    paymentMode: "cheque", totalAmount: 105, linkedInvoices: [{ invoiceId: sale._id, amount: 105, balance: 0 }],
    paymentDetails: { chequeNo: "900900", chequeDate: day(), drawnOnBankName: "CBD", accountId: enbd._id },
  });
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 0);
  assert.equal((await svc.Transaction.findById(sale._id)).status, "APPROVED", "settling an invoice does not change its status");
  const owedBefore = await balance("Customer - Al Noor");

  const row = await svc.Cheque.findOne({ voucherId: r._id });
  await assert.rejects(() => svc.Cheques.bounce(row._id, {}, {}, admin), { code: "REASON_REQUIRED" });
  const bounced = await svc.Cheques.bounce(row._id, { reason: "Insufficient funds" }, {}, admin);
  assert.equal(bounced.status, "bounced");
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 105, "the customer owes the invoice again");
  assert.equal((await svc.Voucher.findById(r._id)).status, "bounced");
  assert.equal(await balance("Customer - Al Noor"), owedBefore + 105);
  await assert.rejects(() => svc.Financial.updateVoucher(r._id, { narration: "x", forceUpdate: true }, admin), { code: "VOUCHER_VOIDED" });
});

test("cheque issued to a vendor: cheques-issued, then the bank when it clears; deleting a pending one withdraws it", { skip }, async () => {
  const enbd = await acct("ENBD Current");
  const bank0 = await balance("ENBD Current");
  const p = await payment({ paymentMode: "cheque", paymentDetails: { chequeNo: "000321", chequeDate: day(), accountId: enbd._id } });
  assert.ok((await legs(p)).includes("Cheques Issued:Cr100"));
  assert.equal(await balance("Cheques Issued"), 100);
  assert.equal(await balance("ENBD Current"), bank0);
  const row = await svc.Cheque.findOne({ voucherId: p._id });
  await svc.Cheques.clear(row._id, {}, {}, admin);
  assert.equal(await balance("Cheques Issued"), 0);
  assert.equal(await balance("ENBD Current"), bank0 - 100);

  const p2 = await payment({ paymentMode: "cheque", paymentDetails: { chequeNo: "000322", chequeDate: day(5), accountId: enbd._id } });
  await svc.Financial.deleteVoucher(p2._id, admin);
  assert.equal((await svc.Cheque.findOne({ voucherId: p2._id })).status, "cancelled");
  assert.equal(await balance("Cheques Issued"), 0, "withdrawn with its voucher");

  const p3 = await payment({ paymentMode: "cheque", paymentDetails: { chequeNo: "000323", chequeDate: day(), accountId: enbd._id } });
  const row3 = await svc.Cheque.findOne({ voucherId: p3._id });
  await svc.Cheques.clear(row3._id, {}, {}, admin);
  await assert.rejects(() => svc.Financial.updateVoucher(p3._id, { totalAmount: 50, forceUpdate: true }, admin), { code: "CHEQUE_CLEARED" });
  const list = await svc.Cheques.list({}, { status: "pending" });
  assert.ok(list.summary);
});

// ---- cards ----------------------------------------------------------------------------------
test("card receipt: settles to the terminal's bank less the fee; only a terminal can take it", { skip }, async () => {
  const terminal = (await svc.CardMaster.findOne({ label: "POS 1" }));
  const settle = await svc.LedgerAccount.findById(terminal.accountId);
  const before = settle.currentBalance;
  await assert.rejects(() => receipt({ paymentMode: "card", paymentDetails: { cardId: terminal._id } }), { code: "APPROVAL_CODE_REQUIRED" });
  const r = await receipt({ paymentMode: "card", totalAmount: 200, paymentDetails: { cardId: terminal._id, approvalCode: "A1B2C3" } });
  // 2.5% of 200 = 5.00
  assert.deepEqual((await legs(r)).sort(), ["Card Processing Fees:Dr5", "Customer Advance - Al Noor:Cr200", "Settlement Bank:Dr195"].sort());
  assert.equal(r.paymentDetails.cardFee, 5);
  assert.equal((await svc.LedgerAccount.findById(terminal.accountId)).currentBalance, before + 195);

  const credit = await svc.CardMaster.findOne({ label: "Company Amex" });
  await assert.rejects(() => receipt({ paymentMode: "card", paymentDetails: { cardId: credit._id, approvalCode: "X" } }), { code: "CARD_NOT_A_TERMINAL" });
});

test("card payment: charged to the company card, which cannot go past its limit", { skip }, async () => {
  const credit = await svc.CardMaster.findOne({ label: "Company Amex" });
  const p = await payment({ paymentMode: "card", totalAmount: 3000, paymentDetails: { cardId: credit._id } });
  assert.ok((await legs(p)).includes("Credit Card - Company Amex:Cr3000"));
  assert.equal(await balance("Credit Card - Company Amex"), 3000, "a liability grows when charged");
  await assert.rejects(() => payment({ paymentMode: "card", totalAmount: 2500, paymentDetails: { cardId: credit._id } }), { code: "CARD_LIMIT_EXCEEDED" });
  await payment({ paymentMode: "card", totalAmount: 2000, paymentDetails: { cardId: credit._id } }); // exactly the limit
  const terminal = await svc.CardMaster.findOne({ label: "POS 1" });
  await assert.rejects(() => payment({ paymentMode: "card", paymentDetails: { cardId: terminal._id } }), { code: "CARD_CANNOT_PAY" });
});

// ---- journal, contra, expense ----------------------------------------------------------------
test("journal: any number of rows, must balance, one side per row, and posts to the chart", { skip }, async () => {
  const [rent, utilities, cash] = await Promise.all([acct("Rent Expense"), acct("Utilities"), acct("Cash in Hand")]);
  const rentBefore = rent.currentBalance;
  const j = await svc.Financial.createVoucher({
    voucherType: "journal", date: day(), narration: "Month-end accrual",
    lines: [{ accountId: rent._id, debit: 700 }, { accountId: utilities._id, debit: 300, narration: "Electricity" }, { accountId: cash._id, credit: 1000 }, {}],
  }, admin);
  assert.equal(j.status, "approved");
  assert.equal(j.totalAmount, 1000);
  assert.equal(j.entries.length, 3, "a blank spare row is ignored");
  assert.equal(await balance("Rent Expense"), rentBefore + 700);
  const tb = await svc.LedgerEntry.aggregate([{ $match: { voucherId: j._id } }, { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(tb[0].d, tb[0].c);

  const make = (lines) => svc.Financial.createVoucher({ voucherType: "journal", date: day(), lines }, admin);
  await assert.rejects(() => make([{ accountId: rent._id, debit: 100 }, { accountId: cash._id, credit: 90 }]), { code: "UNBALANCED" });
  await assert.rejects(() => make([{ accountId: rent._id, debit: 100, credit: 100 }, { accountId: cash._id, credit: 0, debit: 0 }]), { code: "BOTH_SIDES" });
  await assert.rejects(() => make([{ accountId: rent._id, debit: 100 }]), { code: "TOO_FEW_LINES" });
  await assert.rejects(() => make([{ debit: 100 }, { accountId: cash._id, credit: 100 }]), { code: "ACCOUNT_REQUIRED" });

  await svc.Financial.deleteVoucher(j._id, admin);
  assert.equal(await balance("Rent Expense"), rentBefore, "deleting a journal puts the accounts back");
});

test("contra: cash and bank only, and cash cannot go negative", { skip }, async () => {
  const [cash, enbd, rent] = await Promise.all([acct("Cash in Hand"), acct("ENBD Current"), acct("Rent Expense")]);
  const cashBefore = cash.currentBalance;
  const c = await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: enbd._id, totalAmount: 25, date: day() }, admin);
  assert.deepEqual((await legs(c)).sort(), ["Cash in Hand:Cr25", "ENBD Current:Dr25"]);
  assert.equal(await balance("Cash in Hand"), cashBefore - 25);

  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: enbd._id, totalAmount: 1e7, date: day() }, admin), { code: "CASH_INSUFFICIENT" });
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: rent._id, totalAmount: 1, date: day() }, admin), { code: "NOT_CASH_OR_BANK" });
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: cash._id, totalAmount: 1, date: day() }, admin), { code: "SAME_ACCOUNT" });
});

test("expense on the chart: expense account + input VAT out of cash, bank or cheque", { skip }, async () => {
  const [rent, std, cash] = await Promise.all([acct("Rent Expense"), svc.TaxCode.findOne({ kind: "standard" }), acct("Cash in Hand")]);
  const cashBefore = cash.currentBalance;
  const e = await svc.Financial.createVoucher({
    voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 200, taxCodeId: std._id,
    description: "Office rent - October", paymentMode: "cash", date: day(),
  }, admin);
  assert.equal(e.totalAmount, 210);
  assert.equal(e.vatTotal, 10);
  assert.deepEqual((await legs(e)).sort(), ["Cash in Hand:Cr210", "Input VAT:Dr10", "Rent Expense:Dr200"].sort());
  assert.equal(await balance("Cash in Hand"), cashBefore - 210);

  const enbd = await acct("ENBD Current");
  const withCheque = await svc.Financial.createVoucher({
    voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 50, description: "Cheque rent", paymentMode: "cheque",
    paymentDetails: { chequeNo: "EXP-1", chequeDate: day(), accountId: enbd._id }, date: day(),
  }, admin);
  assert.ok((await legs(withCheque)).includes("Cheques Issued:Cr50"));
  assert.equal((await svc.Cheque.findOne({ voucherId: withCheque._id })).direction, "payment");

  const sales = await acct("Sales Revenue");
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: sales._id, amount: 5, description: "x", paymentMode: "cash", date: day() }, admin), { code: "NOT_AN_EXPENSE_ACCOUNT" });
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 5, paymentMode: "cash", date: day() }, admin), { code: "DESCRIPTION_REQUIRED" });
});

// ---- debit and credit notes ------------------------------------------------------------------
test("credit note to a customer: party credited, lines debited, output VAT reduced, set against an invoice", { skip }, async () => {
  const sale = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty: 10, price: 20, rate: 20, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(sale._id, "approve", "t");
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 210);

  const [discounts, std] = await Promise.all([acct("Sales Discounts Given"), svc.TaxCode.findOne({ kind: "standard" })]);
  const outVatBefore = await balance("Output VAT");
  const cn = await svc.Financial.createVoucher({
    voucherType: "credit_note", partyType: "Customer", partyId: customer._id, referenceInvoiceId: sale._id, date: day(),
    lines: [{ accountId: discounts._id, description: "Damaged cartons", amount: 40, taxCodeId: std._id }],
  }, admin);
  assert.match(cn.voucherNo, /^CN-\d{4}-\d{4}$/);
  assert.equal(cn.totalAmount, 42);
  assert.deepEqual((await legs(cn)).sort(), ["Customer - Al Noor:Cr42", "Output VAT:Dr2", "Sales Discounts Given:Dr40"].sort());
  assert.equal(await balance("Output VAT"), outVatBefore - 2);
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 168);
  assert.equal(cn.referenceInvoiceNo, (await svc.Transaction.findById(sale._id)).transactionNo);

  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", partyId: customer._id, referenceInvoiceId: sale._id, date: day(), lines: [{ accountId: discounts._id, amount: 500 }] }, admin), { code: "NOTE_EXCEEDS_INVOICE" });

  await svc.Financial.deleteVoucher(cn._id, admin);
  assert.equal((await svc.Transaction.findById(sale._id)).outstandingAmount, 210, "deleting the note reopens the invoice");
  assert.equal(await balance("Output VAT"), outVatBefore);
});

test("debit note to a customer adds to what they owe and cannot be set against an invoice; vendor debit note uses input VAT", { skip }, async () => {
  const [income, std, purchases] = await Promise.all([acct("Freight Recovered"), svc.TaxCode.findOne({ kind: "standard" }), acct("Purchase Variance")]);
  const dn = await svc.Financial.createVoucher({ voucherType: "debit_note", partyType: "Customer", partyId: customer._id, date: day(), lines: [{ accountId: income._id, amount: 100, taxCodeId: std._id }] }, admin);
  assert.deepEqual((await legs(dn)).sort(), ["Customer - Al Noor:Dr105", "Freight Recovered:Cr100", "Output VAT:Cr5"].sort());
  await assert.rejects(
    () => svc.Financial.createVoucher({ voucherType: "debit_note", partyType: "Customer", partyId: customer._id, referenceInvoiceId: new mongoose.Types.ObjectId(), date: day(), lines: [{ accountId: income._id, amount: 1 }] }, admin),
    { code: "NOTE_CANNOT_SETTLE" }
  );

  const vdn = await svc.Financial.createVoucher({ voucherType: "debit_note", partyType: "Vendor", partyId: vendor._id, date: day(), lines: [{ accountId: purchases._id, amount: 200, taxCodeId: std._id }] }, admin);
  assert.deepEqual((await legs(vdn)).sort(), ["Input VAT:Cr10", "Purchase Variance:Cr200", "Vendor - Gulf Mills:Dr210"].sort());
  assert.equal(vdn.onAccountAmount, 210, "not set against an invoice, it is money on account");

  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", date: day(), lines: [{ accountId: income._id, amount: 5 }] }, admin), { code: "PARTY_REQUIRED" });
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: day(), lines: [] }, admin), { code: "LINES_REQUIRED" });
});

test("everything posted in this file keeps the books balanced", { skip }, async () => {
  const t = await svc.LedgerEntry.aggregate([{ $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(Math.round((t[0].d - t[0].c) * 100), 0);
});

test("documents whose status an older version overwrote with paid / partial are repaired", { skip }, async () => {
  const doc = await svc.Transaction.create({
    transactionNo: "OLD-1", type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
    status: "partial", totalAmount: 10, items: [], createdBy: "test",
  });
  const done = await require("../../utils/migrations").runMigrations();
  assert.ok(done.settledStatusRepaired >= 1);
  assert.equal((await svc.Transaction.findById(doc._id)).status, "APPROVED");
  assert.equal((await require("../../utils/migrations").runMigrations()).settledStatusRepaired, 0, "running it again changes nothing");
});
