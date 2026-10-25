// The garage module against a throwaway database (random name, dropped afterwards).
//
// What this proves, beyond the pure rules in utils/__tests__/garage.test.js: a vehicle is checked in, three
// complaints are raised, an estimate of parts AND labour is built and partly approved, tasks run, a
// supplementary estimate (teardown found more) is raised and approved while the job is already in progress,
// the invoice is raised and approved - and then: parts stock fell by the right quantity at the right
// weighted-average cost, labour revenue landed in its OWN income account and NOT in sales-revenue, no
// InventoryMovement exists for a labour line, the receivable and the ledger balance, the job card's
// invoiceStatus follows what the invoice does (jobCardLinks.js, called from the bottom of processTransaction),
// the gate pass is refused while money is owed or work is open, and the card ends CLOSED. Also: a line whose
// kind does not match what the item master really is (a part billed as labour, or the reverse) is refused.
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
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    VehicleModel: require("../../models/modules/garage/vehicleModel"),
    JobCardModel: require("../../models/modules/garage/jobCardModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
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
let customer, category, brakePads, oilFilter, brakeDisc, labourBrake, labourOil, labourAc, otherIncome, salesRevenueId;
let vendor;
const buy = (items) => svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const buyApproved = async (items) => approve(await buy(items));
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const avgCost = async (item) => (await svc.Stock.findById(item._id)).purchasePrice;
const movesOf = (t) => svc.Movement.find({ referenceId: t._id, referenceType: "Transaction" }).lean();
const entriesOf = (t) => svc.LedgerEntry.find({ voucherId: t._id }).lean();
const live = async (t) => (await entriesOf(t)).filter((e) => !e.isReversed);
async function byAccount(t) {
  const out = {};
  for (const e of await live(t)) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  return out;
}
const totals = (entries) => ({ debit: r2(entries.reduce((s, e) => s + e.debitAmount, 0)), credit: r2(entries.reduce((s, e) => s + e.creditAmount, 0)) });

test("setup: a vendor, a customer, three parts stocked, and three labour operations", { skip }, async () => {
  const Vendor = require("../../models/modules/vendorModel");
  vendor = await Vendor.create({ vendorId: "V1", vendorName: "Parts Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Ali Hassan", contactPerson: "Ali Hassan", phone: "0501234567", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  category = await svc.Category.create({ name: "Garage" });
  otherIncome = await svc.LedgerAccount.findOne({ accountName: "Other Income" });
  assert.ok(otherIncome, "the default chart has an income account to point labour at");
  salesRevenueId = String(await svc.Config.resolveAccount("sales-revenue"));

  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  brakePads = await svc.StockService.createStock({ ...base, sku: "PART-BRAKE", itemName: "Brake pads", salesPrice: 150 }, "tester");
  oilFilter = await svc.StockService.createStock({ ...base, sku: "PART-OIL", itemName: "Oil filter", salesPrice: 40 }, "tester");
  brakeDisc = await svc.StockService.createStock({ ...base, sku: "PART-DISC", itemName: "Brake disc", salesPrice: 300 }, "tester");
  labourBrake = await svc.StockService.createStock({ ...base, sku: "LAB-BRAKE", itemName: "Labour - brake job", itemType: "service", salesPrice: 200, incomeAccountId: otherIncome._id }, "tester");
  labourOil = await svc.StockService.createStock({ ...base, sku: "LAB-OIL", itemName: "Labour - oil change", itemType: "service", salesPrice: 80, incomeAccountId: otherIncome._id }, "tester");
  labourAc = await svc.StockService.createStock({ ...base, sku: "LAB-AC", itemName: "AC inspection", itemType: "service", salesPrice: 100, incomeAccountId: otherIncome._id }, "tester");

  // Stock the three parts at a known cost, exactly as a real workshop would before the job.
  await buyApproved([
    { itemId: brakePads._id, description: "Brake pads", qty: 10, price: 80, rate: 80, vatPercent: 0 },
    { itemId: oilFilter._id, description: "Oil filter", qty: 10, price: 25, rate: 25, vatPercent: 0 },
    { itemId: brakeDisc._id, description: "Brake disc", qty: 10, price: 150, rate: 150, vatPercent: 0 },
  ]);
  assert.equal(await onHand(brakePads), 10);
  assert.equal(await avgCost(brakePads), 80);
});

// ===================================== the vehicle ======================================

let vehicle;
test("the vehicle: created once, found again by plate however it is typed, a duplicate refused", { skip }, async () => {
  vehicle = await svc.Vehicle.create({ plateNumber: "A 12345", make: "Toyota", model: "Hilux", year: 2019, colour: "White", customerId: customer._id }, "tester");
  assert.equal(vehicle.plateKey, "A12345");

  const found = await svc.Vehicle.findByPlateOrChassis({ plateNumber: "a-12345" });
  assert.equal(String(found._id), String(vehicle._id), "the same car, however the plate was typed at the counter");

  await assert.rejects(() => svc.Vehicle.create({ plateNumber: "A-12345", make: "Toyota", model: "Corolla" }, "tester"), { code: "PLATE_ALREADY_USED" });
});

// ===================================== the job card ======================================

let card, taskBrakeId, taskOilId, lineIds;

test("a job card is opened with three complaints and a first estimate of parts and labour", { skip }, async () => {
  card = await svc.JobCard.create(
    {
      vehicleId: vehicle._id, customerId: customer._id, jobType: "retail",
      odometerIn: 85000, fuelLevelIn: "1/2",
      complaints: [{ concern: "Brakes squeaking" }, { concern: "Oil change due" }, { concern: "AC not cold" }],
      lines: [
        { kind: "part", itemId: brakePads._id, qty: 1, price: 150 },
        { kind: "labour", itemId: labourBrake._id, qty: 1, price: 200 },
        { kind: "part", itemId: oilFilter._id, qty: 1, price: 40 },
        { kind: "labour", itemId: labourOil._id, qty: 1, price: 80 },
        { kind: "labour", itemId: labourAc._id, qty: 1, price: 100 },
      ],
      tasks: [
        { name: "Replace brake pads", mode: "in_house", stage: 1, standardHours: 1 },
        { name: "Oil change", mode: "in_house", stage: 1, standardHours: 0.5 },
      ],
    },
    "tester"
  );
  assert.match(card.jobNo, /^JC-\d{4}-\d{4}$/, "numbered through the JC series");
  assert.equal(card.status, "DRAFT");
  assert.equal(card.lines.length, 5);
  assert.equal(card.vehicle.plateNumber, "A 12345", "the vehicle's own details are snapshotted onto the card");
  lineIds = card.lines.map((l) => String(l._id));
  taskBrakeId = String(card.tasks[0]._id);
  taskOilId = String(card.tasks[1]._id);
});

test("a part cannot be billed as labour, and a service item cannot be billed as a part", { skip }, async () => {
  await assert.rejects(
    () => svc.JobCard.create({ vehicleId: vehicle._id, customerId: customer._id, complaints: [{ concern: "x" }], lines: [{ kind: "labour", itemId: brakePads._id, qty: 1, price: 10 }] }, "tester"),
    { code: "LINE_KIND_MISMATCH" }
  );
  await assert.rejects(
    () => svc.JobCard.create({ vehicleId: vehicle._id, customerId: customer._id, complaints: [{ concern: "x" }], lines: [{ kind: "part", itemId: labourBrake._id, qty: 1, price: 10 }] }, "tester"),
    { code: "LINE_KIND_MISMATCH" }
  );
});

test("sending the estimate, and the customer approving two of the three jobs", { skip }, async () => {
  card = await svc.JobCard.sendEstimate(card._id, "advisor1");
  assert.equal(card.status, "AWAITING_APPROVAL");
  assert.equal(card.estimate.version, 1);

  // The AC inspection (line 5) is declined; the brake job and the oil change are approved.
  const approvedIds = [lineIds[0], lineIds[1], lineIds[2], lineIds[3]];
  card = await svc.JobCard.recordApproval(card._id, { method: "whatsapp", lineIds: approvedIds }, "advisor1");
  assert.equal(card.status, "IN_PROGRESS");
  assert.equal(card.lines.find((l) => String(l._id) === lineIds[4]).approved, false, "the AC job is declined, not deleted");
  assert.equal(card.lines[0].approved, true);
  assert.equal(card.tasks[0].status, "READY", "both stage-1 tasks are ready at once: a mechanical job runs in parallel");
  assert.equal(card.tasks[1].status, "READY");
});

test("the gate pass refuses to release the car while work is open", { skip }, async () => {
  await assert.rejects(() => svc.JobCard.releaseVehicle(card._id, {}, "advisor1"), { code: "WORK_NOT_FINISHED" });
});

test("what is approved is already committed against the stock on hand, before anything has moved", { skip }, async () => {
  const committed = await svc.JobCard.committed([String(brakePads._id), String(oilFilter._id)]);
  const byId = Object.fromEntries(committed.map((c) => [c.itemId, c.committed]));
  assert.equal(byId[String(brakePads._id)], 1);
  assert.equal(byId[String(oilFilter._id)], 1);
  assert.equal(await onHand(brakePads), 10, "nothing has actually moved yet");
});

test("teardown finds more: a supplementary estimate on the SAME card, approved without disturbing work already running", { skip }, async () => {
  await svc.JobCard.startTask(card._id, taskBrakeId, "tech1");

  card = await svc.JobCard.reviseEstimate(card._id, { lines: [{ kind: "part", itemId: brakeDisc._id, qty: 2, price: 300 }] }, "advisor1");
  assert.equal(card.estimate.version, 2);
  assert.equal(card.status, "IN_PROGRESS", "the card is not sent back to waiting-for-approval while work is already running");
  const newLine = card.lines[5];
  assert.equal(newLine.approved, false, "pending until the customer actually decides on it");
  assert.equal(card.tasks.find((t) => String(t._id) === taskBrakeId).status, "IN_PROGRESS", "untouched by the revision");

  card = await svc.JobCard.recordApproval(card._id, { method: "call", lineIds: [String(newLine._id)] }, "advisor1");
  assert.equal(card.lines[5].approved, true);
  assert.equal(card.lines[0].approved, true, "the earlier decision is not reopened by a later one");
  assert.equal(card.status, "IN_PROGRESS");
});

test("tasks run and settle; the card reaches READY the moment every task is done", { skip }, async () => {
  card = await svc.JobCard.completeTask(card._id, taskBrakeId, { actualHours: 1.2 }, "tech1");
  assert.equal(card.tasks[0].status, "DONE");
  assert.equal(card.status, "IN_PROGRESS", "the oil change is still open");

  await svc.JobCard.startTask(card._id, taskOilId, "tech1");
  card = await svc.JobCard.completeTask(card._id, taskOilId, { actualHours: 0.4 }, "tech1");
  assert.equal(card.tasks[1].status, "DONE");
  assert.equal(card.status, "READY");
});

let invoice;
test("the invoice bills exactly the approved lines: four original plus the supplementary one, never the declined AC job", { skip }, async () => {
  const result = await svc.JobCard.createInvoice({ jobCardId: card._id, billTo: "customer" }, "tester");
  invoice = result.invoice;
  card = await svc.JobCardModel.findById(card._id).lean();
  assert.equal(invoice.type, "sales_order");
  assert.equal(invoice.status, "DRAFT");
  assert.equal(invoice.items.length, 5, "brake pads, brake job labour, oil filter, oil change labour, brake disc - not the declined AC inspection");
  assert.equal(card.invoiceStatus, "DRAFT");
  assert.equal(card.invoices.length, 1);
  assert.equal(card.invoices[0].billTo, "customer");
});

test("approving the invoice: parts move at the right cost, labour moves none, revenue lands in the right account, the books balance", { skip }, async () => {
  invoice = await approve(invoice);
  assert.equal(invoice.status, "APPROVED");

  // ---- stock: parts fell by exactly the quantity billed, at the SAME average cost (a sale never changes it) ----
  assert.equal(await onHand(brakePads), 9);
  assert.equal(await onHand(oilFilter), 9);
  assert.equal(await onHand(brakeDisc), 8);
  assert.equal(await avgCost(brakePads), 80);
  assert.equal(await avgCost(oilFilter), 25);
  assert.equal(await avgCost(brakeDisc), 150);

  // ---- no InventoryMovement for a labour line: exactly three movements, one per part, none for labour ----
  const moves = await movesOf(invoice);
  assert.equal(moves.length, 3, "one movement per PART line; labour moves no stock");
  const movedItems = moves.map((m) => m.stockId).sort(); // InventoryMovement.stockId is Stock.itemId (a string code), not the Mongo _id
  assert.deepEqual(movedItems, [brakeDisc.itemId, brakePads.itemId, oilFilter.itemId].sort());

  // ---- the ledger: labour revenue in its OWN account, parts revenue in sales-revenue, COGS right, balanced ----
  const byAcc = await byAccount(invoice);
  const entries = await live(invoice);
  const t = totals(entries);
  assert.equal(t.debit, t.credit, "every posting balances");

  const cogs = 1 * 80 + 1 * 25 + 2 * 150; // brake pads + oil filter + 2 brake discs, at their stocked cost
  assert.equal(cogs, 405);
  assert.equal(byAcc["Cost of Goods Sold"], cogs, "the cost of the parts sold");

  const partsRevenue = 150 + 40 + 300 * 2; // the three parts at their BILLED price, gross of VAT
  assert.equal(partsRevenue, 790);
  const salesRevenueAccount = await svc.LedgerAccount.findById(salesRevenueId).lean();
  assert.equal(-byAcc[salesRevenueAccount.accountName], partsRevenue, "sales-revenue carries the parts alone");

  const labourRevenue = 200 + 80; // the brake job and the oil change, at their billed price
  assert.equal(labourRevenue, 280);
  assert.equal(-byAcc["Other Income"], labourRevenue, "labour revenue is in its OWN account, not sales-revenue");
  assert.equal(byAcc["Other Income"] + byAcc[salesRevenueAccount.accountName], -(partsRevenue + labourRevenue), "and the two never overlap: nothing of one stream leaked into the other");

  // ---- the receivable is the whole invoice, VAT included ----
  const receivable = entries.filter((e) => e.accountName === "Customer - Ali Hassan");
  assert.equal(r2(receivable.reduce((s, e) => s + e.debitAmount, 0)), invoice.totalAmount);

  // ---- the job card learns its invoice is settled ----
  card = await svc.JobCardModel.findById(card._id).lean();
  assert.equal(card.invoiceStatus, "INVOICED");
  assert.equal(card.invoices[0].status, "APPROVED");
  assert.equal(card.status, "READY", "handing the car over is a separate step from invoicing it");

  // ---- committed stock is gone now that the invoice has actually moved it ----
  const committed = await svc.JobCard.committed([String(brakePads._id)]);
  assert.equal(committed[0].committed, 0, "an INVOICED card's parts are no longer 'promised': they are sold");
});

test("the gate pass refuses while the invoice is unpaid, and releases it on account", { skip }, async () => {
  await assert.rejects(() => svc.JobCard.releaseVehicle(card._id, { odometerOut: 85200 }, "advisor1"), (e) => e.code === "PAYMENT_DUE" && e.details.outstanding === invoice.totalAmount);

  card = await svc.JobCard.releaseVehicle(card._id, { odometerOut: 85200, onAccount: true }, "advisor1");
  assert.equal(card.status, "CLOSED", "handed over AND fully invoiced");
  assert.ok(card.delivery.gatePassAt);

  const v = await svc.VehicleModel.findById(vehicle._id).lean();
  assert.equal(v.odometer, 85200, "the vehicle's own record keeps the latest reading");
});

test("deleting the approved invoice reopens the job card to be invoiced again", { skip }, async () => {
  // TransactionService.deleteTransaction reverses an approved document (stock and ledger), and jobCardLinks
  // learns the invoice no longer exists.
  await svc.Tx.deleteTransaction(invoice._id, "tester");
  card = await svc.JobCardModel.findById(card._id).lean();
  assert.equal(card.invoices.length, 0);
  assert.equal(card.invoiceStatus, "NONE");
  assert.equal(card.status, "DELIVERED", "handed over, but no longer invoiced - reopened from CLOSED, never silently left wrong");
  assert.equal(await onHand(brakePads), 10, "the reversal gave the part back");
});
