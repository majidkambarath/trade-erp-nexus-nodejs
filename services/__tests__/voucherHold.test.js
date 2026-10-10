// A voucher that would post the moment it is saved (journal, contra, expense, debit / credit note, receipt, payment) is HELD
// instead when the person saving it is over their own approval limit, or the organisation wants two approvers at that amount:
// it is saved pending, posts nothing, and someone who may approve it does (processVoucherApproval posts it). Also: what an
// edit may and may not do to a voucher that waits or that is already posted. Service level, throwaway database.
//
// The person is named by a request-shaped object, as the controllers pass it: { admin: { id, name, role: { approvalLimit }, grants } }.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const id = () => new mongoose.Types.ObjectId();
const PEOPLE = { clerk: id(), junior: id(), senior: id(), boss: id(), other: id() };

let svc;
let customer;
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Chart: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    ...require("../../models/modules/banking/bankingModels"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Transaction: require("../../models/modules/transactionModel"),
    CreditLog: require("../../models/modules/CreditLog"),
    Transactor: require("../../models/modules/financial/transactorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e7 });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: stock._id, description: "Rice", qty: 1000, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- helpers -------------------------------------------------------------------------------
const reqOf = (who, { limit = null, grants = [] } = {}) => ({ admin: { id: String(PEOPLE[who]), name: who, role: { approvalLimit: limit }, grants } });
const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
const balance = async (name) => (await acct(name))?.currentBalance ?? 0;
const day = (n = 0) => new Date(Date.now() + n * 86400000);
const entriesOf = (v) => svc.LedgerEntry.find({ voucherId: v._id, isReversed: { $ne: true } }).lean();
const legs = async (v) => (await entriesOf(v)).map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`).sort();
const row = (v) => svc.Voucher.findById(v._id).select("+heldCheque").lean();
const policy = (approvals) => svc.Config.updateSettings({ approvals }, {});

const journal = async (amount, opts = {}, who = "clerk") => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  return svc.Financial.createVoucher({ voucherType: "journal", date: day(), narration: "Accrual", lines: [{ accountId: rent._id, debit: amount }, { accountId: cash._id, credit: amount }] }, PEOPLE[who], undefined, opts);
};
const approve = (v, who, opts = {}) => svc.Financial.processVoucherApproval(v._id, opts.action || "approve", PEOPLE[who], "", { req: reqOf(who, opts) });

async function invoice(qty = 10) {
  const sale = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(sale._id, "approve", "t");
  return svc.Transaction.findById(sale._id);
}
const outstanding = async (inv) => (await svc.Transaction.findById(inv._id)).outstandingAmount;
const owes = async () => (await svc.Customer.findById(customer._id)).cashBalance || 0;

// ---- nothing to hold -------------------------------------------------------------------------
test("a person under their limit, a person with no limit, and a job with nobody behind it all post at once, as ever", { skip }, async () => {
  const cashBefore = await balance("Cash in Hand");
  const within = await journal(400, { req: reqOf("clerk", { limit: 500 }) });
  assert.equal(within.status, "approved");
  assert.equal(within.$locals.hold, undefined);
  assert.equal((await entriesOf(within)).length, 2);

  const unlimited = await journal(90000, { req: reqOf("boss") });
  assert.equal(unlimited.status, "approved", "no limit: nothing to be over");
  const job = await journal(90000, {}); // no request: an internal caller
  assert.equal(job.status, "approved");
  assert.equal(await balance("Cash in Hand"), cashBefore - 400 - 90000 - 90000);
});

// ---- the hold --------------------------------------------------------------------------------
test("a journal over the maker's limit is saved pending and posts NOTHING; a lower limit cannot approve it, a higher one posts it", { skip }, async () => {
  const rentBefore = await balance("Rent Expense");
  const cashBefore = await balance("Cash in Hand");
  const held = await journal(800, { req: reqOf("clerk", { limit: 500 }) });

  assert.equal(held.status, "pending");
  assert.equal(held.approvalStatus, "pending");
  assert.match(held.voucherNo, /^JV-\d{4}-\d{4}$/, "numbered like any voucher");
  assert.deepEqual(held.approvals, []);
  assert.equal(held.$locals.hold.reason, "limit");
  assert.equal(held.$locals.hold.limit, 500);
  assert.match(held.$locals.hold.message, /800\.00 AED, above your approval limit of 500\.00 AED/);
  assert.equal(String(held.createdBy), String(PEOPLE.clerk), "the maker is kept: the separate-approver rule needs it");
  assert.equal((await entriesOf(held)).length, 0, "no ledger rows");
  assert.equal(await balance("Rent Expense"), rentBefore);
  assert.equal(await balance("Cash in Hand"), cashBefore);

  // the clerk cannot approve their own over-limit voucher, and neither can anyone else with the same ceiling
  await assert.rejects(() => approve(held, "junior", { limit: 500 }), { code: "APPROVAL_LIMIT_EXCEEDED" });
  assert.equal((await row(held)).status, "pending");
  assert.equal((await entriesOf(held)).length, 0);

  const done = await approve(held, "senior");
  assert.equal(done.status, "approved");
  assert.deepEqual((await legs(held)), ["Cash in Hand:Cr800", "Rent Expense:Dr800"]);
  assert.equal(await balance("Rent Expense"), rentBefore + 800);
  assert.equal(await balance("Cash in Hand"), cashBefore - 800);
  assert.deepEqual((await row(held)).approvals.map((a) => a.by), [String(PEOPLE.senior)]);
});

test("approving a held voucher posts exactly what saving it directly would have", { skip }, async () => {
  const direct = await journal(777, {});
  const held = await journal(777, { req: reqOf("clerk", { limit: 100 }) });
  await approve(held, "senior");
  assert.deepEqual(await legs(held), await legs(direct));
});

test("contra, ledger expense and credit note are held the same way, and posted when approved", { skip }, async () => {
  const [cash, bank, rent, sales] = await Promise.all([acct("Cash in Hand"), acct("Bank Account"), acct("Rent Expense"), acct("Sales Discounts Given")]);
  const clerk = reqOf("clerk", { limit: 100 });
  const contra = await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: bank._id, toAccountId: cash._id, totalAmount: 800, date: day() }, PEOPLE.clerk, undefined, { req: clerk });
  const expense = await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 300, description: "Office rent", paymentMode: "cash", date: day() }, PEOPLE.clerk, undefined, { req: clerk });
  const note = await svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: day(), lines: [{ accountId: sales._id, amount: 250 }] }, PEOPLE.clerk, undefined, { req: clerk });

  for (const v of [contra, expense, note]) {
    assert.equal(v.status, "pending", v.voucherType);
    assert.equal((await entriesOf(v)).length, 0, `${v.voucherType} posted nothing`);
  }
  assert.equal(note.onAccountAmount, 250, "a credit note with no invoice is money on account");
  for (const v of [contra, expense, note]) await approve(v, "senior"); // one after the other: they share the cash account
  assert.deepEqual(await legs(contra), ["Bank Account:Cr800", "Cash in Hand:Dr800"]);
  assert.deepEqual(await legs(expense), ["Cash in Hand:Cr300", "Rent Expense:Dr300"]);
  assert.deepEqual(await legs(note), ["Customer - Al Noor:Cr250", "Sales Discounts Given:Dr250"]);
  for (const v of [contra, expense, note]) assert.equal((await row(v)).status, "approved");
});

test("a held receipt has already settled its invoice; turning it down puts the invoice and the customer back, and it never posts", { skip }, async () => {
  const inv = await invoice(10); // 105
  assert.equal(await outstanding(inv), 105);
  const cashBefore = await balance("Cash in Hand");
  const owesBefore = await owes();

  const held = await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: 105, paymentMode: "cash", date: day(),
    linkedInvoices: [{ invoiceId: inv._id, amount: 105, balance: 0 }],
  }, PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 50 }) });
  assert.equal(held.status, "pending");
  assert.equal(await outstanding(inv), 0, "the customer paid: the invoice shows it while the voucher waits");
  assert.equal(await balance("Cash in Hand"), cashBefore, "but nothing is in the books");

  const rejected = await approve(held, "senior", { action: "reject" });
  assert.equal(rejected.status, "rejected");
  assert.equal(await outstanding(inv), 105, "turned down: the invoice is open again");
  assert.equal(await balance("Cash in Hand"), cashBefore);
  assert.equal((await entriesOf(held)).length, 0);
  assert.equal(await owes(), owesBefore);
  assert.deepEqual((await row(held)).approvals, []);
});

test("a held receipt on account moves the customer's balance; deleting it (cancelling) undoes that, approving it posts the advance", { skip }, async () => {
  const owesBefore = await owes();
  const held = await svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 400, paymentMode: "cash", date: day() }, PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 50 }) });
  assert.equal(held.onAccountAmount, 400);
  assert.equal(await owes(), owesBefore + 400);
  const removed = await svc.Financial.deleteVoucher(held._id, PEOPLE.clerk);
  assert.equal(removed.removed.status, "pending");
  assert.equal((await row(held)).status, "cancelled");
  assert.equal(await owes(), owesBefore, "a voucher that never posted gives its balance back");

  const again = await svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 400, paymentMode: "cash", date: day() }, PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 50 }) });
  await approve(again, "senior");
  assert.deepEqual(await legs(again), ["Cash in Hand:Dr400", "Customer Advance - Al Noor:Cr400"]);
  assert.equal(await owes(), owesBefore + 400);
});

test("the cheque behind a held voucher enters the register only when it is approved, and never if it is turned down", { skip }, async () => {
  const bank = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: (await svc.AccountGroup.findOne({ name: "Bank" }))._id }, {}, PEOPLE.boss);
  const cheque = (no) => ({ chequeNo: no, chequeDate: day(), drawnOnBankName: "Mashreq", accountId: bank._id });
  const make = (no) => svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 600, paymentMode: "cheque", paymentDetails: cheque(no), date: day() }, PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 100 }) });

  const held = await make("HC-1");
  assert.equal(held.status, "pending");
  assert.equal(await svc.Cheque.countDocuments({ voucherId: held._id }), 0, "nothing in the register yet: there is nothing to clear");
  assert.equal((await row(held)).heldCheque.chequeNo, "HC-1", "kept on the voucher");
  assert.equal((await svc.Voucher.findById(held._id).lean()).heldCheque, undefined, "and not read back unless asked for");

  const done = await approve(held, "senior");
  assert.equal(done.heldCheque, undefined, "nor sent to a screen");
  const registered = await svc.Cheque.findOne({ voucherId: held._id });
  assert.equal(registered.status, "pending");
  assert.equal(registered.chequeNo, "HC-1");
  assert.equal(registered.direction, "receipt");
  assert.ok((await legs(held)).includes("Cheques in Hand:Dr600"));
  assert.equal((await row(held)).heldCheque, undefined, "moved out of the voucher");

  const turned = await make("HC-2");
  await approve(turned, "senior", { action: "reject" });
  assert.equal(await svc.Cheque.countDocuments({ voucherId: turned._id }), 0, "a rejected voucher leaves no cheque behind");
  // the number is free again: the same cheque can be entered properly
  const retry = await svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 600, paymentMode: "cheque", paymentDetails: cheque("HC-2"), date: day() }, PEOPLE.boss);
  assert.equal(retry.status, "approved");
});

// ---- inside a caller's transaction ---------------------------------------------------------------
test("a voucher posted INSIDE a bank match cannot wait: a person over their limit is refused, and nothing is written", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const data = { voucherType: "journal", date: day(), narration: "Bank charge", lines: [{ accountId: rent._id, debit: 800 }, { accountId: cash._id, credit: 800 }] };
  const before = await svc.Voucher.countDocuments({});
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await assert.rejects(() => svc.Financial.createVoucher(data, PEOPLE.clerk, session, { req: reqOf("clerk", { limit: 500 }) }), (err) => {
      assert.equal(err.code, "APPROVAL_LIMIT_EXCEEDED");
      assert.match(err.message, /800.00, above your approval limit of 500.00.*bank match/);
      return true;
    });
    // within their limit, or with no limit, it posts inside the transaction as ever
    const ok = await svc.Financial.createVoucher({ ...data, lines: [{ accountId: rent._id, debit: 400 }, { accountId: cash._id, credit: 400 }] }, PEOPLE.clerk, session, { req: reqOf("clerk", { limit: 500 }) });
    assert.equal(ok.status, "approved");
  } finally {
    await session.abortTransaction();
    await session.endSession();
  }
  assert.equal(await svc.Voucher.countDocuments({}), before, "the transaction was undone");

  // where the organisation wants two approvers at this amount, the statement line is the second pair of eyes: it posts, as ever
  await policy({ secondApprovalAbove: 100 });
  const s2 = await mongoose.startSession();
  s2.startTransaction();
  try {
    const v = await svc.Financial.createVoucher(data, PEOPLE.boss, s2, { req: reqOf("boss") });
    assert.equal(v.status, "approved");
  } finally {
    await s2.abortTransaction();
    await s2.endSession();
    await policy({ secondApprovalAbove: null });
  }
});

test("a voucher in the older format cannot wait, so it is refused for a person over their limit - and nothing it moved is left behind", { skip }, async () => {
  const make = (accountCode, accountName, accountType, currentBalance) => svc.Transactor.create({ accountCode, accountName, accountType, allowDirectPosting: true, isActive: true, currentBalance, createdBy: PEOPLE.boss });
  const [cashT, bankT] = await Promise.all([make("OLC001", "Old cash box", "asset", 5000), make("OLB001", "Old bank", "asset", 0)]);
  const contra = (n) => ({ voucherType: "contra", fromAccount: "OLC001", toAccount: "OLB001", totalAmount: n, date: day() });
  await assert.rejects(() => svc.Financial.createVoucher(contra(800), PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 500 }) }), (err) => {
    assert.equal(err.code, "APPROVAL_LIMIT_EXCEEDED");
    assert.match(err.message, /older format.*cannot wait for approval/);
    return true;
  });
  assert.equal((await svc.Transactor.findById(cashT._id)).currentBalance, 5000, "the balances it moved while it was worked out were rolled back");
  assert.equal((await svc.Transactor.findById(bankT._id)).currentBalance, 0);
  const ok = await svc.Financial.createVoucher(contra(400), PEOPLE.clerk, undefined, { req: reqOf("clerk", { limit: 500 }) });
  assert.equal(ok.status, "approved", "inside the limit it posts as ever");
});

// ---- two approvers ---------------------------------------------------------------------------
test("above the second-approver amount even a person with no limit saves a voucher pending; two different people post it", { skip }, async () => {
  await policy({ secondApprovalAbove: 1000 });
  try {
    const small = await journal(900, { req: reqOf("boss") }, "boss");
    assert.equal(small.status, "approved", "under the amount: as ever");
    const held = await journal(1500, { req: reqOf("boss") }, "boss");
    assert.equal(held.status, "pending");
    assert.equal(held.$locals.hold.reason, "second");
    assert.match(held.$locals.hold.message, /two approvers/);
    assert.equal((await entriesOf(held)).length, 0);

    const first = await approve(held, "senior");
    assert.equal(first.awaitingSecondApproval, true);
    assert.equal(first.status, "pending");
    assert.equal((await entriesOf(held)).length, 0, "one approval posts nothing");
    await assert.rejects(() => approve(held, "senior"), { code: "SECOND_APPROVER_REQUIRED" });
    const second = await approve(held, "other");
    assert.equal(second.status, "approved");
    assert.equal((await entriesOf(held)).length, 2);
    assert.deepEqual((await row(held)).approvals.map((a) => a.step), [1, 2]);
  } finally {
    await policy({ secondApprovalAbove: null });
  }
});

test("the separate-approver rule alone holds nothing: a voucher that posts on save has no approval step to separate", { skip }, async () => {
  await policy({ separateApprover: true });
  try {
    const v = await journal(99999, { req: reqOf("boss") }, "boss");
    assert.equal(v.status, "approved");
  } finally {
    await policy({ separateApprover: false });
  }
});

// ---- editing ---------------------------------------------------------------------------------
test("an edit never approves a voucher that is waiting: it stays pending, posts nothing, and a request cannot write its status", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const held = await journal(800, { req: reqOf("clerk", { limit: 500 }) });
  const edited = await svc.Financial.updateVoucher(held._id, { forceUpdate: true, lines: [{ accountId: rent._id, debit: 850 }, { accountId: cash._id, credit: 850 }] }, PEOPLE.clerk);
  assert.equal(edited.status, "pending", "an edit of a waiting voucher is not an approval");
  assert.equal(edited.totalAmount, 850);
  assert.equal((await entriesOf(held)).length, 0);

  // a plain edit used to copy the whole body onto the voucher
  const forged = await svc.Financial.updateVoucher(held._id, { narration: "tidied", status: "approved", approvalStatus: "approved", approvals: [{ by: "x", name: "forged", step: 1 }], createdBy: String(PEOPLE.senior), voucherNo: "JV-0000", forceUpdate: true }, PEOPLE.clerk);
  assert.equal(forged.narration, "tidied");
  const now = await row(held);
  assert.equal(now.status, "pending");
  assert.deepEqual(now.approvals, []);
  assert.equal(String(now.createdBy), String(PEOPLE.clerk));
  assert.equal(now.voucherNo, held.voucherNo);
  assert.equal((await entriesOf(held)).length, 0);

  // and it still posts, with the edited figures, when an approver approves it
  await approve(held, "senior");
  assert.deepEqual(await legs(held), ["Cash in Hand:Cr850", "Rent Expense:Dr850"]);
});

test("a held voucher's first approval is taken back by an edit, as for a document", { skip }, async () => {
  await policy({ secondApprovalAbove: 1000 });
  try {
    const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
    const held = await journal(1500, { req: reqOf("boss") }, "boss");
    await approve(held, "senior");
    assert.equal((await row(held)).approvals.length, 1);
    await svc.Financial.updateVoucher(held._id, { forceUpdate: true, lines: [{ accountId: rent._id, debit: 1600 }, { accountId: cash._id, credit: 1600 }] }, PEOPLE.boss);
    assert.deepEqual((await row(held)).approvals, []);
  } finally {
    await policy({ secondApprovalAbove: null });
  }
});

// ---- changing what an approved voucher posted ------------------------------------------------
test("changing the figures of an approved voucher needs finance.deletePosted, and is refused without it with nothing touched", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const v = await journal(300, {}, "boss");
  const lines = (n) => [{ accountId: rent._id, debit: n }, { accountId: cash._id, credit: n }];
  const before = await balance("Rent Expense");

  const editOnly = reqOf("other", { grants: ["finance.edit", "finance.create"] });
  await assert.rejects(() => svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(500) }, PEOPLE.other, { req: editOnly }), { code: "PERMISSION_DENIED" });
  assert.equal((await row(v)).totalAmount, 300);
  assert.equal(await balance("Rent Expense"), before, "not reversed, not re-posted");
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr300", "Rent Expense:Dr300"]);

  // a narration is not a posted figure: Edit is enough
  const narration = await svc.Financial.updateVoucher(v._id, { forceUpdate: true, narration: "clearer words" }, PEOPLE.other, { req: editOnly });
  assert.equal(narration.narration, "clearer words");

  // with the right to take postings back, the new figures are posted
  const reposter = reqOf("other", { grants: ["finance.edit", "finance.deletePosted"] });
  const done = await svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(500) }, PEOPLE.other, { req: reposter });
  assert.equal(done.totalAmount, 500);
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr500", "Rent Expense:Dr500"]);
  assert.equal(await balance("Rent Expense"), before + 200);
  assert.deepEqual((await row(v)).approvals.map((a) => a.by), [String(PEOPLE.other)], "the new figures are the editor's approval, replacing the old one");
});

test("the new amount is judged like an approval: the editor's limit, the preparer, and an amount that needs two approvers", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const lines = (n) => [{ accountId: rent._id, debit: n }, { accountId: cash._id, credit: n }];
  const grants = ["finance.edit", "finance.deletePosted"];
  const v = await journal(300, {}, "boss");
  const before = await balance("Rent Expense");
  const edit = (n, req) => svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(n) }, PEOPLE.junior, { req });

  // the editor's limit
  await assert.rejects(() => edit(700, reqOf("junior", { limit: 500, grants })), { code: "APPROVAL_LIMIT_EXCEEDED" });
  assert.equal(await balance("Rent Expense"), before, "refused: the whole edit is rolled back");
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr300", "Rent Expense:Dr300"]);
  assert.equal((await edit(400, reqOf("junior", { limit: 500, grants }))).totalAmount, 400);
  assert.deepEqual(await legs(v), ["Cash in Hand:Cr400", "Rent Expense:Dr400"]);

  // the person who prepared it does not correct their own figures when the organisation separates the two
  await policy({ separateApprover: true });
  try {
    await assert.rejects(() => svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(410) }, PEOPLE.boss, { req: reqOf("boss", { grants }) }), { code: "SELF_APPROVAL_NOT_ALLOWED" });
    assert.equal((await svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(410) }, PEOPLE.senior, { req: reqOf("senior", { grants }) })).totalAmount, 410);
  } finally {
    await policy({ separateApprover: false });
  }

  // an amount that needs two approvers cannot be reached by one person's edit - the old approvers do not count
  await policy({ secondApprovalAbove: 1000 });
  try {
    await assert.rejects(() => svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(1500) }, PEOPLE.senior, { req: reqOf("senior", { grants }) }), { code: "SECOND_APPROVER_REQUIRED" });
    assert.deepEqual(await legs(v), ["Cash in Hand:Cr410", "Rent Expense:Dr410"], "still as it was");
    assert.equal((await svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: lines(900) }, PEOPLE.senior, { req: reqOf("senior", { grants }) })).totalAmount, 900);
  } finally {
    await policy({ secondApprovalAbove: null });
  }
});

test("a job with nobody behind it edits an approved voucher as before (nobody to judge)", { skip }, async () => {
  const [rent, cash] = await Promise.all([acct("Rent Expense"), acct("Cash in Hand")]);
  const v = await journal(120, {}, "boss");
  const out = await svc.Financial.updateVoucher(v._id, { forceUpdate: true, lines: [{ accountId: rent._id, debit: 130 }, { accountId: cash._id, credit: 130 }] }, PEOPLE.boss);
  assert.equal(out.totalAmount, 130);
  assert.equal(out.status, "approved");
});

test("everything in this file keeps the books balanced", { skip }, async () => {
  const t = await svc.LedgerEntry.aggregate([{ $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(Math.round((t[0].d - t[0].c) * 100), 0);
});
