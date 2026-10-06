// Bank and card reconciliation end to end: a statement imported, matched to what the books hold,
// entries posted for what they do not, card sales settled, the proof, and the locks. One story in a
// throwaway database (see accountingFoundation.test.js).
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
let bank;
let savings;
let terminal;
let day;
let transit, rv, chq, pay, card1, card2, deposit;
const rows = (list) => list; // a grid is just an array of arrays
const round2 = (n) => Math.round(n * 100) / 100;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const { todayInDubai, addDays } = require("../../utils/documentExpiry");
  day = (n = 0) => addDays(todayInDubai(), n);
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Cheques: require("../banking/chequeService"),
    Chart: require("../financial/chartOfAccountsService"),
    Rec: require("../banking/reconciliationService"),
    Posting: require("../banking/reconciliationPosting"),
    Card: require("../banking/cardSettlementService"),
    ...require("../banking/cardService"),
    ...require("../../models/modules/banking/bankingModels"),
    ...require("../../models/modules/banking/reconciliationModels"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "x", creditLimit: 1e6 });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  if (!(await svc.TaxCode.findOne({ isDefault: true }))) await svc.TaxCode.create({ companyId: "default", name: "Standard 5%", kind: "standard", ratePercent: 5, isDefault: true });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const at = (n) => new Date(`${day(n)}T00:00:00.000Z`);
const dmy = (d) => d.split("-").reverse().join("/");
const bankGroup = () => svc.AccountGroup.findOne({ name: "Bank" });
const balanceOf = async (id) => {
  const [r] = await svc.LedgerEntry.aggregate([{ $match: { accountId: id, isReversed: { $ne: true } } }, { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  return round2((r?.d || 0) - (r?.c || 0));
};
const receipt = (extra) => svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 100, ...extra }, admin);
const payment = (extra) => svc.Financial.createVoucher({ voucherType: "payment", vendorId: vendor._id, totalAmount: 100, ...extra }, admin);
const legs = async (voucher) => (await svc.LedgerEntry.find({ voucherId: voucher._id, isReversed: { $ne: true } }).sort({ _id: 1 }).lean()).map((e) => `${e.accountName}:${e.debitAmount ? `Dr${e.debitAmount}` : `Cr${e.creditAmount}`}`);

// What the bank says, oldest first: [days from today, description, signed amount]. The opening
// balance is the 1,000 the books already held before the statement starts, plus a 60 deposit that was
// in transit then.
const OPENING = 1000;
const SPEC = [
  [-9, "CASH DEPOSIT", 60],
  [-8, "TRANSFER FROM AL NOOR GROCERY TRF-9001", 1050],
  [-7, "CHQ DEP 000777 AL NOOR", 500],
  [-6, "IPP PAY-1 GULF MILLS", -300],
  [-3, "NETWORK INTL SETTLEMENT 0099", 293.7],
  [-2, "BANK CHARGES INCL VAT", -21],
  [-2, "CREDIT INTEREST", 4.2],
  [-1, "TRANSFER TO SAVINGS", -250],
  [-1, "UNKNOWN DEPOSIT", 80],
  [0, "DUPLICATE FEE", -15],
];
const grid = (spec = SPEC, opening = OPENING) => {
  let run = opening;
  const body = spec.map(([n, text, amount]) => {
    run = round2(run + amount);
    return [dmy(day(n)), text, amount < 0 ? Math.abs(amount).toFixed(2) : "", amount > 0 ? amount.toFixed(2) : "", run.toFixed(2)];
  });
  return rows([["Emirates Bank - Account Statement", "", "", "", ""], ["Account 1234567", "", "", "", ""], ["Date", "Description", "Debit", "Credit", "Balance"], ...body, ["", "Total", "", "", ""]]);
};
const closing = round2(OPENING + SPEC.reduce((t, s) => t + s[2], 0));
const lineBy = (text) => svc.BankStatementLine.findOne({ description: new RegExp(text) });

// ---------------------------------------------------------------------------------- the books
test("setup: a bank account, a card terminal at 2%, and what the books already hold", { skip }, async () => {
  bank = await svc.Chart.createAccount({ accountName: "Recon Bank", groupId: (await bankGroup())._id }, {}, admin);
  savings = await svc.Chart.createAccount({ accountName: "Savings Bank", groupId: (await bankGroup())._id }, {}, admin);
  const visa = await svc.CardTypeService.create({ name: "Visa", feePercent: 2 }, {});
  terminal = await svc.CardService.create({ label: "POS 1", kind: "terminal", cardTypeId: visa._id, accountId: bank._id, terminalId: "T-001" }, {}, admin);

  // before the statement starts: 1,000 the bank has already paid, and a 60 deposit still in transit
  await receipt({ paymentMode: "bank", totalAmount: 1000, date: at(-40), paymentDetails: { accountId: bank._id, reference: "OPENING-1" } });
  transit = await receipt({ paymentMode: "bank", totalAmount: 60, date: at(-12), paymentDetails: { accountId: bank._id, reference: "SLIP-5521" } });

  rv = await receipt({ paymentMode: "transfer", totalAmount: 1050, date: at(-8), paymentDetails: { accountId: bank._id, reference: "TRF-9001", referenceDate: at(-8) } });
  chq = await receipt({ paymentMode: "cheque", totalAmount: 500, date: at(-9), paymentDetails: { accountId: bank._id, chequeNo: "000777", chequeDate: at(-9), drawnOnBankName: "ENBD" } });
  pay = await payment({ paymentMode: "transfer", totalAmount: 300, date: at(-6), paymentDetails: { accountId: bank._id, reference: "PAY-1" } });
  card1 = await receipt({ paymentMode: "card", totalAmount: 100, date: at(-5), paymentDetails: { cardId: terminal._id, approvalCode: "A100" } });
  card2 = await receipt({ paymentMode: "card", totalAmount: 200, date: at(-4), paymentDetails: { cardId: terminal._id, approvalCode: "A200" } });
  deposit = await receipt({ paymentMode: "bank", totalAmount: 77, date: at(-1), paymentDetails: { accountId: bank._id, reference: "SLIP-77" } });

  // a card sale posts its NET to the bank on the sale day, the fee to card processing fees
  assert.deepEqual(await legs(card1), ["Recon Bank:Dr98", "Card Processing Fees:Dr2", "Customer Advance - Al Noor Grocery:Cr100"]);
  assert.equal(await balanceOf(bank._id), round2(1000 + 60 + 1050 + 0 + -300 + 98 + 196 + 77), "the cheque is still in the cheques account, not the bank");
});

// ------------------------------------------------------------------------------------- setup
test("where reconciliation starts: the bank's opening balance must agree with the books, less what was outstanding", { skip }, async () => {
  const preview = await svc.Rec.setupPreview(bank._id, { startDay: day(-10) }, {});
  assert.equal(preview.bookBalanceBefore, 1060, "the 1,000 and the 60 deposit are in the books before the start");
  assert.ok(preview.candidates.some((c) => c.voucherNo === transit.voucherNo));

  await assert.rejects(() => svc.Rec.saveSetup(bank._id, { startDay: "nonsense", statementOpening: 0 }, {}), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Rec.saveSetup(bank._id, { startDay: day(1), statementOpening: 0 }, {}), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Rec.saveSetup(bank._id, { startDay: day(-10) }, {}), { code: "OPENING_REQUIRED" });
  await assert.rejects(() => svc.Rec.saveSetup(bank._id, { startDay: day(-10), statementOpening: 1000, outstandingEntryIds: [new mongoose.Types.ObjectId()] }, {}), { code: "INVALID_ENTRY" });
  await assert.rejects(() => svc.Rec.setupPreview(new mongoose.Types.ObjectId(), { startDay: day(-10) }, {}), { code: "NOT_A_BANK_ACCOUNT" });

  // saved with the wrong opening, the status says so
  const outstanding = (await svc.LedgerEntry.findOne({ voucherId: transit._id, accountId: bank._id }))._id;
  const wrong = await svc.Rec.saveSetup(bank._id, { startDay: day(-10), statementOpening: 1060, outstandingEntryIds: [outstanding] }, {}, admin);
  assert.equal(wrong.difference, -60, "1060 in the books - 60 outstanding - 1060 on the statement");
  const right = await svc.Rec.saveSetup(bank._id, { startDay: day(-10), statementOpening: OPENING, outstandingEntryIds: [outstanding] }, {}, admin);
  assert.equal(right.difference, 0);
  assert.equal(right.outstandingTotal, 60);
});

// ------------------------------------------------------------------------------------- import
test("import: the file is read, previewed with its checks, and imported once", { skip }, async () => {
  const p = await svc.Rec.preview(bank._id, { rows: grid() }, {});
  assert.equal(p.format, "grid");
  assert.equal(p.guess.headerRow, 2);
  assert.equal(p.counts.total, SPEC.length);
  assert.equal(p.counts.duplicates, 0);
  assert.equal(p.issueCount, 0);
  assert.equal(p.opening, OPENING);
  assert.equal(p.closing, closing);
  assert.equal(p.continuity.ok, true);
  assert.equal(p.setup.exists, true);
  assert.equal(p.gap, null);

  const out = await svc.Rec.importStatement(bank._id, { rows: grid(), fileName: "oct.csv" }, {}, admin);
  assert.equal(out.imported, SPEC.length);
  assert.equal(out.duplicates, 0);

  // the same file again changes nothing, and says so
  await assert.rejects(() => svc.Rec.importStatement(bank._id, { rows: grid() }, {}, admin), { code: "ALL_DUPLICATES" });
  const again = await svc.Rec.preview(bank._id, { rows: grid() }, {});
  assert.equal(again.counts.duplicates, SPEC.length);
  assert.equal(again.fileDuplicate, true);
  assert.equal(await svc.BankStatementLine.countDocuments({}), SPEC.length);

  // an overlapping file brings in only the new line
  const more = await svc.Rec.importStatement(bank._id, { rows: grid([...SPEC, [0, "ANOTHER FEE", -5]]) }, {}, admin);
  assert.equal(more.imported, 1);
  assert.equal(more.duplicates, SPEC.length);
  const extra = await lineBy("ANOTHER FEE");
  // it is the only line of its import, so it can be taken back
  const imp = (await svc.Rec.imports(bank._id, {})).find((i) => i.lineCount === 1);
  await svc.Rec.voidImport(imp._id, {}, admin);
  assert.equal(await svc.BankStatementLine.countDocuments({ _id: extra._id }), 0);
  assert.equal((await svc.BankStatementImport.findById(imp._id)).status, "voided");
});

test("import: lines before the start day, an unreadable row, and a line count that gets past the checks", { skip }, async () => {
  const early = grid([[-30, "TOO EARLY", 10]], OPENING);
  await assert.rejects(() => svc.Rec.importStatement(bank._id, { rows: early }, {}, admin), { code: "BEFORE_START" });
  const bad = grid([[-1, "OK LINE", 1]], 0);
  bad.splice(3, 0, ["31/02/2026", "IMPOSSIBLE", "", "5.00", ""]);
  await assert.rejects(() => svc.Rec.importStatement(bank._id, { rows: bad }, {}, admin), { code: "BAD_ROWS" });
});

// ------------------------------------------------------------------------------------ worklist
test("worklist: the engine suggests what it is sure of, with its reasons", { skip }, async () => {
  const w = await svc.Rec.lines(bank._id, { tab: "suggested" }, {});
  assert.equal(w.needsSetup, false);
  assert.equal(w.counts.all, SPEC.length);
  const byText = (re) => w.rows.find((r) => re.test(r.description));
  const transfer = byText(/TRF-9001/);
  assert.equal(transfer.suggestion.confidence, "high");
  assert.equal(transfer.suggestion.entries[0].voucherNo, rv.voucherNo);
  assert.ok(transfer.suggestion.reasons.some((r) => /reference TRF-9001/.test(r)));
  const cheque = byText(/CHQ DEP/);
  assert.equal(cheque.suggestion.confidence, "high");
  assert.equal(cheque.suggestion.entries[0].type, "cheque", "a cheque waiting to clear is a candidate: the statement is the proof it cleared");
  assert.equal(byText(/IPP PAY-1/).suggestion.confidence, "high");
  const deposit60 = byText(/CASH DEPOSIT/);
  assert.equal(deposit60.suggestion.confidence, "medium", "a few days apart and nothing in the text: worth a look, not worth accepting blind");
  // nothing is suggested for a fee, interest, a card settlement the books cannot match one-to-one
  assert.equal(w.rows.length, 4);
  const todo = await svc.Rec.lines(bank._id, { tab: "todo" }, {});
  assert.equal(todo.rows.length, SPEC.length - 4);
});

test("worklist: a deposit the books carry from before the start is matched by hand", { skip }, async () => {
  const line = await lineBy("CASH DEPOSIT");
  const found = await svc.Rec.searchEntries(bank._id, { lineId: line._id }, {});
  const entry = found.rows.find((r) => r.voucherNo === transit.voucherNo);
  assert.ok(entry, "the entry listed as outstanding at the start is a candidate");
  const m = await svc.Rec.match(bank._id, { lineIds: [line._id], entries: [{ type: "ledger", ledgerEntryId: entry.ledgerEntryId }] }, {}, admin);
  assert.equal(m.kind, "match");
  assert.equal((await svc.BankStatementLine.findById(line._id)).state, "matched");
});

test("accepting the high suggestions matches the transfer and the payment, and CLEARS the cheque from the statement", { skip }, async () => {
  const chequeBefore = await svc.Cheque.findOne({ chequeNo: "000777" });
  assert.equal(chequeBefore.status, "pending");
  const out = await svc.Rec.acceptSuggestions(bank._id, {}, {}, admin);
  assert.equal(out.accepted, 3);
  assert.deepEqual(out.skipped, []);
  const cheque = await svc.Cheque.findOne({ chequeNo: "000777" });
  assert.equal(cheque.status, "cleared");
  assert.equal(cheque.clearedOn.toISOString().slice(0, 10), day(-7), "it cleared on the day the bank credited it");
  const entry = await svc.LedgerEntry.findOne({ accountId: bank._id, referenceType: "cheque", referenceId: cheque._id });
  assert.equal(entry.debitAmount, 500);
  const line = await lineBy("CHQ DEP");
  assert.equal(line.state, "matched");
  const m = await svc.BankMatch.findById(line.matchId);
  assert.equal(m.method, "auto");
  assert.equal(m.entries[0].clearedByMatch, true);
});

test("a match is exact: lines and entries that do not add up are refused with the difference", { skip }, async () => {
  const fee = await lineBy("BANK CHARGES");
  const card = await svc.Rec.searchEntries(bank._id, {}, {});
  const some = card.rows.find((r) => r.amount > 0 && r.card);
  await assert.rejects(
    () => svc.Rec.match(bank._id, { lineIds: [fee._id], entries: [{ type: "ledger", ledgerEntryId: some.ledgerEntryId }] }, {}, admin),
    (err) => err.code === "AMOUNTS_DIFFER" && err.details?.difference !== undefined
  );
  await assert.rejects(() => svc.Rec.match(bank._id, { lineIds: [fee._id], entries: [] }, {}, admin), { code: "ENTRIES_REQUIRED" });
  const already = await lineBy("TRANSFER FROM AL NOOR");
  await assert.rejects(() => svc.Rec.match(bank._id, { lineIds: [already._id], entries: [] }, {}, admin), { code: "LINE_NOT_OPEN" });
});

// -------------------------------------------------------------------------------------- cards
test("card settlement: two sales, one bank credit; the VAT the acquirer took is posted, and the match adds up", { skip }, async () => {
  const line = await lineBy("NETWORK INTL");
  const u = await svc.Card.unsettled(bank._id, { lineId: line._id }, {});
  assert.equal(u.receipts.length, 2);
  assert.deepEqual(u.receipts.map((r) => [r.gross, r.feeBooked, r.net]), [[100, 2, 98], [200, 4, 196]]);
  assert.equal(u.vatRate, 5);
  assert.equal(u.suggestion.entryIds.length, 2, "both sales, because 294 less 293.70 is just the VAT on the commission");
  assert.equal(u.suggestion.difference, 0.3);

  const ids = u.receipts.map((r) => r.entryId);
  // the 0.30 difference must be explained
  await assert.rejects(() => svc.Card.settle(bank._id, { lineId: line._id, receiptEntryIds: ids, extraCommission: 0, vat: 0 }, {}, admin), { code: "DIFFERENCE_NOT_EXPLAINED" });
  await assert.rejects(() => svc.Card.settle(bank._id, { lineId: line._id, receiptEntryIds: [], vat: 0.3 }, {}, admin), { code: "RECEIPTS_REQUIRED" });

  const out = await svc.Card.settle(bank._id, { lineId: line._id, receiptEntryIds: ids, extraCommission: 0, vat: 0.3, settlementRef: "NI-0099" }, {}, admin);
  assert.equal(out.match.kind, "card");
  assert.equal(out.settlement.expectedNet, 294);
  assert.equal(out.settlement.received, 293.7);
  assert.equal(out.settlement.difference, 0.3);
  assert.equal(out.settlement.gross, 300);
  assert.equal(out.settlement.feeBooked, 6);

  // the commission's VAT is a VAT-only expense: Dr Input VAT / Cr bank
  const v = await svc.Voucher.findById(out.settlement.adjustmentVoucherId);
  assert.equal(v.voucherType, "expense");
  assert.equal(v.vatTotal, 0.3);
  assert.equal(v.subtotal, 0);
  assert.deepEqual(await legs(v), ["Input VAT:Dr0.3", "Recon Bank:Cr0.3"]);
  assert.equal((await lineBy("NETWORK INTL")).state, "matched");
  assert.equal(out.match.entries.length, 3, "two receipts and the adjustment");

  // settled sales are no longer waiting
  assert.equal((await svc.Card.unsettled(bank._id, {}, {})).receipts.length, 0);
  const ageing = await svc.Card.ageing(bank._id, {}, {});
  assert.equal(ageing.count, 0);
});

test("card settlement: extra commission beyond the configured rate, and a payout bigger than expected", { skip }, async () => {
  const a = await receipt({ paymentMode: "card", totalAmount: 100, date: at(-3), paymentDetails: { cardId: terminal._id, approvalCode: "B100" } });
  const b = await receipt({ paymentMode: "card", totalAmount: 100, date: at(-3), paymentDetails: { cardId: terminal._id, approvalCode: "B101" } });
  const spec = [[-1, "NI SETTLEMENT 0100", 195.5], [-1, "NI SETTLEMENT 0101", 98.5]];
  await svc.Rec.importStatement(bank._id, { rows: grid(spec, closing) }, {}, admin);
  const l1 = await lineBy("NI SETTLEMENT 0100");
  const ids = (await svc.Card.unsettled(bank._id, { lineId: l1._id }, {})).receipts.map((r) => r.entryId);
  assert.equal(ids.length, 2);
  // expected 196, paid 195.50: 0.50 = 0.45 extra commission + 0.05 VAT (5% of 1.00 rounds... the split is the person's)
  const out = await svc.Card.settle(bank._id, { lineId: l1._id, receiptEntryIds: ids, extraCommission: 0.45, vat: 0.05 }, {}, admin);
  assert.equal(out.settlement.extraCommission, 0.45);
  const v = await svc.Voucher.findById(out.settlement.adjustmentVoucherId);
  assert.equal(v.subtotal, 0.45);
  assert.equal(v.vatTotal, 0.05);
  assert.equal(v.totalAmount, 0.5);
  assert.deepEqual(await legs(v), ["Card Processing Fees:Dr0.45", "Input VAT:Dr0.05", "Recon Bank:Cr0.5"]);

  // the next sale is paid 98.50 for a sale the books expect 98 on: the acquirer kept less than booked
  const c = await receipt({ paymentMode: "card", totalAmount: 100, date: at(-2), paymentDetails: { cardId: terminal._id, approvalCode: "C100" } });
  const l2 = await lineBy("NI SETTLEMENT 0101");
  const u2 = await svc.Card.unsettled(bank._id, { lineId: l2._id }, {});
  const out2 = await svc.Card.settle(bank._id, { lineId: l2._id, receiptEntryIds: u2.receipts.map((r) => r.entryId), extraCommission: 0, vat: 0 }, {}, admin);
  assert.equal(out2.settlement.difference, -0.5);
  assert.deepEqual(await legs(await svc.Voucher.findById(out2.settlement.adjustmentVoucherId)), ["Recon Bank:Dr0.5", "Card Processing Fees:Cr0.5"]);

  const variance = await svc.Card.variance(bank._id, {}, {});
  assert.equal(variance.summary.settlements, 3);
  assert.equal(variance.summary.gross, 600);
  assert.equal(variance.summary.feeBooked, 12);
  assert.equal(variance.summary.bookedRate, 2);
  assert.equal(variance.cards[0].cardLabel, "POS 1");
  assert.equal((await svc.Card.list(bank._id, {}, {})).length, 3);

  // put the books back where the rest of the story expects them: these two extra lines are undone
  for (const text of ["NI SETTLEMENT 0100", "NI SETTLEMENT 0101"]) {
    const l = await lineBy(text);
    await svc.Rec.unmatch(l.matchId, { deleteVouchers: true }, {}, admin);
  }
  assert.equal((await svc.CardSettlement.countDocuments({ status: "active" })), 1, "undoing a match undoes its settlement record");
  for (const v of [a, b, c]) await svc.Financial.deleteVoucher(v._id, admin); // the books go back to what the rest of the story expects
  for (const text of ["NI SETTLEMENT 0100", "NI SETTLEMENT 0101"]) await svc.Rec.ignore((await lineBy(text))._id, "Not part of this story", {}, admin);
});

// ------------------------------------------------------------------- lines the books lack
test("a bank fee: the statement fixes the gross, so net and VAT are worked back from it and add up exactly", { skip }, async () => {
  const line = await lineBy("BANK CHARGES");
  const out = await svc.Posting.createFromLine(bank._id, line._id, { kind: "fee" }, {}, admin);
  const v = await svc.Voucher.findById(out.voucher._id);
  assert.equal(v.voucherType, "expense");
  assert.equal(v.totalAmount, 21);
  assert.equal(v.subtotal, 20);
  assert.equal(v.vatTotal, 1);
  assert.deepEqual(await legs(v), ["Bank Charges:Dr20", "Input VAT:Dr1", "Recon Bank:Cr21"]);
  assert.equal(out.match.kind, "created");
  assert.equal((await lineBy("BANK CHARGES")).state, "matched");
});

test("interest is income with no VAT; a transfer is a contra to the other account; a receipt not yet booked is posted from the line", { skip }, async () => {
  const interest = await svc.Posting.createFromLine(bank._id, (await lineBy("CREDIT INTEREST"))._id, { kind: "interest" }, {}, admin);
  assert.deepEqual(await legs(await svc.Voucher.findById(interest.voucher._id)), ["Recon Bank:Dr4.2", "Bank Interest Income:Cr4.2"]);
  await assert.rejects(async () => svc.Posting.createFromLine(bank._id, (await lineBy("UNKNOWN DEPOSIT"))._id, { kind: "fee" }, {}, admin), { code: "WRONG_DIRECTION" });

  const transfer = await svc.Posting.createFromLine(bank._id, (await lineBy("TRANSFER TO SAVINGS"))._id, { kind: "transfer", otherAccountId: savings._id }, {}, admin);
  assert.equal(transfer.voucher.voucherType, "contra");
  assert.equal(await balanceOf(savings._id), 250);
  await assert.rejects(async () => svc.Posting.createFromLine(bank._id, (await lineBy("UNKNOWN DEPOSIT"))._id, { kind: "transfer", otherAccountId: bank._id }, {}, admin), { code: "SAME_ACCOUNT" });

  const alloc = await svc.Posting.allocation(bank._id, (await lineBy("UNKNOWN DEPOSIT"))._id, { partyId: customer._id, kind: "receipt" }, {});
  assert.deepEqual(alloc, { invoices: [], allocated: 0, onAccount: 80 }, "no open invoices, so it would be kept on account");
  const rec = await svc.Posting.createFromLine(bank._id, (await lineBy("UNKNOWN DEPOSIT"))._id, { kind: "receipt", partyId: customer._id }, {}, admin);
  assert.equal(rec.voucher.voucherType, "receipt");
  assert.equal(rec.voucher.totalAmount, 80);
  assert.ok((await legs(await svc.Voucher.findById(rec.voucher._id))).includes("Recon Bank:Dr80"));
  await assert.rejects(async () => svc.Posting.createFromLine(bank._id, (await lineBy("UNKNOWN DEPOSIT"))._id, { kind: "receipt", partyId: customer._id }, {}, admin), { code: "LINE_NOT_OPEN" });
});

test("posting for a line is one transaction: if the match cannot be written, the voucher is not either", { skip }, async () => {
  const session = await mongoose.startSession();
  const before = await svc.Voucher.countDocuments({});
  await assert.rejects(async () => {
    await session.withTransaction(async () => {
      await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, date: at(0), totalAmount: 5, fromAccountId: bank._id, toAccountId: savings._id }, admin, session);
      throw new Error("the match could not be written");
    });
  }, /could not be written/);
  await session.endSession();
  assert.equal(await svc.Voucher.countDocuments({}), before, "nothing was left behind");
});

test("ignoring a line needs a reason, and an ignored line can be put back", { skip }, async () => {
  const line = await lineBy("DUPLICATE FEE");
  await assert.rejects(() => svc.Rec.ignore(line._id, "", {}, admin), { code: "REASON_REQUIRED" });
  const ig = await svc.Rec.ignore(line._id, "The bank charged this twice and has refunded it", {}, admin);
  assert.equal(ig.state, "ignored");
  await svc.Rec.unignore(line._id, {});
  assert.equal((await svc.BankStatementLine.findById(line._id)).state, "open");
  await svc.Rec.ignore(line._id, "The bank charged this twice and has refunded it", {}, admin);
});

// ----------------------------------------------------------------------------- the locks
test("a matched voucher cannot be deleted, edited or its cheque bounced until it is unmatched", { skip }, async () => {
  await assert.rejects(() => svc.Financial.deleteVoucher(rv._id, admin), { code: "BANK_MATCHED" });
  await assert.rejects(() => svc.Financial.updateVoucher(rv._id, { totalAmount: 1051, forceUpdate: true }, admin), { code: "BANK_MATCHED" });
  const cheque = await svc.Cheque.findOne({ chequeNo: "000777" });
  await assert.rejects(() => svc.Cheques.bounce(cheque._id, { reason: "Returned unpaid" }, {}, admin), { code: "BANK_MATCHED" });
  assert.equal((await svc.Cheque.findById(cheque._id)).status, "cleared", "nothing changed");
});

// --------------------------------------------------------------------------------- the proof
test("the proof: the two sides agree once the deposit in transit and the ignored line are allowed for", { skip }, async () => {
  // statement: everything imported (the two card test lines were ignored); book: everything posted
  const statement = round2(closing + 195.5 + 98.5);
  const p = await svc.Rec.proof(bank._id, { asOf: day(0), statementBalance: statement }, {});
  assert.equal(p.openLines, 0);
  assert.equal(p.depositsInTransit.total, 77, "the 77 deposit is in the books and not on the statement");
  assert.equal(p.outstandingPayments.total, 0);
  assert.equal(p.ignored.total, round2(-15 + 195.5 + 98.5));
  assert.equal(p.difference, 0);
  assert.equal(p.adjustedBank, p.adjustedBook);
  assert.equal(p.canFinish, true);
  assert.equal(p.openingDifference, 0);

  const off = await svc.Rec.proof(bank._id, { asOf: day(0), statementBalance: statement + 10 }, {});
  assert.equal(off.difference, 10);
  assert.equal(off.canFinish, false);
  assert.ok(off.blockers.some((b) => b.code === "DIFFERENCE"));
  await assert.rejects(() => svc.Rec.finish(bank._id, { asOf: day(0), statementBalance: statement + 10 }, {}, admin), (e) => e.code === "RECONCILIATION_NOT_READY");
  await assert.rejects(() => svc.Rec.proof(bank._id, { asOf: day(0) }, {}), { code: "BALANCE_REQUIRED" });
  assert.ok((await svc.Rec.proof(bank._id, { asOf: day(1), statementBalance: statement }, {})).blockers.some((b) => b.code === "FUTURE_DATE"));
  await assert.rejects(() => svc.Rec.finish(bank._id, { asOf: day(1), statementBalance: statement }, {}, admin), { code: "RECONCILIATION_NOT_READY" });
});

test("an open line stops a reconciliation being finished", { skip }, async () => {
  await svc.Rec.importStatement(bank._id, { rows: grid([[0, "LATE ARRIVAL", 1]], round2(closing + 195.5 + 98.5)) }, {}, admin);
  const p = await svc.Rec.proof(bank._id, { asOf: day(0), statementBalance: round2(closing + 195.5 + 98.5 + 1) }, {});
  assert.equal(p.openLines, 1);
  assert.ok(p.blockers.some((b) => b.code === "OPEN_LINES"));
  assert.equal(p.difference, 0, "it adds up; it is just not dealt with");
  await svc.Rec.ignore((await lineBy("LATE ARRIVAL"))._id, "Belongs to the next period", {}, admin);
});

test("finishing locks everything it covers; reopening unlocks it", { skip }, async () => {
  const statement = round2(closing + 195.5 + 98.5 + 1);
  const rec = await svc.Rec.finish(bank._id, { asOf: day(0), statementBalance: statement, note: "October" }, {}, admin);
  assert.match(rec.number, /^BRC-\d{4}-0001$/);
  assert.equal(rec.status, "completed");
  assert.equal(rec.proof.difference, 0);
  assert.equal(rec.proof.depositsInTransit.total, 77);
  const matched = await svc.BankStatementLine.find({ state: "reconciled" });
  assert.ok(matched.length >= 9, `${matched.length} lines are locked`);
  assert.equal(await svc.BankStatementLine.countDocuments({ state: "matched" }), 0);

  // a locked match cannot be undone, a locked voucher cannot be touched
  const line = await lineBy("BANK CHARGES");
  await assert.rejects(() => svc.Rec.unmatch(line.matchId, {}, {}, admin), { code: "BANK_RECONCILED" });
  const fee = (await svc.BankMatch.findById(line.matchId)).createdVouchers[0];
  await assert.rejects(() => svc.Financial.deleteVoucher(fee.voucherId, admin), { code: "BANK_RECONCILED" });
  await assert.rejects(async () => svc.Rec.unignore((await lineBy("DUPLICATE FEE"))._id, {}), { code: "LINE_NOT_IGNORED" });

  // the next one has to be later
  await assert.rejects(() => svc.Rec.finish(bank._id, { asOf: day(0), statementBalance: statement }, {}, admin), { code: "RECONCILIATION_NOT_READY" });

  const accounts = await svc.Rec.accounts({});
  const row = accounts.find((a) => String(a._id) === String(bank._id));
  assert.equal(row.lastReconciled.number, rec.number);
  assert.equal(row.counts.open, 0);

  const stored = await svc.Rec.reconciliation(rec._id, {});
  assert.equal(stored.account.accountName, "Recon Bank");
  assert.equal((await svc.Rec.reconciliations(bank._id, {})).length, 1);

  const reopened = await svc.Rec.reopen(rec._id, { reason: "A fee was missed" }, {}, admin);
  assert.equal(reopened.status, "reopened");
  assert.equal(await svc.BankStatementLine.countDocuments({ state: "reconciled" }), 0);
  await assert.rejects(() => svc.Rec.reopen(rec._id, {}, {}, admin), { code: "NOT_FOUND" });
  // unlocked: the voucher can be touched again (a fee voucher deleted, its line open again)
  const un = await svc.Rec.unmatch(line.matchId, { deleteVouchers: true }, {}, admin);
  assert.deepEqual(un.warnings, []);
  assert.equal((await svc.BankStatementLine.findById(line._id)).state, "open");
  assert.equal((await svc.Voucher.findById(fee.voucherId)).status, "cancelled");

  // and it can be posted again, and finished again
  await svc.Posting.createFromLine(bank._id, line._id, { kind: "fee" }, {}, admin);
  const second = await svc.Rec.finish(bank._id, { asOf: day(0), statementBalance: statement }, {}, admin);
  assert.match(second.number, /^BRC-\d{4}-0002$/);
});

// ---------------------------------------------------------------------- lines that cancel out
test("a cheque deposited and returned: two statement lines that cancel are matched to each other", { skip }, async () => {
  await svc.Rec.importStatement(bank._id, { rows: grid([[0, "CHQ DEP 000888 RETURNED", 400], [0, "CHQ RETURN 000888", -400]], closing + 1) }, {}, admin);
  const a = await lineBy("CHQ DEP 000888");
  const b = await lineBy("CHQ RETURN 000888");
  await assert.rejects(() => svc.Rec.match(bank._id, { lineIds: [a._id], entries: [] }, {}, admin), { code: "ENTRIES_REQUIRED" });
  const m = await svc.Rec.match(bank._id, { lineIds: [a._id, b._id], entries: [] }, {}, admin);
  assert.equal(m.kind, "offset");
  await svc.Rec.unmatch(m._id, {}, {}, admin);
  assert.equal((await svc.BankStatementLine.findById(a._id)).state, "open");
});

// ------------------------------------------------------------ posting to an account of the person's choice
test("posting to a chosen account: a direct debit as a journal, a fee to another expense account without VAT", { skip }, async () => {
  await svc.Rec.importStatement(bank._id, { rows: grid([[0, "DIRECT DEBIT UTILITIES", -40], [0, "SMS ALERT FEE", -5]], closing + 2) }, {}, admin);
  const utilities = await svc.LedgerAccount.findOne({ accountName: "Utilities" });
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" });

  const dd = await svc.Posting.createFromLine(bank._id, (await lineBy("DIRECT DEBIT"))._id, { kind: "journal", postToAccountId: utilities._id }, {}, admin);
  assert.deepEqual((await legs(await svc.Voucher.findById(dd.voucher._id))).sort(), ["Recon Bank:Cr40", "Utilities:Dr40"]);
  await assert.rejects(async () => svc.Posting.createFromLine(bank._id, (await lineBy("SMS ALERT"))._id, { kind: "journal" }, {}, admin), { code: "ACCOUNT_REQUIRED" });

  const sms = await svc.Posting.createFromLine(bank._id, (await lineBy("SMS ALERT"))._id, { kind: "fee", postToAccountId: rent._id, vat: false }, {}, admin);
  const v = await svc.Voucher.findById(sms.voucher._id);
  assert.equal(v.vatTotal, 0);
  assert.deepEqual((await legs(v)).sort(), ["Recon Bank:Cr5", "Rent Expense:Dr5"]);
});

// ------------------------------------------------------------------------ an MT940 statement
test("an MT940 statement for the other account: imported, and the transfer's other leg matches itself", { skip }, async () => {
  const yymmdd = (n) => day(n).slice(2).replace(/-/g, "");
  const mt940 = [
    ":20:SAVINGS-1", ":25:AE070331234567890123456", ":28C:00001/001",
    `:60F:C${yymmdd(-2)}AED0,00`,
    `:61:${yymmdd(-1)}${day(-1).slice(5).replace("-", "")}C250,00NTRFNONREF//BREF9`,
    ":86:TRANSFER FROM RECON BANK",
    `:62F:C${yymmdd(-1)}AED250,00`,
  ].join("\n");

  const p = await svc.Rec.preview(savings._id, { mt940 }, {});
  assert.equal(p.format, "mt940");
  assert.equal(p.counts.total, 1);
  assert.equal(p.opening, 0);
  assert.equal(p.closing, 250);
  assert.equal(p.continuity.ok, true);
  assert.equal(p.setup.exists, false);
  assert.equal(p.setup.suggestedStart, day(-1));

  // the account has to be set up first, and the opening has to agree with the books the day before
  await assert.rejects(() => svc.Rec.importStatement(savings._id, { mt940 }, {}, admin), { code: "SETUP_REQUIRED" });
  const out = await svc.Rec.importStatement(savings._id, { mt940, fileName: "savings.sta", setup: { startDay: day(-1), statementOpening: 0 } }, {}, admin);
  assert.equal(out.imported, 1);
  assert.equal((await svc.Rec.setupStatus(savings._id, {})).difference, 0);

  const w = await svc.Rec.lines(savings._id, { tab: "suggested" }, {});
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].suggestion.confidence, "high");
  assert.equal(w.rows[0].suggestion.entries[0].voucherType, "contra", "the contra posted from the first account is the other leg");
  const accepted = await svc.Rec.acceptSuggestions(savings._id, {}, {}, admin);
  assert.equal(accepted.accepted, 1);

  const proof = await svc.Rec.proof(savings._id, { asOf: day(-1), statementBalance: 250 }, {});
  assert.equal(proof.difference, 0);
  assert.equal(proof.canFinish, true);
  const rec = await svc.Rec.finish(savings._id, { asOf: day(-1), statementBalance: 250 }, {}, admin);
  assert.match(rec.number, /^BRC-\d{4}-\d{4}$/);
});
