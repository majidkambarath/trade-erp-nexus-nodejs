// Reverse-charge VAT: priced, posted to the ledger and reconciled to the VAT 201 return, against a throwaway database
// (random name, dropped afterwards).
//
// The rule (UAE VAT Decree-Law Art. 48; FTA VAT Returns User Guide boxes 3 and 10): when the supplier charges no VAT (services from
// abroad, some local supplies) the BUYER assesses it. The buyer's document therefore
//   - prices to the net (the supplier is owed no VAT), with the assessed VAT as its own figure beside the total,
//   - posts Dr Input VAT / Cr Reverse-charge VAT for that figure (a return posts the reverse), leaving the vendor's balance alone,
//   - appears in box 3 (output) and box 10 (input) of the return, and reconciles to the ledger.
// The supplier's own sale of the same kind charges no VAT and owes none: it posts none and is in no box.
//
//   node --require ./utils/testSetup.js --test services/__tests__/reverseCharge.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Q: require("../orderPurchase/quotationService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Vat: require("../reports/vatReturnService"),
    Ifrs: require("../reports/ifrsReportsService"),
    Dashboard: require("../reports/dashboardService"),
    TaxCodes: require("../financial/taxCodeService"),
    Chart: require("../financial/defaultChartService"),
    ei: require("../../utils/eInvoice"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    StockService: require("../stock/stockService"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- fixtures ----
let vendor, customer, rice, spice, consulting, rc, std;
const L = (item, qty, price, extra = {}) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
const RC = () => ({ taxCodeId: rc._id });
const STD = () => ({ taxCodeId: std._id });
const doc = (type, party, partyType, items, extra = {}) =>
  svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, ...extra }, "tester");
const buy = (items, extra) => doc("purchase_order", vendor, "Vendor", items, extra);
const sell = (items, extra) => doc("sales_order", customer, "Customer", items, extra);
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const buyApproved = async (items, extra) => approve(await buy(items, extra));
const entriesOf = (t) => svc.LedgerEntry.find({ voucherId: t._id }).lean();
const live = async (t) => (await entriesOf(t)).filter((e) => !e.isReversed);
// debit - credit per account NAME across a document's live entries (zero accounts left out)
async function byAccount(t) {
  const out = {};
  for (const e of await live(t)) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}
const sumOf = (m) => r2(Object.values(m).reduce((t, v) => t + v, 0));
const liveNet = async (name) => {
  const acc = await svc.LedgerAccount.findOne({ accountName: name }).lean();
  const rows = await svc.LedgerEntry.find({ accountId: acc._id, isReversed: { $ne: true } }).lean();
  return r2(rows.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0));
};
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const vendorOwed = async () => r2((await svc.Vendor.findById(vendor._id).lean()).cashBalance);
const box = (r, id) => r.boxes.find((b) => b.box === id);

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", paymentTerms: "Net 30", trnNumber: "100999888700003" });
  const category = await svc.Category.create({ name: "General" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: category._id });
  spice = await svc.Stock.create({ itemId: "SPICE", sku: "SPICE", itemName: "Imported spice", category: category._id });
  consulting = await svc.StockService.createStock({ categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "SRV-CONSULT", itemName: "Consulting", itemType: "service", salesPrice: 500, purchasePrice: 500 }, "tester");
  rc = await svc.TaxCode.findOne({ kind: "reverse_charge" }).lean();
  std = await svc.TaxCode.findOne({ kind: "standard" }).lean();
  assert.ok(rc && std);
});

// ===================================== the tax code =====================================

test("a UAE company has a 'Reverse charge 5%' starter code; an older company is topped up once, a company's own code is respected", { skip }, async () => {
  assert.equal(rc.name, "Reverse charge 5%");
  assert.equal(rc.ratePercent, 5);
  assert.equal(rc.kind, "reverse_charge");

  const { companyId } = require("../../utils/tenant").getTenant();
  // a company that has the other starters but predates this one
  await svc.TaxCode.deleteOne({ _id: rc._id });
  assert.equal(await svc.TaxCodes.ensureStarter(companyId), 1, "only the missing kind is added");
  assert.equal(await svc.TaxCodes.ensureStarter(companyId), 0, "and only once");
  assert.equal(await svc.TaxCode.countDocuments({ kind: "reverse_charge" }), 1);
  assert.equal(await svc.TaxCode.countDocuments({ kind: "standard" }), 1, "nothing else was duplicated");

  // reading the tax codes tops up too (what an existing company meets), through the same rule
  await svc.TaxCode.deleteOne({ kind: "reverse_charge" });
  assert.equal(await svc.Chart.topUpTaxCodes({}), 1);
  assert.equal(await svc.Chart.topUpTaxCodes({}), 0);

  // a company that made its own reverse-charge code under another name does not get a second
  const back = await svc.TaxCode.findOne({ kind: "reverse_charge" });
  back.name = "Import of services";
  await back.save();
  assert.equal(await svc.TaxCodes.ensureStarter(companyId), 0);
  assert.equal(await svc.TaxCode.countDocuments({ kind: "reverse_charge" }), 1);
  back.name = "Reverse charge 5%";
  await back.save();
  rc = await svc.TaxCode.findOne({ kind: "reverse_charge" }).lean();
});

// ===================================== pricing =====================================

test("a reverse-charge line prices to the net: no VAT in the line or the vendor's total, the assessed VAT beside them", { skip }, async () => {
  const t = await buy([L(spice, 100, 10, RC()), L(rice, 20, 10, STD())]);
  const [a, b] = t.items;
  assert.equal(a.taxKind, "reverse_charge");
  assert.equal(a.vatAmount, 0);
  assert.equal(a.lineTotal, 1000, "the supplier is owed the net");
  assert.equal(a.rcmVat, 50, "5% of 1000, assessed by us");
  assert.equal(a.vatPercent, 5);
  assert.equal(b.rcmVat, undefined, "an ordinary line carries no assessed VAT");
  assert.equal(b.vatAmount, 10);
  assert.equal(t.pricing.rcmVat, 50);
  assert.equal(t.pricing.lineVat, 10, "only the VAT the supplier charged");
  assert.equal(t.totalAmount, 1210, "1000 + 200 + 10: the assessed 50 is owed to no one");
  assert.equal(t.pricing.grandTotal, 1210);
  await svc.Tx.deleteTransaction(t._id, "tester");
});

test("a document with no reverse-charge line is priced exactly as before", { skip }, async () => {
  const t = await buy([L(rice, 20, 10, STD())]);
  assert.equal(t.items[0].rcmVat, undefined);
  assert.equal(t.pricing.rcmVat, 0);
  assert.deepEqual([t.items[0].vatAmount, t.items[0].lineTotal, t.totalAmount], [10, 210, 210]);
  await svc.Tx.deleteTransaction(t._id, "tester");
});

test("editing a draft re-derives the assessed VAT: a stale or forged figure is not kept, and a line that stops being reverse charge loses it", { skip }, async () => {
  const t = await buy([L(spice, 10, 100, { ...RC(), rcmVat: 999 })]); // a request cannot name the figure
  assert.equal(t.items[0].rcmVat, 50);

  // change the code to a standard one: ordinary VAT comes back, the assessed figure goes
  const std1 = await svc.Tx.updateTransaction(t._id, { items: [L(spice, 10, 100, STD())] }, "tester");
  assert.equal(std1.items[0].taxKind, "standard");
  assert.equal(std1.items[0].rcmVat, undefined);
  assert.equal(std1.items[0].vatAmount, 50);
  assert.equal(std1.totalAmount, 1050);
  assert.equal(std1.pricing.rcmVat, 0);

  // and back; a charge-only edit re-prices the stored lines without losing it
  const back = await svc.Tx.updateTransaction(t._id, { items: [L(spice, 10, 100, RC())] }, "tester");
  assert.equal(back.totalAmount, 1000);
  const withFreight = await svc.Tx.updateTransaction(t._id, { charges: [{ description: "Freight", amount: 40, vatPercent: 5 }] }, "tester");
  assert.equal(withFreight.items[0].rcmVat, 50);
  assert.equal(withFreight.pricing.rcmVat, 50);
  assert.equal(withFreight.pricing.chargesVat, 2, "freight is taxed as it always was");
  assert.equal(withFreight.totalAmount, 1042);
  await svc.Tx.deleteTransaction(t._id, "tester");
});

test("quotations and delivery notes price a reverse-charge line the same way and keep the assessed VAT", { skip }, async () => {
  const q = await svc.Q.create({ partyId: customer._id, validUntil: orgDay(30), items: [L(consulting, 2, 250, RC())] }, "tester");
  assert.deepEqual([q.items[0].vatAmount, q.items[0].lineTotal, q.items[0].rcmVat, q.totalAmount, q.pricing.rcmVat], [0, 500, 25, 500, 25]);
  const stored = await mongoose.model("Quotation").findById(q._id).lean();
  assert.equal(stored.items[0].rcmVat, 25, "the column is in the schema, not dropped on save");

  const so = await sell([L(rice, 10, 50, RC())]);
  const note = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 4 }] }, "t");
  assert.deepEqual([note.items[0].vatAmount, note.items[0].rcmVat, note.totalAmount], [0, 10, 200], "4 x 50, 5% assessed");
  await svc.D.dispatch(note._id, {}, "t");
  const done = await svc.D.deliver(note._id, { receivedBy: "Store", lines: [{ lineId: note.items[0]._id, deliveredQty: 3, shortReason: "1 damaged" }] }, "t");
  assert.deepEqual([done.items[0].lineTotal, done.items[0].rcmVat, done.totalAmount, done.pricing.rcmVat], [150, 7.5, 150, 7.5], "repriced to the quantity accepted");
  await svc.Tx.deleteTransaction(so._id, "tester"); // the note is released with it
  await mongoose.model("DeliveryNote").deleteMany({});
  await mongoose.model("Quotation").deleteMany({});
});

// ===================================== posting =====================================

test("a purchase with a reverse-charge goods line: stock at the net, Dr Input VAT / Cr Reverse-charge VAT, the vendor owed only what the supplier charged", { skip }, async () => {
  const owedBefore = await vendorOwed();
  const t = await buyApproved([L(spice, 100, 10, RC()), L(rice, 20, 10, STD())]);
  assert.equal(await onHand(spice), 100);
  assert.equal((await svc.Stock.findById(spice._id)).purchasePrice, 10, "cost is the net: the assessed VAT is not part of it");

  const a = await byAccount(t);
  assert.deepEqual(a, { "Inventory Stock": 1200, "Input VAT": 60, "Reverse-charge VAT": -50, "Vendor - Vend": -1210 });
  assert.equal(sumOf(a), 0, "the document balances");
  assert.equal(await vendorOwed() - owedBefore, 1210, "the party statement, credit control and payables never include the assessed VAT");
  assert.equal(t.pricing.rcmVat, 50);

  // the voucher is the document: every leg is its own, and a reversal takes them all
  await svc.Tx.deleteTransaction(t._id, "tester");
  assert.deepEqual(await byAccount(t), {});
  assert.equal(await onHand(spice), 0);
  assert.equal(await vendorOwed(), owedBefore);
});

test("a reverse-charge SERVICE is expensed for the net with the assessed VAT booked, and no inventory leg or stock movement", { skip }, async () => {
  const t = await buyApproved([L(consulting, 1, 500, RC())]);
  assert.deepEqual(await byAccount(t), { "Purchased Services": 500, "Input VAT": 25, "Reverse-charge VAT": -25, "Vendor - Vend": -500 });
  assert.equal(await svc.Movement.countDocuments({ referenceId: t._id }), 0, "a service moves no stock");
  assert.equal(t.totalAmount, 500);
  await svc.Tx.deleteTransaction(t._id, "tester");
  assert.deepEqual(await byAccount(t), {});
});

test("a mixed document (reverse-charge goods, a reverse-charge service, an ordinary line) posts every leg and balances", { skip }, async () => {
  const t = await buyApproved([L(spice, 4, 100, RC()), L(consulting, 1, 500, RC()), L(rice, 2, 100, STD())]);
  assert.equal(t.totalAmount, 1110, "400 + 500 + 200 + 10");
  assert.equal(t.pricing.rcmVat, 45);
  const a = await byAccount(t);
  assert.deepEqual(a, { "Inventory Stock": 600, "Purchased Services": 500, "Input VAT": 55, "Reverse-charge VAT": -45, "Vendor - Vend": -1110 });
  assert.equal(sumOf(a), 0);
  await svc.Tx.deleteTransaction(t._id, "tester");
  assert.deepEqual(await byAccount(t), {});
});

test("a purchase return of a reverse-charge line is reverse charge too, even though the form sends no tax code, and reverses the assessed VAT", { skip }, async () => {
  const buyDoc = await buyApproved([L(spice, 4, 100, RC()), L(rice, 2, 100, STD())]);
  const owed = await vendorOwed();
  // the return form sends the line's price and VAT % and no tax code (it never carried one)
  const ret = await doc("purchase_return", vendor, "Vendor", [L(spice, 1, 100, { returnOfLineId: buyDoc.items[0]._id }), L(rice, 1, 100, { returnOfLineId: buyDoc.items[1]._id })], { returnOf: { transactionId: buyDoc._id } });
  assert.deepEqual([ret.items[0].taxKind, ret.items[0].vatAmount, ret.items[0].rcmVat, ret.items[0].lineTotal], ["reverse_charge", 0, 5, 100]);
  assert.deepEqual([ret.items[1].taxKind, ret.items[1].vatAmount, ret.items[1].rcmVat], [null, 5, undefined], "an ordinary line is returned as before: no code is invented for it");
  assert.equal(ret.totalAmount, 205);
  assert.equal(ret.pricing.rcmVat, 5);

  await approve(ret);
  const a = await byAccount(ret);
  assert.deepEqual(a, { "Vendor - Vend": 205, "Inventory Stock": -200, "Input VAT": -10, "Reverse-charge VAT": 5 }, "the mirror of the purchase");
  assert.equal(sumOf(a), 0);
  assert.equal(owed - await vendorOwed(), 205);
  assert.equal(await liveNet("Reverse-charge VAT"), -15, "20 assessed, 5 of it reversed");

  await svc.Tx.deleteTransaction(ret._id, "tester");
  assert.equal(await liveNet("Reverse-charge VAT"), -20, "deleting the approved return puts its assessed VAT back");
  await svc.Tx.deleteTransaction(buyDoc._id, "tester");
  assert.equal(await liveNet("Reverse-charge VAT"), 0);
  assert.equal(await liveNet("Input VAT"), 0);
});

test("a draft and a rejected document post nothing; an approved one is taken back whole by deleting it (edit, reject and delete all work by the voucher)", { skip }, async () => {
  const draft = await buy([L(consulting, 1, 500, RC())]);
  assert.deepEqual(await byAccount(draft), {}, "an unapproved document has no ledger rows");
  await svc.Tx.processTransaction(draft._id, "reject", "tester");
  assert.deepEqual(await byAccount(draft), {}, "nor does a rejected one");
  await svc.Tx.deleteTransaction(draft._id, "tester");

  const t = await buyApproved([L(consulting, 1, 500, RC())]);
  assert.equal((await byAccount(t))["Reverse-charge VAT"], -25);
  assert.equal(await liveNet("Reverse-charge VAT"), -25);
  await assert.rejects(() => svc.Tx.updateTransaction(t._id, { items: [L(consulting, 2, 500, RC())] }, "tester"), /Cannot edit processed transactions/, "an approved document is not edited in place");
  await svc.Tx.deleteTransaction(t._id, "tester");
  assert.deepEqual(await byAccount(t), {}, "every leg of the voucher goes");
  assert.equal(await liveNet("Reverse-charge VAT"), 0);
});

test("a SALE with a reverse-charge line (the supplier's side) charges and posts no VAT and never touches the Reverse-charge VAT account", { skip }, async () => {
  const stockBuy = await buyApproved([L(rice, 100, 10, STD())]); // stock to sell
  const t = await sell([L(rice, 10, 50, RC())]);
  assert.deepEqual([t.items[0].vatAmount, t.items[0].lineTotal, t.totalAmount], [0, 500, 500], "the customer is invoiced the net");
  await approve(t);
  const a = await byAccount(t);
  assert.equal(a["Customer - Cust"], 500);
  assert.equal(a["Sales Revenue"], -500);
  assert.equal(a["Output VAT"], undefined, "no output VAT: the customer accounts for it");
  assert.equal(a["Reverse-charge VAT"], undefined);
  assert.equal(a["Input VAT"], undefined);
  assert.equal(sumOf(a), 0);

  // the e-invoice line is category AE, no tax, a 0 rate, and the payload validates (what the stored document carries)
  const payload = svc.ei.buildPayload({
    transaction: t.toObject(), customer: { customerName: "Cust", trnNumber: "100999888700003", billingAddress: "x", eInvoice: { participantId: "0235:100999888700003", city: "Dubai", countryCode: "AE" } },
    seller: { legalName: "Seller LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", countryCode: "AE" }, sellerParticipantId: "0235:100123456700003",
  });
  assert.deepEqual(payload.lines.map((l) => [l.taxCategory, l.taxRatePercent, l.lineTaxAmount, l.lineNetAmount]), [["AE", 0, 0, 500]]);
  assert.equal(payload.payableAmount, 500);
  assert.deepEqual(svc.ei.validatePayload(payload), []);

  await svc.Tx.deleteTransaction(t._id, "tester");
  await svc.Tx.deleteTransaction(stockBuy._id, "tester");
});

test("an expense voucher or a note refuses a reverse-charge code instead of booking VAT nobody was paid", { skip }, async () => {
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" });
  const discounts = await svc.LedgerAccount.findOne({ accountName: "Sales Discounts Given" });
  await assert.rejects(
    () => svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 200, taxCodeId: rc._id, description: "Imported software", paymentMode: "cash", date: new Date() }, admin),
    { code: "REVERSE_CHARGE_NOT_SUPPORTED", statusCode: 400 }
  );
  await assert.rejects(
    () => svc.Financial.createVoucher({ voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: new Date(), lines: [{ accountId: discounts._id, description: "x", amount: 100, taxCodeId: rc._id }] }, admin),
    { code: "REVERSE_CHARGE_NOT_SUPPORTED" }
  );
  assert.equal(await svc.LedgerEntry.countDocuments({ isReversed: { $ne: true } }), 0, "and nothing was posted");
});

// ===================================== the VAT return =====================================
// One scenario, every box: a standard sale, a standard purchase, reverse-charge goods and a reverse-charge service bought, part of
// the goods returned, and a sale on which the customer accounts for the VAT. Everything earlier has been deleted again.

let scenario = {};
test("the VAT return: every box, with reverse charge in 3 and 10 and the net payable unchanged by it", { skip }, async () => {
  assert.equal(await svc.Transaction.countDocuments({}), 0, "every earlier test cleaned up after itself (deleting an approved document reverses it)");

  await buyApproved([L(rice, 100, 10, STD())]); // standard input 1000 / 50
  const sale = await approve(await sell([L(rice, 10, 20, STD())])); // standard output 200 / 10
  const goods = await buyApproved([L(spice, 4, 100, RC())]); // reverse charge 400 / 20
  const service = await buyApproved([L(consulting, 1, 500, RC())]); // reverse charge 500 / 25
  const ret = await approve(await doc("purchase_return", vendor, "Vendor", [L(spice, 1, 100, { returnOfLineId: goods.items[0]._id })], { returnOf: { transactionId: goods._id } })); // -100 / -5
  const supplied = await approve(await sell([L(rice, 2, 50, RC())])); // our sale, customer accounts: 100, no VAT
  scenario = { sale, goods, service, ret, supplied };

  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.deepEqual([box(r, "1b").amount, box(r, "1b").vat], [200, 10], "the standard sale");
  assert.deepEqual([box(r, "3").amount, box(r, "3").vat], [800, 40], "400 + 500 - 100 received under the reverse charge, 20 + 25 - 5 assessed; not the supplier's sale");
  assert.deepEqual([box(r, "8").amount, box(r, "8").vat], [1000, 50]);
  assert.deepEqual([box(r, "9").amount, box(r, "9").vat], [1000, 50], "box 9 never takes reverse-charge purchases");
  assert.deepEqual([box(r, "10").amount, box(r, "10").vat], [800, 40], "recovered in box 10, not box 9");
  assert.deepEqual([box(r, "11").amount, box(r, "11").vat], [1800, 90]);
  assert.equal(box(r, "12").vat, 50);
  assert.equal(box(r, "13").vat, 90);
  assert.equal(box(r, "14").vat, -40, "the reverse charge cancels itself: only the standard sale (10) against the standard purchase (50) is left");
  assert.equal(box(r, "14").label, "Net VAT refundable");
  assert.deepEqual(r.totals, { outputVat: 50, recoverableVat: 90, netPayable: -40 });
  assert.equal(r.unclassified.count, 0);

  // our sale on which the customer accounts: no output VAT, not box 3, listed apart and counted as "in no box"
  assert.deepEqual([r.customerAccounts.count, r.customerAccounts.amount], [1, 100]);
  assert.equal(r.notReported.count, 1);
});

test("the return reconciles to the ledger: output, input (with the reverse-charge input) and the Reverse-charge VAT account", { skip }, async () => {
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  const [out, inp, rcm] = r.reconciliation.rows;
  assert.deepEqual([out.label, out.documents, out.ledger, out.agrees], ["Output VAT", 10, 10, true]);
  assert.deepEqual([inp.label, inp.documents, inp.ledger, inp.agrees], ["Input VAT", 90, 90, true], "50 standard + 45 assessed - 5 returned, against the debits on Input VAT");
  assert.deepEqual([rcm.label, rcm.documents, rcm.ledger, rcm.agrees], ["Reverse-charge VAT (self-assessed)", 40, 40, true]);

  // the books balance, and the ledger's VAT accounts say what the return says
  const all = await svc.LedgerEntry.find({ isReversed: { $ne: true } }).lean();
  assert.equal(r2(all.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 0, "every voucher balances");
  assert.equal(await liveNet("Reverse-charge VAT"), -40);

  // a mismatch is still reported, honestly: an entry behind the documents' backs on the Reverse-charge VAT account
  const acc = await svc.LedgerAccount.findOne({ accountName: "Reverse-charge VAT" });
  await svc.LedgerEntry.create({ voucherId: new mongoose.Types.ObjectId(), voucherNo: "X-1", voucherType: "journal", accountId: acc._id, accountName: acc.accountName, accountCode: acc.accountCode, date: new Date(), creditAmount: 7, createdBy: admin });
  const after = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  const row = after.reconciliation.rows[2];
  assert.deepEqual([row.documents, row.ledger, row.difference, row.agrees], [40, 47, -7, false]);
  assert.equal(after.reconciliation.rows[1].agrees, true, "and only that account is out");
  await svc.LedgerEntry.deleteOne({ voucherNo: "X-1" });
});

test("the detail lists the self-assessed VAT of a document, and a company with no reverse charge sees two reconciliation rows", { skip }, async () => {
  const d = await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), kind: "reverse_charge", direction: "input" });
  assert.equal(d.rows.length, 3, "the two purchases and the return");
  assert.deepEqual(d.rows.map((x) => x.rcmVat).sort((a, b) => a - b), [-5, 20, 25]);
  assert.equal((await svc.Vat.detail({ from: orgDay(-1), to: orgDay(1), kind: "reverse_charge", direction: "output" })).rows[0].rcmVat, 0, "the supplier's sale assesses none");

  // a period before any of it: the reverse-charge row is not drawn for nothing
  const quiet = await svc.Vat.compute({ from: orgDay(-40), to: orgDay(-30) });
  assert.equal(quiet.reconciliation.rows.length, 2);
});

test("a line saved before reverse charge was posted reads exactly as before; a legacy reverse-charge SALE is no longer box 3", { skip }, async () => {
  const mk = (type, party, partyType, no, extra) => svc.Transaction.create({
    transactionNo: no, type, partyId: party._id, partyType, partyTypeRef: partyType, date: new Date(), status: "APPROVED", totalAmount: 400, createdBy: "tester",
    items: [{ itemId: spice._id, description: "old", qty: 4, price: 100, rate: 100, vatPercent: 5, vatAmount: 0, taxableAmount: 400, grossAmount: 400, lineTotal: 400, taxKind: "reverse_charge" }], ...extra,
  });
  const before = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  const oldBuy = await mk("purchase_order", vendor, "Vendor", "PO-OLD-RCM");
  const oldSale = await mk("sales_order", customer, "Customer", "SO-OLD-RCM");
  const r = await svc.Vat.compute({ from: orgDay(-1), to: orgDay(1) });
  assert.deepEqual([box(r, "3").amount - box(before, "3").amount, r2(box(r, "3").vat - box(before, "3").vat)], [400, 20], "the old purchase is worked out from the line (5%), as it was");
  assert.deepEqual([box(r, "10").amount - box(before, "10").amount, r2(box(r, "10").vat - box(before, "10").vat)], [400, 20]);
  assert.equal(r.customerAccounts.count, before.customerAccounts.count + 1, "the old sale is the supplier's: not box 3 and no output VAT");
  assert.equal(r.reconciliation.rows[2].documents, 40, "an older line is not counted against the new account: it was never posted to it");
  await oldBuy.deleteOne();
  await oldSale.deleteOne();
});

// ===================================== the VAT screens that list liabilities =====================================

test("the IFRS note and the dashboard count the Reverse-charge VAT liability once, so the net matches the return", { skip }, async () => {
  const n = await svc.Ifrs.notes({ to: orgDay(1), compare: "none" });
  const rows = n.tables.vat.rows;
  const v = Object.fromEntries(rows.map((x) => [x.key, x.amount]));
  assert.equal(v.output, 10);
  assert.equal(v.reverseCharge, 40, "the self-assessed liability is a line of its own, not folded into output or dropped");
  assert.equal(v.input, 90);
  assert.equal(n.tables.vat.net.amount, -40, "10 + 40 - 90: the same net the return shows");

  const dash = await svc.Dashboard.summary({});
  const thisMonth = dash.vat.spark[dash.vat.spark.length - 1];
  assert.equal(thisMonth.outputVat, 50, "the output VAT trend includes the assessed VAT, like box 12");
  assert.equal(dash.vat.net, -40);
});
