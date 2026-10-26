// Garage setup (bays, the service menu, its plan), the vehicle make/model catalogue, and a comeback marked on
// a new job card - against a throwaway database (random name, dropped afterwards).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
let category, labourOil, brakePads, customer, vehicle;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    StockService: require("../stock/stockService"),
    Vehicle: require("../garage/vehicleService"),
    JobCard: require("../garage/jobCardService"),
    Setup: require("../garage/garageSetupService"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });

  category = await svc.Category.create({ name: "Garage setup" });
  customer = await svc.Customer.create({ customerId: "CSU1", customerName: "Fatima Noor", contactPerson: "Fatima Noor", phone: "0507654321", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  labourOil = await svc.StockService.createStock({ ...base, sku: "LAB-SETUP-OIL", itemName: "Labour - oil service", itemType: "service", salesPrice: 90 }, "tester");
  brakePads = await svc.StockService.createStock({ ...base, sku: "PART-SETUP-PAD", itemName: "Brake pads (setup)", salesPrice: 150, purchasePrice: 80 }, "tester");
  vehicle = await svc.Vehicle.create({ plateNumber: "S 99001", make: "Nissan", model: "Patrol", year: 2021, colour: "Black", customerId: customer._id }, "tester");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("a bay needs a name; it is listed, and can be edited and deactivated", { skip }, async () => {
  const bay = await svc.Setup.createBay({ name: "Ramp 1", kind: "mechanical" }, "tester");
  assert.equal(bay.name, "Ramp 1");
  assert.equal(bay.active, true);

  await assert.rejects(() => svc.Setup.createBay({}, "tester"), (e) => e.code === "BAY_NAME_REQUIRED");

  const updated = await svc.Setup.updateBay(bay._id, { name: "Ramp 1A", kind: "body", active: false }, "tester");
  assert.equal(updated.name, "Ramp 1A");
  assert.equal(updated.active, false);

  const listed = await svc.Setup.listBays({ status: "all" });
  assert.ok(listed.some((b) => String(b._id) === String(bay._id) && b.name === "Ramp 1A"));
  // Deactivated, so the ordinary (active-only) list leaves it out.
  const activeOnly = await svc.Setup.listBays({});
  assert.ok(!activeOnly.some((b) => String(b._id) === String(bay._id)));
});

test("a standard job must bill under a real service item, never a stocked one", { skip }, async () => {
  await assert.rejects(
    () => svc.Setup.createService({ code: "WRONGKIND", name: "Wrong kind", serviceItemId: brakePads._id }, "tester"),
    (e) => e.code === "ITEM_NOT_A_SERVICE"
  );
  const svcRow = await svc.Setup.createService(
    { code: "OILSVC", name: "Oil service", serviceItemId: labourOil._id, standardHours: 1, defaultParts: [{ stockId: brakePads._id, qty: 1 }] },
    "tester"
  );
  assert.equal(svcRow.code, "OILSVC");
  await assert.rejects(
    () => svc.Setup.createService({ code: "OILSVC", name: "Duplicate code", serviceItemId: labourOil._id }, "tester"),
    (e) => e.code === "SERVICE_CODE_TAKEN"
  );
});

test("plan() turns a standard job into a priced draft and creates nothing", { skip }, async () => {
  const svcRow = await svc.Setup.createService(
    { code: "OILSVC2", name: "Oil service 2", serviceItemId: labourOil._id, standardHours: 0.5, defaultParts: [{ stockId: brakePads._id, qty: 2 }], defaultTasks: [{ name: "Drain and refill", mode: "in_house", standardHours: 0.5 }] },
    "tester"
  );
  const plan = await svc.Setup.plan({ serviceId: svcRow._id });
  assert.equal(plan.lines.length, 2);
  const labourLine = plan.lines.find((l) => l.kind === "labour");
  const partLine = plan.lines.find((l) => l.kind === "part");
  assert.equal(labourLine.price, 90); // the service item's own salesPrice
  assert.equal(partLine.qty, 2);
  assert.equal(partLine.price, 150);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.standardHours, 0.5);
});

test("the vehicle catalogue offers the makes and models already on file, as suggestions only", { skip }, async () => {
  const cat = await svc.Vehicle.catalogue();
  assert.ok(cat.makes.includes("Nissan"));
  assert.ok((cat.modelsByMake.Nissan || []).includes("Patrol"));
});

test("a comeback is offered from the vehicle's own closed jobs, and accepted only for that vehicle", { skip }, async () => {
  // No earlier job yet: nothing offered.
  assert.deepEqual(await svc.JobCard.comebackCandidates({ vehicleId: vehicle._id }), []);

  const first = await svc.JobCard.create(
    { vehicleId: vehicle._id, customerId: customer._id, complaints: [{ concern: "Brake noise" }], lines: [{ kind: "labour", itemId: labourOil._id, qty: 1, price: 50 }], tasks: [] },
    "tester"
  );
  await svc.JobCard.sendEstimate(first._id, "tester");
  await svc.JobCard.recordApproval(first._id, { method: "counter" }, "tester");
  await svc.JobCard.releaseVehicle(first._id, { warrantyMonths: 3 }, "tester");

  const candidates = await svc.JobCard.comebackCandidates({ vehicleId: vehicle._id });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].jobCardId, String(first._id));

  // Marking a new card as a comeback of it is accepted and stored.
  const second = await svc.JobCard.create(
    { vehicleId: vehicle._id, customerId: customer._id, complaints: [{ concern: "Same noise again" }], lines: [], tasks: [], comebackOf: String(first._id) },
    "tester"
  );
  assert.equal(String(second.comebackOf), String(first._id));

  // A job card from another vehicle cannot be claimed as this vehicle's comeback.
  const otherVehicle = await svc.Vehicle.create({ plateNumber: "S 99002", make: "Nissan", model: "Sunny", customerId: customer._id }, "tester");
  await assert.rejects(
    () => svc.JobCard.create({ vehicleId: otherVehicle._id, customerId: customer._id, complaints: [{ concern: "x" }], lines: [], tasks: [], comebackOf: String(first._id) }, "tester"),
    (e) => e.code === "COMEBACK_NOT_FOUND"
  );
});
