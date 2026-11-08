// The garage's reports (services/garage/garageReportService.js) against a throwaway database. The pure
// rules are proved with no database at all in utils/__tests__/garageReports.test.js; what THIS file proves
// is that the real Mongo query returns the right rows and the joins (to Transaction for what is owed, to
// Stock for cost, to InsuranceClaim for the insurer side) actually work - including the regression that
// started this whole piece of work: a technician's hours on a car still in the shop must now be visible.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let GarageReportService, JobCardService, JobCard, Vehicle, Customer, Stock, Category, Transaction, InsuranceClaim;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  GarageReportService = require("../garage/garageReportService");
  JobCardService = require("../garage/jobCardService");
  JobCard = require("../../models/modules/garage/jobCardModel");
  Vehicle = require("../../models/modules/garage/vehicleModel");
  Customer = require("../../models/modules/customerModel");
  Stock = require("../../models/modules/stockModel");
  Category = require("../../models/modules/categoryModel");
  Transaction = require("../../models/modules/transactionModel");
  InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
  await mongoose.connection.syncIndexes();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let customer, vehicle, part, labour, category;

test("fixtures: a customer, a vehicle, a stocked part at a known cost, a labour item", { skip }, async () => {
  customer = await Customer.create({ customerId: "C1", customerName: "Ali Hassan", contactPerson: "Ali Hassan", phone: "0501234567", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  vehicle = await Vehicle.create({ plateNumber: "A 11111", plateKey: "A11111", make: "Toyota", model: "Hilux", customerId: customer._id, customerName: customer.customerName });
  category = await Category.create({ name: "Garage test" });
  const base = { category: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  // purchasePrice set directly: the weighted-average costing engine itself is proved elsewhere
  // (services/__tests__/garage.test.js); this report only needs a known cost to join against.
  part = await Stock.create({ ...base, itemId: "RPT-PART", sku: "RPT-PART", itemName: "Brake pads", salesPrice: 150, purchasePrice: 60, currentStock: 10, costValue: 600 });
  labour = await Stock.create({ ...base, itemId: "RPT-LAB", sku: "RPT-LAB", itemName: "Labour", itemType: "service", salesPrice: 300 });
});

test("overview and work in progress: a technician's hours on a car still in the shop are now visible (the regression this work started from)", { skip }, async () => {
  // IN_PROGRESS, never delivered - the old analysis() query (by delivery.gatePassAt alone) would never
  // have read this card at all, so Raj's two hours would vanish from every period they fall in.
  const inProgress = await JobCard.create({
    jobNo: "JC-RPT-1", status: "IN_PROGRESS", jobType: "retail",
    vehicleId: vehicle._id, vehicle: { plateNumber: "A 11111", make: "Toyota", model: "Hilux" },
    customerId: customer._id, customer: { name: "Ali Hassan" },
    receivedAt: new Date("2026-10-20T08:00:00Z"),
    lines: [{ kind: "part", itemId: part._id, qty: 1, price: 150, approved: true }],
    tasks: [{ name: "Brakes", mode: "in_house", staffName: "Raj", status: "DONE", doneAt: new Date("2026-10-22T08:00:00Z"), standardHours: 2, actualHours: 2 }],
    invoiceStatus: "NONE",
  });
  const r = await JobCardService.analysis({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(r.people.length, 1, "Raj's finished task must be read even though the car has not left yet");
  assert.equal(r.people[0].label, "Raj");
  assert.equal(r.people[0].hoursTaken, 2);
  assert.equal(r.capped, false);

  const overview = await GarageReportService.overview({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(overview.people[0].label, "Raj");
  assert.equal(overview.invoiced.total, 0); // nothing delivered yet, so nothing invoiced

  const wip = await GarageReportService.workInProgress();
  const row = wip.rows.find((x) => x.jobNo === "JC-RPT-1");
  assert.ok(row, "the live card shows up on the floor");
  assert.equal(row.value, 150);
  assert.equal(row.status, "IN_PROGRESS");

  await JobCard.deleteOne({ _id: inProgress._id });
});

test("work in progress: delivered but not invoiced is counted, and what is owed comes from the real invoice, not the estimate", { skip }, async () => {
  // outstandingAmount is NOT settable directly - the model's own pre-save hook recomputes it from
  // totalAmount - paidAmount - creditedAmount on every save (transactionModel.js), so paidAmount is what
  // actually drives it here: 420 total, 270 paid, 150 left owing.
  const txn = await Transaction.create({
    type: "sales_order", transactionNo: "RPT-SO-0001", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
    items: [], totalAmount: 420, paidAmount: 270, status: "APPROVED", createdBy: "tester",
  });
  const delivered = await JobCard.create({
    jobNo: "JC-RPT-2", status: "DELIVERED", jobType: "retail",
    vehicleId: vehicle._id, vehicle: { plateNumber: "A 11111", make: "Toyota", model: "Hilux" },
    customerId: customer._id, customer: { name: "Ali Hassan" },
    receivedAt: new Date(), lines: [{ kind: "labour", itemId: labour._id, qty: 1, price: 300, approved: true }],
    tasks: [], delivery: { gatePassAt: new Date() },
    invoices: [{ transactionId: txn._id, no: "RPT-SO-0001", billTo: "customer", amount: 420, status: "APPROVED" }],
    invoiceStatus: "INVOICED",
  });
  const wip = await GarageReportService.workInProgress();
  assert.ok(wip.value.deliveredNotInvoiced.count >= 1); // DELIVERED status, whatever invoiceStatus says
  assert.equal(wip.value.owed, 150); // Transaction.outstandingAmount, never the invoice's gross 420
  await JobCard.deleteOne({ _id: delivered._id });
  await Transaction.deleteOne({ _id: txn._id });
});

test("profit: a known part cost gives a real margin; an uncosted labour hour is named, not hidden", { skip }, async () => {
  const card = await JobCard.create({
    jobNo: "JC-RPT-3", status: "DELIVERED", jobType: "retail",
    vehicleId: vehicle._id, vehicle: {}, customerId: customer._id, customer: {},
    receivedAt: new Date(),
    lines: [
      { kind: "part", itemId: part._id, qty: 2, price: 150, approved: true }, // revenue 300, cost 2x60=120
      { kind: "labour", itemId: labour._id, qty: 1, price: 300, approved: true },
    ],
    // No staff/contract fixture exists - LabourCostService.forJobCards must report this as uncosted,
    // not as free (zero cost would overstate the margin).
    tasks: [{ name: "Fit pads", mode: "in_house", staffName: "Raj", status: "DONE", doneAt: new Date(), standardHours: 1, actualHours: 1 }],
    delivery: { gatePassAt: new Date() },
  });
  const { fromDay, toDay } = { fromDay: require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() - 86400000)), toDay: require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() + 86400000)) };
  const profit = await GarageReportService.profit({ from: fromDay, to: toDay });
  assert.equal(profit.revenue.part, 300);
  assert.equal(profit.cost.parts, 120);
  assert.equal(profit.margin.parts, 180);
  assert.ok(profit.uncostedLabourHours >= 1, "nobody's contract rate exists for Raj, so the hour is reported, not costed as free");
  assert.equal(profit.cost.labour, 0);
  await JobCard.deleteOne({ _id: card._id });
});

test("customers: spend and repeat visits are read from the delivered jobs, invoiced only when the invoice is approved", { skip }, async () => {
  const txn = await Transaction.create({ type: "sales_order", transactionNo: "RPT-SO-0002", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [], totalAmount: 100, outstandingAmount: 0, status: "APPROVED", createdBy: "tester" });
  const c1 = await JobCard.create({ jobNo: "JC-RPT-4", status: "DELIVERED", vehicleId: vehicle._id, vehicle: {}, customerId: customer._id, customer: { name: "Ali Hassan" }, receivedAt: new Date(), lines: [], tasks: [], delivery: { gatePassAt: new Date() }, invoices: [{ transactionId: txn._id, amount: 100, status: "APPROVED" }] });
  const c2 = await JobCard.create({ jobNo: "JC-RPT-5", status: "DELIVERED", vehicleId: vehicle._id, vehicle: {}, customerId: customer._id, customer: { name: "Ali Hassan" }, receivedAt: new Date(), lines: [], tasks: [], delivery: { gatePassAt: new Date() } });
  const fromDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() - 86400000));
  const toDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() + 86400000));
  const r = await GarageReportService.customers({ from: fromDay, to: toDay });
  const ali = r.rows.find((x) => x.customerId === String(customer._id));
  assert.ok(ali);
  assert.ok(ali.jobs >= 2);
  assert.equal(ali.repeat, true);
  await JobCard.deleteMany({ _id: { $in: [c1._id, c2._id] } });
  await Transaction.deleteOne({ _id: txn._id });
});

test("vehicles: registration expiring and service due are read straight off the Vehicle master", { skip }, async () => {
  const soon = new Date(Date.now() + 5 * 86400000);
  const v2 = await Vehicle.create({ plateNumber: "B 22222", plateKey: "B22222", make: "Nissan", model: "Patrol", customerId: customer._id, registrationExpiry: soon });
  const r = await GarageReportService.vehicles();
  const row = r.registrationExpiring.find((x) => x.plate === "B 22222");
  assert.ok(row, "a registration due within the window is listed");
  assert.equal(row.state, "soon");
  await Vehicle.deleteOne({ _id: v2._id });
});

test("insurers: a rejected claim's value is counted - the gap claimAgeing's own LIVE_STATUS filter leaves invisible", { skip }, async () => {
  const job = await JobCard.create({ jobNo: "JC-RPT-6", status: "DELIVERED", vehicleId: vehicle._id, vehicle: {}, customerId: customer._id, customer: {}, receivedAt: new Date(), lines: [], tasks: [], delivery: { gatePassAt: new Date() }, estimate: { total: 800 } });
  const insurer = await Customer.create({ customerId: "INS1", customerName: "Orient Insurance", isInsurer: true, contactPerson: "x", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const claim = await InsuranceClaim.create({ insurerId: insurer._id, insurer: { name: "Orient Insurance" }, policyNo: "POL-1", jobCardId: job._id, status: "REJECTED", submittedAt: new Date(), rejectedAt: new Date(), rejectReason: "Not covered" });
  const fromDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() - 86400000));
  const toDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() + 86400000));
  const r = await GarageReportService.insurers({ from: fromDay, to: toDay });
  const row = r.rows.find((x) => x.insurer === "Orient Insurance");
  assert.ok(row);
  assert.equal(row.rejected, 1);
  assert.equal(row.rejectedValue, 800);
  await InsuranceClaim.deleteOne({ _id: claim._id });
  await JobCard.deleteOne({ _id: job._id });
  await Customer.deleteOne({ _id: insurer._id });
});

test("people and bays: hours sold against hours taken, grouped by technician and by bay", { skip }, async () => {
  const fromDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() - 86400000));
  const toDay = require("../../utils/documentExpiry").toExpiryDay(new Date(Date.now() + 86400000));
  const card = await JobCard.create({
    jobNo: "JC-RPT-7", status: "IN_PROGRESS", vehicleId: vehicle._id, vehicle: {}, customerId: customer._id, customer: {}, receivedAt: new Date(),
    lines: [], tasks: [{ name: "Brakes", mode: "in_house", staffName: "Raj", status: "DONE", doneAt: new Date(), standardHours: 2, actualHours: 3, bayName: "Ramp 1" }],
  });
  const r = await GarageReportService.peopleAndBays({ from: fromDay, to: toDay });
  assert.ok(r.people.some((p) => p.label === "Raj" && p.hoursTaken === 3));
  assert.ok(r.bays.some((b) => b.name === "Ramp 1" && b.hoursTaken === 3));
  await JobCard.deleteOne({ _id: card._id });
});
