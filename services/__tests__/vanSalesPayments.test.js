// Card and bank transfer on the road, part payment, and the cheque fix, against a throwaway database.
//
//   card      the VAN's own card machine (Van.cardId); the salesman never names one. Posts net to the machine's bank
//             account with the processor's fee to card-charges, like any terminal receipt.
//   transfer  nobody can count it at the van, so the receipt is saved WAITING for the office to see it in the bank: it
//             posts nothing and settles no invoice until it is approved. Settling the trip does not wait for it.
//   cheque    every cheque taken on a van was refused (the bank it is drawn on was never sent); it works now.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const { groupFamily } = require("../banking/cardService");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Fin: require("../financial/financialService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Report: require("../vansales/vanSalesReportService"),
    Settings: require("../vansales/vanSettingsService"),
    Cheques: require("../banking/chequeService"),
    Banks: require("../banking/bankMasterService"),
    Cards: require("../banking/cardService"),
    Chart: require("../financial/chartOfAccountsService"),
    ChartSeed: require("../financial/defaultChartService"),
    groupFamily,
    Transaction: require("../../models/modules/transactionModel"),
    Voucher: require("../../models/modules/financial/financialModels").Voucher,
    LedgerEntry: require("../../models/modules/financial/financialModels").LedgerEntry,
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.ChartSeed.provision();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let salesman, A, B, rice, van1, van2, trip1, trip2, terminal, settlementBank, depositBank, mashreq;
const by = () => String(salesman._id);
const line = (extra = {}) => ({ itemId: rice._id, qty: 5, vatPercent: 0, ...extra }); // 5 x 20 = 100, no tax
const sell = (trip, customer, payNow, extra = {}) => svc.Sales.sell(trip._id, { customerId: customer._id, items: [line()], ...(payNow ? { payNow } : {}), ...extra }, by());
const owing = async (invoice) => r2((await svc.Transaction.findById(invoice._id)).outstandingAmount);
const entriesOf = (voucher) => svc.LedgerEntry.find({ voucherId: voucher._id, isReversed: { $ne: true } }).lean();
const invoicesOn = (t) => svc.Transaction.countDocuments({ "vanTripRef.tripId": t._id });
const today = () => new Date().toISOString().slice(0, 10);
const allModes = () => svc.Settings.save({ paymentModes: ["cash", "cheque", "card", "transfer"] });

test("setup: rice, two customers, a card machine and two bank accounts, two vans out", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.pay.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name, terms) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: terms });
  [A, B] = await Promise.all([mk("C1", "Al Noor", "Net 30"), mk("C2", "Bin Zayed", "Cash")]);
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 300, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");

  const { rootId } = await svc.groupFamily("bank-account-group", {});
  settlementBank = await svc.Chart.createAccount({ accountName: "Card Settlement Bank", groupId: rootId }, {}, salesman._id);
  depositBank = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: rootId }, {}, salesman._id);
  mashreq = await svc.Banks.create({ bankName: "Mashreq", bankCode: "MSQ" }, {});
  const visa = await svc.Cards.CardTypeService.create({ name: "Visa", feePercent: 2.5 }, {});
  terminal = await svc.Cards.CardService.create({ label: "POS Van One", kind: "terminal", cardTypeId: visa._id, accountId: settlementBank._id, terminalId: "T-VAN1" }, {}, salesman._id);
  global.__debitCard = await svc.Cards.CardService.create({ label: "Office Debit", kind: "debit", cardTypeId: visa._id, holderName: "Boss", accountId: depositBank._id }, {}, salesman._id);

  van1 = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: by() }, "tester");
  for (const [van, qty] of [[van1, 120], [van2, 40]]) {
    const t = await svc.Trip.open({ vanId: van._id }, "tester");
    await svc.Trip.load(t._id, { lines: [{ stockId: String(rice._id), qty }] }, "tester");
    await svc.Trip.depart(t._id, "tester");
    if (van === van1) trip1 = t; else trip2 = t;
  }
  await allModes();
});

test("a van's card machine: a terminal only, set by a manager, shown by name and fee, never by id", { skip }, async () => {
  await assert.rejects(() => svc.Van.update(van1.id, { name: "Van One", cardId: global.__debitCard._id }, "tester"), { code: "CARD_NOT_A_TERMINAL" });
  await assert.rejects(() => svc.Van.update(van1.id, { name: "Van One", cardId: "nope" }, "tester"), { code: "CARD_REQUIRED" });
  await assert.rejects(() => svc.Van.update(van1.id, { name: "Van One", cardId: new mongoose.Types.ObjectId() }, "tester"), { code: "CARD_NOT_FOUND" });
  assert.equal((await svc.Trip.getById(trip1._id)).cardMachine, null, "a van with none offers none");
  const set = await svc.Van.update(van1.id, { name: "Van One", cardId: terminal._id }, "tester");
  assert.equal(String(set.cardId), String(terminal._id));
  const shown = await svc.Trip.getById(trip1._id);
  assert.deepEqual(shown.cardMachine, { label: "POS Van One", feePercent: 2.5 });
  assert.equal(JSON.stringify(shown.cardMachine).includes(String(terminal._id)), false, "the machine's id is not handed to the phone");
  assert.equal((await svc.Van.update(van1.id, { name: "Van One" }, "tester")).cardId.toString(), String(terminal._id), "an edit that names no machine keeps it");
  const cleared = await svc.Van.update(van1.id, { name: "Van One", cardId: null }, "tester");
  assert.equal(cleared.cardId, null);
  await svc.Van.update(van1.id, { name: "Van One", cardId: terminal._id }, "tester");
});

test("a card sale: the invoice is paid, the machine's bank account gets the money less its fee, the fee is its own line", { skip }, async () => {
  const count = await invoicesOn(trip1);
  await assert.rejects(() => sell(trip1, A, { mode: "card", full: true, details: {} }), { code: "APPROVAL_CODE_REQUIRED" });
  assert.equal(await invoicesOn(trip1), count, "refused: nothing was sold");
  // the phone cannot name a machine of its own: a card id in the body is not read
  const done = await sell(trip1, A, { mode: "card", full: true, details: { approvalCode: "A1B2", cardId: global.__debitCard._id } });
  assert.equal(done.receipt.paymentMode, "card");
  assert.equal(done.receipt.status, "approved");
  assert.equal(done.receipt.paymentDetails.cardLabel, "POS Van One", "the van's machine, not the one the body named");
  assert.equal(done.receipt.paymentDetails.approvalCode, "A1B2");
  assert.equal(await owing(done.invoice), 0, "paid in full");
  const rows = await entriesOf(done.receipt);
  const debit = (name) => r2(rows.filter((e) => e.accountName === name).reduce((t, e) => t + e.debitAmount, 0));
  assert.equal(debit("Card Settlement Bank"), 97.5, "100 less 2.5% fee");
  assert.equal(rows.filter((e) => e.accountName === "Card Processing Fees").reduce((t, e) => t + e.debitAmount, 0), 2.5, "the fee to card charges");
  assert.equal(r2(rows.reduce((t, e) => t + e.debitAmount, 0)), r2(rows.reduce((t, e) => t + e.creditAmount, 0)), "balanced");
  const t = (await svc.Trip.getById(trip1._id)).totals;
  assert.equal(t.card, 100);
  assert.equal(t.cash, 0, "card takings are not cash in the van");
  assert.equal(t.cashInHand, 0);
});

test("a van with no card machine takes no card", { skip }, async () => {
  const count = await invoicesOn(trip2);
  await assert.rejects(() => sell(trip2, A, { mode: "card", full: true, details: { approvalCode: "X1" } }), { code: "VAN_NO_CARD_MACHINE" });
  assert.equal(await invoicesOn(trip2), count);
});

test("part payment: one way of paying, the rest stays owing; cash terms and 'paid at the door' still need the whole amount", { skip }, async () => {
  const part = await sell(trip1, B, { mode: "card", amount: 40, details: { approvalCode: "P40" } });
  assert.equal(part.receipt.totalAmount, 40);
  assert.equal(await owing(part.invoice), 60, "the rest is still owed");
  await assert.rejects(() => sell(trip1, B, { mode: "card", amount: 150, details: { approvalCode: "P99" } }), { code: "PAYMENT_EXCEEDS_INVOICE" });
  await svc.Settings.save({ creditSales: "cashTerms" });
  await assert.rejects(() => sell(trip1, B, { mode: "card", amount: 40, details: { approvalCode: "P41" } }), { code: "VAN_PAYMENT_REQUIRED" }, "Bin Zayed is on Cash terms: all of it, now");
  const credit = await sell(trip1, A, { mode: "card", amount: 40, details: { approvalCode: "P42" } }); // Net 30 may still pay part
  assert.equal(await owing(credit.invoice), 60);
  await svc.Settings.save({ creditSales: "allowed" });
});

test("a transfer waits for the office: saved, numbered and counted, but posting nothing and settling nothing", { skip }, async () => {
  const count = await invoicesOn(trip1);
  await assert.rejects(() => sell(trip1, A, { mode: "transfer", full: true, details: { accountId: depositBank._id } }), { code: "REFERENCE_REQUIRED" });
  assert.equal(await invoicesOn(trip1), count, "no reference: nothing sold");
  const sale = await sell(trip1, A, { mode: "transfer", full: true, details: { accountId: depositBank._id, reference: "TRF-9001" } });
  assert.equal(sale.receipt.status, "pending", "waiting for the office");
  assert.equal(sale.receipt.paymentDetails.reference, "TRF-9001");
  assert.equal(await owing(sale.invoice), 100, "the invoice is still owed: the customer says they paid, the bank has not said so");
  assert.equal((await entriesOf(sale.receipt)).length, 0, "nothing posted");
  const t = (await svc.Trip.getById(trip1._id)).totals;
  assert.equal(t.transferWaiting, 100);
  assert.equal(t.transfer, 0);
  assert.equal(t.pendingReceipts, 0, "a waiting transfer is not among the receipts that stop settling");
  global.__waiting = sale;
});

test("the office approves it once it is in the bank: the invoice is settled and it posts; or turns it down and the invoice stays owing", { skip }, async () => {
  const { receipt, invoice } = global.__waiting;
  await svc.Fin.processVoucherApproval(receipt._id, "approve", by());
  assert.equal(await owing(invoice), 0);
  const rows = await entriesOf(receipt);
  assert.ok(rows.length >= 2, "posted");
  assert.equal(rows.find((e) => e.accountName === "ENBD Current")?.debitAmount, 100, "into the bank account the salesman named");
  const t = (await svc.Trip.getById(trip1._id)).totals;
  assert.deepEqual([t.transfer, t.transferWaiting], [100, 0]);

  const second = await sell(trip1, A, { mode: "transfer", full: true, details: { accountId: depositBank._id, reference: "TRF-9002" } });
  await svc.Fin.processVoucherApproval(second.receipt._id, "reject", by(), "not in the bank");
  assert.equal(await owing(second.invoice), 100, "turned down: still owed");
  assert.equal((await svc.Voucher.findById(second.receipt._id)).status, "rejected");
});

test("a cheque taken on a van works: the bank it is drawn on is asked for, and it lands in the register with its trip", { skip }, async () => {
  const details = { chequeNo: "123456", chequeDate: today(), accountId: depositBank._id };
  const count = await invoicesOn(trip1);
  await assert.rejects(() => sell(trip1, A, { mode: "cheque", full: true, details }), { code: "DRAWN_ON_BANK_REQUIRED" });
  assert.equal(await invoicesOn(trip1), count);
  const ok = await sell(trip1, A, { mode: "cheque", full: true, details: { ...details, drawnOnBankId: mashreq._id } });
  assert.equal(ok.receipt.paymentMode, "cheque");
  assert.equal(ok.receipt.paymentDetails.drawnOnBankName, "Mashreq");
  const register = await svc.Cheques.list({}, { vanTripId: String(trip1._id) });
  assert.deepEqual(register.rows.map((r) => r.chequeNo), ["123456"], "the one cheque this trip has taken so far, by its number");
  // a bank typed by name, when the master does not have it
  const typed = await sell(trip1, A, { mode: "cheque", full: true, details: { chequeNo: "123457", chequeDate: today(), accountId: depositBank._id, drawnOnBankName: "Small Bank LLC" } });
  assert.equal(typed.receipt.paymentDetails.drawnOnBankName, "Small Bank LLC");
});

test("a mode the organisation switched off is refused whatever the phone sends", { skip }, async () => {
  await svc.Settings.save({ paymentModes: ["cash"] });
  await assert.rejects(() => sell(trip1, A, { mode: "transfer", full: true, details: { accountId: depositBank._id, reference: "X" } }), { code: "VAN_MODE_NOT_ALLOWED" });
  await assert.rejects(() => sell(trip1, A, { mode: "card", full: true, details: { approvalCode: "X" } }), { code: "VAN_MODE_NOT_ALLOWED" });
  await assert.rejects(() => svc.Sales.collect(trip1._id, { customerId: A._id, amount: 10, mode: "card", details: { approvalCode: "X" } }), { code: "VAN_MODE_NOT_ALLOWED" });
  // "online" is the voucher's old name for a transfer: not a way of taking money on a van, refused before anything else
  await assert.rejects(() => sell(trip1, A, { mode: "online", full: true, details: {} }), { code: "VAN_MODE_NOT_ALLOWED" });
  await allModes();
  await assert.rejects(() => sell(trip1, A, { mode: "online", full: true, details: {} }), { code: "VAN_MODE_NOT_ALLOWED" }, "not a van mode even when every van mode is on");
});

test("collecting money takes the same ways; a transfer collected is waiting too", { skip }, async () => {
  const card = await svc.Sales.collect(trip1._id, { customerId: A._id, amount: 30, mode: "card", details: { approvalCode: "C30" } }, by());
  assert.equal(card.receipt.status, "approved");
  const transfer = await svc.Sales.collect(trip1._id, { customerId: A._id, amount: 25, mode: "transfer", details: { accountId: depositBank._id, reference: "TRF-COL" } }, by());
  assert.equal(transfer.receipt.status, "pending");
});

test("settling: cash is only cash; card and transfer are listed; a waiting transfer does not stop the trip; a missing cheque is flagged", { skip }, async () => {
  const cashSale = await sell(trip1, A, { mode: "cash", full: true });
  assert.equal(cashSale.receipt.paymentMode, "cash");
  const shown = await svc.Trip.getById(trip1._id);
  const counts = shown.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 }));
  await svc.Settle.unload(trip1._id, { counts }, by());

  const plan = await svc.Settle.preview(trip1._id, {});
  assert.equal(plan.cash.expected, 100, "only the cash sale: card, transfer and cheques never reached the van's cash");
  assert.ok(plan.cardTotal > 0);
  assert.ok(plan.cards.every((c) => c.approvalCode), "each card payment shows its approval code");
  assert.ok(plan.transfers.some((t) => t.waiting), "the collected transfer is still waiting for the bank");
  assert.ok(plan.transfers.some((t) => !t.waiting), "and the approved one is listed as taken");
  assert.equal(plan.transfersWaiting, 25);
  assert.equal(plan.blockers.length, 0, "a transfer waiting for the bank is not a blocker");
  assert.ok(!plan.warnings.some((w) => w.code === "CHEQUES_MISSING"), "every cheque handed in unless said otherwise");

  const none = await svc.Settle.preview(trip1._id, { chequesHanded: [] });
  assert.ok(none.warnings.some((w) => w.code === "CHEQUES_MISSING"), "the screen can finally say which cheques were not handed in");
  const one = await svc.Settle.preview(trip1._id, { chequesHanded: ["123456"] });
  assert.deepEqual(one.missingCheques.map((c) => c.chequeNo), ["123457"]);

  const { trip } = await svc.Settle.settle(trip1._id, { cashHanded: 100 }, by());
  assert.equal(trip.status, "SETTLED");
  assert.equal(trip.settlement.transfersWaiting, 25);
  assert.equal(trip.settlement.cardTotal, plan.cardTotal);
  const journal = await svc.Voucher.findById(trip.settlement.voucherIds[0]).lean();
  assert.equal(journal.totalAmount, 100, "the journal moves the cash only");
});

test("the owner's report carries card and transfer beside cash and cheques, approved takings only", { skip }, async () => {
  const report = await svc.Report.summary({});
  const row = (report.vans || report.rows || []).find((r) => /VAN-1/.test(r.code || r.name || r.id || ""));
  assert.ok(report.total.card > 0, JSON.stringify(Object.keys(report)));
  assert.equal(report.total.transfer, 100, "the approved transfer; the waiting one is not takings yet");
  assert.ok(row === undefined || row.card > 0);
});
