// The VAT return (FTA VAT 201), built from approved documents by tax treatment, netted for returns
// and notes, reconciled to the ledger, and saved / finalised / filed. Throwaway database.
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
let codes;
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    Vat: require("../reports/vatReturnService"),
    ...require("../../models/modules/financial/financialModels"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6, trnNumber: "100999888700003" });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const all = await svc.TaxCode.find({}).lean();
  codes = Object.fromEntries(all.map((c) => [c.kind, c]));

  const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });
  const post = async (type, party, partyType, items) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  await post("purchase_order", vendor, "Vendor", [line(100, 10)]); // input 1000 / 50
  await post("sales_order", customer, "Customer", [line(10, 20)]); // standard 200 / 10
  await post("sales_order", customer, "Customer", [line(5, 20, { taxCodeId: codes.zero_rated._id })]); // zero-rated 100
  await post("sales_order", customer, "Customer", [line(2, 50, { taxCodeId: codes.exempt._id })]); // exempt 100
  await post("sales_order", customer, "Customer", [line(1, 30, { vatPercent: 0 })]); // 0% and no code: unclassified
  await post("sales_return", customer, "Customer", [line(2, 20)]); // standard -40 / -2

  const expenseAcc = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" });
  const cash = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" });
  const equity = await svc.LedgerAccount.findOne({ accountName: "Opening Balance Equity" });
  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), lines: [{ accountId: cash._id, debit: 5000 }, { accountId: equity._id, credit: 5000 }] }, admin);
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: expenseAcc._id, amount: 200, taxCodeId: codes.standard._id, description: "Rent", paymentMode: "cash", date: new Date() }, admin); // input 200 / 10
  const discounts = await svc.LedgerAccount.findOne({ accountName: "Sales Discounts Given" });
  await svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: new Date(), lines: [{ accountId: discounts._id, description: "Damaged", amount: 100, taxCodeId: codes.standard._id }] }, admin); // output -100 / -5
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const box = (r, id) => r.boxes.find((b) => b.box === id);

test("the return puts each supply in the box of its tax treatment, nets returns and notes, and totals the boxes", { skip }, async () => {
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.equal(r.emirate, "Dubai");
  assert.deepEqual([box(r, "1b").amount, box(r, "1b").vat], [60, 3], "200 - 40 return - 100 credit note; VAT 10 - 2 - 5");
  assert.deepEqual([box(r, "4").amount, box(r, "4").vat], [100, 0], "zero-rated");
  assert.deepEqual([box(r, "5").amount, box(r, "5").vat], [100, 0], "exempt");
  assert.deepEqual([box(r, "8").amount, box(r, "8").vat], [260, 3]);
  assert.deepEqual([box(r, "9").amount, box(r, "9").vat], [1200, 60], "the purchase and the rent");
  assert.deepEqual([box(r, "11").amount, box(r, "11").vat], [1200, 60]);
  assert.equal(box(r, "12").vat, 3);
  assert.equal(box(r, "13").vat, 60);
  assert.equal(box(r, "14").vat, -57);
  assert.equal(box(r, "14").label, "Net VAT refundable");
  assert.deepEqual(r.totals, { outputVat: 3, recoverableVat: 60, netPayable: -57 });
  assert.equal(r.currency, "AED");
});

test("a 0% line with no tax code is listed for the user to classify, not guessed into a box", { skip }, async () => {
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.equal(r.unclassified.count, 1);
  assert.equal(r.unclassified.amount, 30);
  assert.ok(r.unclassified.lines[0].docNo.startsWith("SO-"));
  assert.ok(r.notTracked.some((b) => b.box === "6"), "imports are said to be not tracked yet");
});

test("the VAT in the boxes agrees with the VAT accounts of the ledger", { skip }, async () => {
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  const [out, inp] = r.reconciliation.rows;
  assert.equal(out.documents, 3);
  assert.equal(out.ledger, 3);
  assert.equal(out.agrees, true);
  assert.equal(inp.documents, 60);
  assert.equal(inp.ledger, 60);
  assert.equal(inp.agrees, true);

  // an adjustment made behind the documents' backs shows up as a difference
  const vatId = await svc.Config.resolveAccount("vat-sales");
  const acc = await svc.LedgerAccount.findById(vatId);
  await svc.LedgerEntry.create({ voucherId: new mongoose.Types.ObjectId(), voucherNo: "X-1", voucherType: "journal", accountId: acc._id, accountName: acc.accountName, accountCode: acc.accountCode, date: new Date(), creditAmount: 7, createdBy: admin });
  const after = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.equal(after.reconciliation.rows[0].difference, -7);
  assert.equal(after.reconciliation.rows[0].agrees, false);
  await svc.LedgerEntry.deleteOne({ voucherNo: "X-1" });
});

test("a period with nothing in it is all zero, and a bad period is refused", { skip }, async () => {
  const r = await svc.Vat.compute({ from: orgDay(-40), to: orgDay(-30) });
  assert.equal(r.totals.netPayable, 0);
  assert.equal(r.unclassified.count, 0);
  await assert.rejects(() => svc.Vat.compute({ from: orgDay(1), to: orgDay(-1) }), { code: "INVALID_PERIOD" });
  await assert.rejects(() => svc.Vat.compute({ from: "", to: orgDay() }), { code: "PERIOD_REQUIRED" });
});

test("drafts, cancelled documents and opening invoices never reach the return", { skip }, async () => {
  const draft = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty: 1, price: 1000, rate: 1000, vatPercent: 5 }] }, "tester");
  const before = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.equal(box(before, "1b").vat, 3, "a draft is not in the return");
  await svc.Tx.processTransaction(draft._id, "approve", "tester");
  assert.equal(box(await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) }), "1b").vat, 53);
  await svc.Transaction.updateOne({ _id: draft._id }, { status: "CANCELLED" });
  assert.equal(box(await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) }), "1b").vat, 3, "once cancelled it is out again");
  // an opening invoice carried over from old books has no VAT and is not in the return either
  const opening = await svc.Transaction.create({ transactionNo: "OSI-T-1", type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), status: "APPROVED", isOpening: true, totalAmount: 900, outstandingAmount: 900, createdBy: "tester", items: [] });
  assert.equal(box(await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) }), "1b").vat, 3);
  await opening.deleteOne();
  await svc.Transaction.deleteOne({ _id: draft._id });
  await svc.LedgerEntry.deleteMany({ voucherId: draft._id });
});

test("reverse-charge purchases are reported in box 3 and box 10 with the VAT worked out", { skip }, async () => {
  const doc = await svc.Transaction.create({
    transactionNo: "PO-RCM-1", type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", date: new Date(), status: "APPROVED", totalAmount: 400, createdBy: "tester",
    items: [{ itemId: stock._id, description: "Imported spice", qty: 4, price: 100, rate: 100, vatPercent: 5, vatAmount: 0, taxableAmount: 400, grossAmount: 400, lineTotal: 400, taxKind: "reverse_charge" }],
  });
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.deepEqual([box(r, "3").amount, box(r, "3").vat], [400, 20]);
  assert.deepEqual([box(r, "10").amount, box(r, "10").vat], [400, 20]);
  assert.equal(box(r, "12").vat, 23, "the self-assessed VAT is due...");
  assert.equal(box(r, "13").vat, 80, "...and recoverable");
  await doc.deleteOne();
});

test("the detail lists each document with its party, TRN, treatment and VAT, and filters", { skip }, async () => {
  const d = await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1) });
  assert.ok(d.total >= 8);
  const sale = d.rows.find((r) => r.docType === "sales_order" && r.vat === 10);
  assert.equal(sale.partyName, "Al Noor");
  assert.equal(sale.trn, "100999888700003");
  assert.deepEqual(sale.kinds, ["standard"]);
  assert.equal((await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), direction: "input" })).rows.every((r) => r.direction === "input"), true);
  assert.ok((await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), kind: "zero_rated" })).rows.length >= 1);
  assert.equal((await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), search: "gulf" })).rows.every((r) => r.partyName === "Gulf Mills" || r.source !== "invoice"), true);
  assert.equal((await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), limit: 3, page: 2 })).rows.length, 3);
});

test("a return is saved as a draft, finalised only when every line has a treatment, and filed with the FTA reference", { skip }, async () => {
  const from = orgDay(-1);
  const to = orgDay(1);
  const draft = await svc.Vat.createDraft({ from, to, notes: "Q3" }, admin);
  assert.equal(draft.status, "DRAFT");
  assert.equal(draft.returnNo, `VAT-${from}..${to}`);
  assert.equal(draft.totals.netPayable, -57);
  const again = await svc.Vat.createDraft({ from, to }, admin);
  assert.equal(String(again._id), String(draft._id), "saving the same period again replaces the draft");

  await assert.rejects(() => svc.Vat.finalize(draft._id, admin), { code: "UNCLASSIFIED_LINES" });
  await assert.rejects(() => svc.Vat.file(draft._id, admin, { reference: "X" }), { code: "NOT_FINALIZED" });
  const fin = await svc.Vat.finalize(draft._id, admin, { allowUnclassified: true });
  assert.equal(fin.status, "FINALIZED");
  assert.equal(fin.unclassifiedLines, 1);
  await assert.rejects(() => svc.Vat.createDraft({ from, to }, admin), { code: "PERIOD_OVERLAP" });
  await assert.rejects(() => svc.Vat.remove(draft._id), { code: "NOT_DRAFT" });

  await assert.rejects(() => svc.Vat.file(draft._id, admin, { reference: "  " }), { code: "REFERENCE_REQUIRED" });
  const filed = await svc.Vat.file(draft._id, admin, { reference: "FTA-123456", filedOn: "2026-10-28" });
  assert.equal(filed.status, "FILED");
  assert.equal(filed.filingReference, "FTA-123456");

  // the saved boxes are a record: a later document does not change them
  await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: stock._id, description: "Rice", qty: 1, price: 20, rate: 20, vatPercent: 5 }] }, "t")
    .then((t) => svc.Tx.processTransaction(t._id, "approve", "t"));
  assert.equal((await svc.Vat.get(draft._id)).totals.outputVat, 3);
  assert.equal((await svc.Vat.list()).length, 1);
});
