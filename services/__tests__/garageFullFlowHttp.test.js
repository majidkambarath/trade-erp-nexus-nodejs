// The whole garage story, proven over real HTTP against a spawned strict server (the same shape every
// *Http.test.js file in this project uses) - the closest thing to "click through the browser" a test
// can do: sign in, stock a part, add a vehicle and a customer, open a job card, check it in, send and
// approve the estimate, run its tasks, raise and approve the invoice, release the vehicle on a gate
// pass, and confirm the vehicle's own service history shows it. Also the service menu, bays, and a
// part short of stock raising a real purchase order.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_garageflow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "flowcheck-garage";

let child, M, Org, token;
let logs = "";

async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", SUPPORT_CONTACT: "help@zarvia.example" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Organisation: require("../../models/core/organisationModel"),
  };
  Org = require("../core/organisationService");
  const ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  await Org.create({ legalName: "Flow Check Garage LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { garage: true } });
  await ctx.runWithTenant({ companyId: CODE, branchId: "main" }, () =>
    new M.Admin({ name: "Flow Check Owner", email: "owner@flowcheck-garage.ae", password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save()
  );
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@flowcheck-garage.ae", password: PASSWORD }) });
  const loginJson = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginJson));
  token = loginJson.data.tokens.accessToken;
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("the whole garage flow, over real HTTP: vehicle, job card, estimate, approval, tasks, invoice, gate pass", { skip }, async () => {
  // A category and two items (one part, one labour), the part stocked so the job is not short to start.
  const category = await call("POST", "/categories/categories", { name: "Flow Check Category" });
  assert.equal(category.status, 201, JSON.stringify(category.data));
  const categoryId = category.body.category._id;

  const vendor = await call("POST", "/vendors/vendors", { vendorName: "Flow Check Vendor", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  assert.equal(vendor.status, 201, JSON.stringify(vendor.data));

  const base = { categoryId, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  const part = await call("POST", "/stock/stock", { ...base, sku: "FLOW-PART", itemName: "Flow check brake pad", salesPrice: 150, vendorId: vendor.body._id });
  assert.equal(part.status, 201, JSON.stringify(part.data));
  const partId = part.body.stock._id;
  const labour = await call("POST", "/stock/stock", { ...base, sku: "FLOW-LABOUR", itemName: "Flow check labour", itemType: "service", salesPrice: 100 });
  assert.equal(labour.status, 201, JSON.stringify(labour.data));
  const labourId = labour.body.stock._id;

  const buy = await call("POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: partId, description: "x", qty: 10, price: 80, rate: 80, vatPercent: 0 }] });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  const approveBuy = await call("POST", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" });
  assert.equal(approveBuy.status, 200, JSON.stringify(approveBuy.data));

  // Setup: a bay and a standard job (the service menu), before the job card that will use them.
  const bay = await call("POST", "/garage/bays", { name: "Flow Check Ramp", kind: "mechanical" });
  assert.equal(bay.status, 201, JSON.stringify(bay.data));
  const standardJob = await call("POST", "/garage/services", { code: "FLOWSVC", name: "Flow check service", serviceItemId: labourId, standardHours: 1 });
  assert.equal(standardJob.status, 201, JSON.stringify(standardJob.data));
  const plan = await call("GET", `/garage/services/plan?serviceId=${standardJob.body._id}`);
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(plan.body.lines[0].itemId, labourId);

  // The vehicle, and a walk-in customer created in place (the quick-add door).
  const vehicle = await call("POST", "/garage/vehicles", { plateNumber: "FLOW 1", make: "Toyota", model: "Camry", year: 2022, colour: "White" });
  assert.equal(vehicle.status, 201, JSON.stringify(vehicle.data));
  const customer = await call("POST", "/garage/customers", { name: "Flow Check Customer" });
  assert.equal(customer.status, 201, JSON.stringify(customer.data));

  // The job card itself: complaints, a part line and a labour line, a task on the bay just made.
  const jc = await call("POST", "/garage/job-cards", {
    vehicleId: vehicle.body._id, customerId: customer.body.id, jobType: "retail",
    complaints: [{ concern: "Flow check: brakes squeaking" }],
    lines: [
      { kind: "part", itemId: partId, qty: 1, price: 150 },
      { kind: "labour", itemId: labourId, qty: 1, price: 100 },
    ],
    tasks: [{ name: "Flow check task", mode: "in_house", stage: 1, standardHours: 1, bayId: bay.body._id }],
  });
  assert.equal(jc.status, 201, JSON.stringify(jc.data));
  const jobCardId = jc.body._id;
  assert.ok(jc.body.jobNo, "a real job number was allocated");
  assert.ok(jc.body.lines.every((l) => l.lineTotal > 0), "every line prices to a real amount, not AED 0.00");
  assert.equal(jc.body.tasks[0].bayName, "Flow Check Ramp", "the task carries the bay's name, not just its id");

  const checkIn = await call("PUT", `/garage/job-cards/${jobCardId}/check-in`, { itemsPresent: ["Spare wheel", "Jack and tools"], notes: "Flow check walk-around" });
  assert.equal(checkIn.status, 200, JSON.stringify(checkIn.data));
  assert.deepEqual(checkIn.body.checkIn.itemsPresent, ["Spare wheel", "Jack and tools"]);

  const sent = await call("POST", `/garage/job-cards/${jobCardId}/send-estimate`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, "AWAITING_APPROVAL");

  const approved = await call("POST", `/garage/job-cards/${jobCardId}/approve`, { method: "whatsapp", note: "Flow check approval" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "IN_PROGRESS");
  const task = approved.body.tasks[0];
  assert.equal(task.status, "READY", "the first-stage task is released the moment the estimate is approved");

  const started = await call("POST", `/garage/job-cards/${jobCardId}/tasks/${task._id}/start`, {});
  assert.equal(started.status, 200);
  assert.equal(started.body.tasks[0].status, "IN_PROGRESS");

  const done = await call("POST", `/garage/job-cards/${jobCardId}/tasks/${task._id}/complete`, { actualHours: 1 });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "READY", "every task settled moves the card to ready for collection");

  const shortages = await call("GET", `/garage/job-cards/${jobCardId}/shortages`);
  assert.equal(shortages.status, 200);
  assert.deepEqual(shortages.body, [], "the part was stocked beforehand, so nothing is short");

  const invoice = await call("POST", `/garage/job-cards/${jobCardId}/invoice`, { billTo: "customer" });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
  assert.ok(invoice.body.invoice.totalAmount >= 250, `priced for real by buildPricing (150 + 100, plus VAT if any): ${invoice.body.invoice.totalAmount}`);

  const approveInvoice = await call("POST", `/transactions/transactions/${invoice.body.invoice._id}/process`, { action: "approve" });
  assert.equal(approveInvoice.status, 200, JSON.stringify(approveInvoice.data));

  const afterInvoice = await call("GET", `/garage/job-cards/${jobCardId}`);
  assert.equal(afterInvoice.body.invoiceStatus, "INVOICED", "jobCardLinks picked up the approval");

  const release = await call("POST", `/garage/job-cards/${jobCardId}/release`, { odometerOut: 100, handedTo: "Flow Check Customer", warrantyMonths: 3 });
  assert.equal(release.status, 200, JSON.stringify(release.data));
  assert.equal(release.body.status, "CLOSED", "invoiced and handed back: the job is fully closed");
  assert.ok(release.body.delivery.gatePassAt, "the gate pass carries a real timestamp");
  assert.ok(release.body.warranty.until, "a 3-month warranty was worked out from the release day");

  // A second car is short of a part not yet bought, and raising a purchase order for it is real.
  const partsVendor = vendor.body._id;
  const shortPart = await call("POST", "/stock/stock", { ...base, sku: "FLOW-SHORT", itemName: "Flow check short part", salesPrice: 200, vendorId: partsVendor });
  assert.equal(shortPart.status, 201, JSON.stringify(shortPart.data));
  const shortPartId = shortPart.body.stock._id;
  const vehicle2 = await call("POST", "/garage/vehicles", { plateNumber: "FLOW 2", make: "Honda", model: "Civic" });
  const jc2 = await call("POST", "/garage/job-cards", {
    vehicleId: vehicle2.body._id, customerId: customer.body.id, jobType: "retail",
    complaints: [{ concern: "Flow check: needs the short part" }],
    lines: [{ kind: "part", itemId: shortPartId, qty: 2, price: 200 }],
  });
  assert.equal(jc2.status, 201, JSON.stringify(jc2.data));
  const short2 = await call("GET", `/garage/job-cards/${jc2.body._id}/shortages`);
  assert.equal(short2.status, 200);
  assert.equal(short2.body.length, 1);
  assert.equal(short2.body[0].short, 2);
  assert.equal(short2.body[0].vendorName, "Flow Check Vendor");

  const po = await call("POST", `/garage/job-cards/${jc2.body._id}/purchase-orders`, { vendorId: partsVendor, items: [{ itemId: shortPartId, qty: 2, price: 180 }] });
  assert.equal(po.status, 201, JSON.stringify(po.data));
  assert.equal(po.body.order.kind, "purchase");
  assert.equal(po.body.jobCard.purchaseOrders.length, 1);

  // The vehicle's own service history shows the first job, closed, with its real total.
  const history = await call("GET", `/garage/vehicles/${vehicle.body._id}/jobs`);
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0]._id, jobCardId);
  assert.equal(history.body[0].status, "CLOSED");

  // The board shows nothing live left for the first vehicle's job (it is closed, not a live status).
  const board = await call("GET", "/garage/job-cards/board");
  assert.equal(board.status, 200);
  assert.ok(!board.body.columns.some((c) => c.cards.some((card) => card.jobCardId === jobCardId)), "a closed job is not shown as live on the board");
});
