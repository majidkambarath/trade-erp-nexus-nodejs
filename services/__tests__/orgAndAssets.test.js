// Departments, a reporting line, and asset assignment - against a throwaway database. None of this posts
// or costs anything: it is directory structure (Organization) and what is in whose hands (Assets), the two
// gaps found comparing the module against a standard HRMS module list.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_org_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Department: require("../hr/timeSetupService").DepartmentService,
    Asset: require("../hr/assetAssignmentService"),
    days: require("../../utils/documentExpiry"),
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

const admin = new mongoose.Types.ObjectId();
const today = () => svc.days.todayInOrg();

let dept, manager, report;

test("a department is created once, and a second of the same name is refused", { skip }, async () => {
  dept = await svc.Department.create({ name: "Fabrication" }, "tester");
  await assert.rejects(() => svc.Department.create({ name: "Fabrication" }, "tester"), (e) => e.code === "DEPARTMENT_EXISTS");
});

test("an employee can be given a structured department, which also fills the free-text field", { skip }, async () => {
  manager = await svc.Staff.createStaff(
    { name: "Manager Org", designation: "Supervisor", contactNo: "0507777777", idNo: "784ORG0001" + (Date.now() % 100000), joiningDate: today() },
    {}, admin
  );
  report = await svc.Staff.createStaff(
    { name: "Report Org", designation: "Fabricator", contactNo: "0507777778", idNo: "784ORG0002" + (Date.now() % 100000), joiningDate: today(), departmentId: dept._id, managerId: manager._id },
    {}, admin
  );
  assert.equal(String(report.departmentId), String(dept._id));
  assert.equal(report.department, "Fabrication", "the structured pick also filled the free-text field");
  assert.equal(String(report.managerId), String(manager._id));
});

test("a person cannot report to themselves", { skip }, async () => {
  await assert.rejects(
    () => svc.Staff.updateStaff(String(report._id), { managerId: String(report._id) }, {}, "tester"),
    (e) => e.code === "MANAGER_IS_SELF"
  );
});

test("a made-up department or manager id is refused, not silently stored", { skip }, async () => {
  const fake = new mongoose.Types.ObjectId();
  await assert.rejects(
    () => svc.Staff.createStaff({ name: "X", designation: "Y", contactNo: "0501111111", idNo: "784ORG9999", joiningDate: today(), departmentId: fake }, {}, admin),
    (e) => e.code === "DEPARTMENT_NOT_FOUND"
  );
});

test("an explicit free-text department wins over the structured pick in the same request", { skip }, async () => {
  const updated = await svc.Staff.updateStaff(String(report._id), { departmentId: dept._id, department: "Custom text" }, {}, "tester");
  assert.equal(updated.department, "Custom text");
});

test("an asset is issued, returned, and the register tells who currently has what", { skip }, async () => {
  const laptop = await svc.Asset.issue({ staffId: report._id, assetName: "Dell Laptop", assetTag: "LAP-001", issuedDate: today(), condition: "New" }, "tester");
  assert.equal(laptop.returnedDate, null);

  const withEmployee = await svc.Asset.list({ status: "withEmployee" });
  assert.ok(withEmployee.some((a) => String(a._id) === String(laptop._id)));

  await svc.Asset.markReturned(laptop._id, { returnCondition: "Working" }, "tester");
  await assert.rejects(() => svc.Asset.markReturned(laptop._id, {}, "tester"), (e) => e.code === "ALREADY_RETURNED");

  const returned = await svc.Asset.list({ status: "returned" });
  assert.ok(returned.some((a) => String(a._id) === String(laptop._id)));

  const forReport = await svc.Asset.forStaff(report._id);
  assert.equal(forReport.length, 1);
  assert.equal(forReport[0].assetName, "Dell Laptop");
});
