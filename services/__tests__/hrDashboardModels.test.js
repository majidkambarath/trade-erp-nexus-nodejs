// The HR dashboard must register every model it depends on ITSELF.
//
// No database: this is about module loading, and it has to run in a process where nothing else has been
// required - which is exactly what node:test gives each file. That isolation is the whole point, so do not
// fold these cases into services/__tests__/hrDashboard.test.js: that file requires
// employeeDocumentService in its setup, which registers EmployeeDocument as a side effect and would make
// the assertion below pass whether the dashboard registers it or not. A test that cannot fail is worth
// nothing, and this one was written after exactly that mistake was caught.
//
// The bug it guards: DocumentExpiryService resolves EmployeeDocument through `mongoose.models` and quietly
// `continue`s past the whole staff branch when it is not registered. The dashboard then reported a
// confident `0` expiring documents for an organisation that had six - a silent zero on a compliance
// figure, which is the worst shape of wrong a management screen can take.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

test("nothing is registered before the dashboard service is required - the premise of the next case", () => {
  assert.equal(Boolean(mongoose.models.EmployeeDocument), false, "if this fails, something above it required a model and the next case proves nothing");
  assert.equal(Boolean(mongoose.models.Staff), false);
});

test("requiring the dashboard service alone registers every model its figures read through mongoose.models", () => {
  require("../hr/hrDashboardService");

  // The one the expiry card needs, and the reason this file exists.
  assert.ok(mongoose.models.EmployeeDocument, "EmployeeDocument must be registered, or DocumentExpiryService silently skips staff and the card reads 0");
  // The rest the dashboard reads directly; a missing one would throw rather than lie, but they belong here too.
  for (const name of ["Staff", "AttendanceDay", "LeaveRequest", "PayrollRun", "Payslip", "StaffChecklistItem"]) {
    assert.ok(mongoose.models[name], `${name} must be registered by the dashboard service`);
  }
});
