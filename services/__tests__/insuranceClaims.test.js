// Insurance claims against a throwaway database (random name, dropped afterwards).
//
// What this proves: the UAE accident-repair flow a job card forks into - an insurer, a survey, an LPO
// approval with an excess and parts depreciation, and then TWO invoices raised from one decision: the
// insurer's (real job-card lines, so parts still move stock at their real cost) and the customer's (the
// excess and the depreciation, as a plain ad hoc charge with NO stock movement at all, correctly, because
// it is billed through a SERVICE item). The split always adds back to the job's full value. Also: a claim
// cannot be decided before it is surveyed, cannot be invoiced twice, and a rejected claim raises nothing.
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
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Vehicle: require("../garage/vehicleService"),
    JobCard: require("../garage/jobCardService"),
    Claim: require("../garage/insuranceClaimService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    JobCardModel: require("../../models/modules/garage/jobCardModel"),
    ClaimModel: require("../../models/modules/garage/insuranceClaimModel"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- fixtures -----------------------------------------------------------------------------------------
let customer, insurer, category, brakeDisc, labourPanel, vehicle;
let vendor;
const buy = (items) => svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const buyApproved = async (items) => approve(await buy(items));
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const entriesOf = (t) => svc.LedgerEntry.find({ voucherId: t._id }).lean();
const live = async (t) => (await entriesOf(t)).filter((e) => !e.isReversed);
async function byAccount(t) {
  const out = {};
  for (const e of await live(t)) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  return out;
}

test("setup: an insurer, a customer, a vehicle, and a panel-beating job already approved and done", { skip }, async () => {
  const Vendor = require("../../models/modules/vendorModel");
  vendor = await Vendor.create({ vendorId: "V2", vendorName: "Parts Co 2", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C2", customerName: "Khalid Omar", contactPerson: "Khalid Omar", phone: "0509998888", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  insurer = await svc.Customer.create({ customerId: "INS1", customerName: "Orient Insurance", contactPerson: "Claims Desk", phone: "044445555", shippingAddress: "Dubai", paymentTerms: "Net 30", isInsurer: true });
  category = await svc.Category.create({ name: "Garage" });

  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  brakeDisc = await svc.StockService.createStock({ ...base, sku: "PART-DISC2", itemName: "Front bumper", salesPrice: 1200 }, "tester");
  labourPanel = await svc.StockService.createStock({ ...base, sku: "LAB-PANEL", itemName: "Labour - panel and paint", itemType: "service", salesPrice: 1500 }, "tester");
  await buyApproved([{ itemId: brakeDisc._id, description: "Front bumper", qty: 5, price: 600, rate: 600, vatPercent: 0 }]);

  vehicle = await svc.Vehicle.create({ plateNumber: "D 77777", make: "Nissan", model: "Patrol", year: 2021, customerId: customer._id }, "tester");
});

let card, claim;

test("not an insurer: a plain customer cannot be used to open a claim", { skip }, async () => {
  const draft = await svc.JobCard.create({ vehicleId: vehicle._id, customerId: customer._id, jobType: "insurance", complaints: [{ concern: "Front-end collision" }], lines: [{ kind: "part", itemId: brakeDisc._id, qty: 1, price: 1200 }, { kind: "labour", itemId: labourPanel._id, qty: 1, price: 1500 }] }, "tester");
  await assert.rejects(() => svc.Claim.create({ insurerId: customer._id, jobCardId: draft._id, policyNo: "POL-1" }, "tester"), { code: "NOT_AN_INSURER" });
  await svc.JobCard.remove(draft._id, "tester");
});

test("a claim is opened on the job card, and the job card learns its claimId", { skip }, async () => {
  card = await svc.JobCard.create(
    {
      vehicleId: vehicle._id, customerId: customer._id, jobType: "insurance",
      complaints: [{ concern: "Front-end collision, bumper and panel damage" }],
      lines: [
        { kind: "part", itemId: brakeDisc._id, qty: 1, price: 1200 },
        { kind: "labour", itemId: labourPanel._id, qty: 1, price: 1500 },
      ],
      tasks: [{ name: "Replace bumper and repaint panel", mode: "in_house", stage: 1, standardHours: 4 }],
    },
    "tester"
  );
  claim = await svc.Claim.create({ insurerId: insurer._id, jobCardId: card._id, policyNo: "POL-998877", policyHolder: "Khalid Omar", accidentDate: new Date("2026-10-01") }, "tester");
  assert.match(claim.claimNo, /^CLM-\d{4}-\d{4}$/);
  assert.equal(claim.status, "DRAFT");

  const stored = await svc.JobCardModel.findById(card._id).lean();
  assert.equal(String(stored.claimId), String(claim._id));
});

test("one claim per job card: a second one is refused", { skip }, async () => {
  await assert.rejects(() => svc.Claim.create({ insurerId: insurer._id, jobCardId: card._id, policyNo: "POL-2" }, "tester"), { code: "CLAIM_ALREADY_EXISTS" });
});

test("the claim moves through submitted and surveyed before it can be decided", { skip }, async () => {
  await assert.rejects(() => svc.Claim.recordApproval(claim._id, { status: "APPROVED", lpoNo: "X" }, "tester"), { code: "CLAIM_NOT_SURVEYED" });

  claim = await svc.Claim.submit(claim._id, "advisor1");
  assert.equal(claim.status, "SUBMITTED");

  claim = await svc.Claim.recordSurvey(claim._id, { surveyorName: "Ahmed Saeed", company: "Crawford UAE", notes: "Bumper and front panel confirmed damaged." }, "surveyor1");
  assert.equal(claim.status, "SURVEYED");
  assert.equal(claim.survey.surveyorName, "Ahmed Saeed");
});

test("the insurer approves with an LPO, an excess and parts depreciation", { skip }, async () => {
  claim = await svc.Claim.recordApproval(
    claim._id,
    { status: "APPROVED", lpoNo: "LPO-2026-5521", approvedAmount: 2700, note: "Approved in full", deductions: { excess: 350, partsDepreciationPct: 10, depreciablePartsAmount: 1200 } },
    "advisor1"
  );
  assert.equal(claim.status, "APPROVED");
  assert.equal(claim.approval.lpoNo, "LPO-2026-5521");
});

test("the job card's own estimate is approved and the work is done, ready to be invoiced", { skip }, async () => {
  card = await svc.JobCard.sendEstimate(card._id, "advisor1");
  const ids = card.lines.map((l) => String(l._id));
  card = await svc.JobCard.recordApproval(card._id, { method: "lpo", reference: "LPO-2026-5521", lineIds: ids }, "advisor1");
  assert.equal(card.status, "IN_PROGRESS");
  const taskId = card.tasks[0]._id;
  await svc.JobCard.startTask(card._id, taskId, "tech1");
  card = await svc.JobCard.completeTask(card._id, taskId, { actualHours: 5 }, "tech1");
  assert.equal(card.status, "READY");
});

let insurerInvoice, customerInvoice;
test("raising invoices: the insurer is billed the approved repair, the customer the excess and the depreciation - and the two add back to the job's full value", { skip }, async () => {
  claim = await svc.Claim.raiseInvoices(claim._id, "tester");
  assert.equal(claim.status, "INVOICED");
  assert.equal(claim.invoices.length, 2);

  // 1200 (bumper) + 1500 (labour) = 2700 full job value, fully approved (2700), less 350 excess and
  // 10% of 1200 = 120 depreciation: insurer 2230, customer 470. 2230 + 470 = 2700.
  assert.equal(claim.split.insurerAmount, 2230);
  assert.equal(claim.split.customerAmount, 470);
  assert.equal(claim.split.insurerAmount + claim.split.customerAmount, 2700);

  const insurerLink = claim.invoices.find((i) => i.billTo === "insurer");
  const customerLink = claim.invoices.find((i) => i.billTo === "customer");
  insurerInvoice = await svc.Transaction.findById(insurerLink.transactionId);
  customerInvoice = await svc.Transaction.findById(customerLink.transactionId);
  assert.equal(String(insurerInvoice.partyId), String(insurer._id));
  assert.equal(String(customerInvoice.partyId), String(customer._id));
  assert.equal(insurerInvoice.items.length, 2, "the bumper and the panel labour, billed in full to the insurer");
  assert.equal(customerInvoice.items.length, 2, "the excess and the depreciation, billed to the customer");
});

test("approving both invoices: the part moves stock at its real cost for the INSURER'S invoice; the customer's excess/depreciation charge moves none at all", { skip }, async () => {
  insurerInvoice = await approve(insurerInvoice);
  assert.equal(insurerInvoice.status, "APPROVED");
  assert.equal(await onHand(brakeDisc), 4, "the bumper left stock on the insurer's invoice, exactly as any other sale would");

  const moves = await svc.Movement.find({ referenceId: insurerInvoice._id, referenceType: "Transaction" }).lean();
  assert.equal(moves.length, 1, "one movement for the part; the panel labour moved none");

  customerInvoice = await approve(customerInvoice);
  assert.equal(customerInvoice.status, "APPROVED");
  const customerMoves = await svc.Movement.find({ referenceId: customerInvoice._id, referenceType: "Transaction" }).lean();
  assert.equal(customerMoves.length, 0, "the excess and the depreciation are deductions, not goods - nothing in stock moved for either");

  const byAcc = await byAccount(customerInvoice);
  const receivable = Object.keys(byAcc).find((k) => k.startsWith("Customer - "));
  assert.ok(receivable, "the customer's own receivable carries the 470");
  assert.equal(r2(byAcc[receivable]), r2(customerInvoice.totalAmount));

  const cardNow = await svc.JobCardModel.findById(card._id).lean();
  assert.equal(cardNow.invoices.length, 2, "both the insurer's and the customer's invoices are on the job card");
  assert.equal(cardNow.invoiceStatus, "INVOICED", "INVOICED only once BOTH invoices are approved");
});

test("invoices cannot be raised twice for the same claim", { skip }, async () => {
  await assert.rejects(() => svc.Claim.raiseInvoices(claim._id, "tester"), { code: "ALREADY_INVOICED" });
});

test("the job card's own ordinary invoice refuses to re-bill lines the claim already billed to the insurer", { skip }, async () => {
  // The exact risk closed by billableLines: someone pressing the job card's plain "Raise invoice" after the
  // claim has already invoiced the insurer for the same repair must not bill the customer for it again.
  await assert.rejects(() => svc.JobCard.createInvoice({ jobCardId: card._id, billTo: "customer" }, "tester"), { code: "ALREADY_INVOICED" });
});

test("a rejected claim raises nothing: the job is simply invoiced to the customer in full, outside the claim", { skip }, async () => {
  const draft = await svc.JobCard.create({ vehicleId: vehicle._id, customerId: customer._id, jobType: "insurance", complaints: [{ concern: "Scratch on the door" }], lines: [{ kind: "labour", itemId: labourPanel._id, qty: 1, price: 300 }] }, "tester");
  let c2 = await svc.Claim.create({ insurerId: insurer._id, jobCardId: draft._id, policyNo: "POL-3" }, "tester");
  c2 = await svc.Claim.submit(c2._id, "advisor1");
  c2 = await svc.Claim.recordSurvey(c2._id, { surveyorName: "Ahmed Saeed" }, "surveyor1");
  c2 = await svc.Claim.recordApproval(c2._id, { status: "REJECTED", reason: "Pre-existing damage, not from this incident" }, "advisor1");
  assert.equal(c2.status, "REJECTED");
  assert.equal(c2.invoices.length, 0);
  await assert.rejects(() => svc.Claim.raiseInvoices(c2._id, "tester"), { code: "CLAIM_NOT_APPROVED" });

  // Nothing was ever billed by the claim, so the job card's own ordinary route still bills the customer in
  // full - the documented path for a rejection, proven here rather than only asserted in a comment.
  let d2 = await svc.JobCard.sendEstimate(draft._id, "advisor1");
  d2 = await svc.JobCard.recordApproval(d2._id, { method: "counter", lineIds: [String(d2.lines[0]._id)] }, "advisor1");
  const { invoice: fullInvoice } = await svc.JobCard.createInvoice({ jobCardId: d2._id, billTo: "customer" }, "tester");
  assert.equal(String(fullInvoice.partyId), String(customer._id));
  assert.equal(fullInvoice.items.length, 1);
});
