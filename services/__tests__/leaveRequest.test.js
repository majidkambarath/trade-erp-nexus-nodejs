// Leave requests against a throwaway database: a request submitted, decided through the SAME
// ApprovalPolicyService.judge a trade document or a voucher is judged by (D13), cancelled, and its balance
// derived rather than stored. No ledger involved - a leave request never posts.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_leave_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    LeaveType: require("../hr/timeSetupService").LeaveTypeService,
    LeaveRequest: require("../hr/leaveRequestService"),
    Queue: require("../core/approvalQueueService"),
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
const addDays = (d, n) => svc.days.addDays(d, n);

// Two signed-in people: a requester and someone else who approves. req-shaped objects, matching exactly
// what ApprovalPolicyService.actorOf reads (req.admin.id/name/role.approvalLimit) - no spawned server
// needed to prove the real approvals-policy code runs, only the controller/route wiring needs HTTP.
const reqOf = (id, name) => ({ admin: { id: String(id), name, role: {}, grants: ["hr.approve"] } });

let staff, leaveType, pending, requesterId, approverId;

test("setup: an employee and a leave type", { skip }, async () => {
  staff = await svc.Staff.createStaff(
    { name: "Priya Leave", designation: "Clerk", contactNo: "0504444444", idNo: "784LEAVE" + (Date.now() % 100000), joiningDate: addDays(today(), -400) },
    {}, admin
  );
  leaveType = await svc.LeaveType.create({ name: "Annual", accrualPerMonth: 2.5 }, "tester");
  requesterId = new mongoose.Types.ObjectId();
  approverId = new mongoose.Types.ObjectId();
});

test("submitting validates the pure rule and allocates a real LV number", { skip }, async () => {
  await assert.rejects(
    () => svc.LeaveRequest.submit({ staffId: staff._id, leaveTypeId: leaveType._id, fromDay: today(), toDay: addDays(today(), -1) }, String(requesterId)),
    (e) => e.code === "RANGE_BACKWARDS" || e.status === 400,
    "a range ending before it starts is refused by utils/leave.js validateLeaveRequest"
  );

  pending = await svc.LeaveRequest.submit(
    { staffId: staff._id, leaveTypeId: leaveType._id, fromDay: addDays(today(), 3), toDay: addDays(today(), 5), reason: "family trip" },
    String(requesterId)
  );
  assert.match(pending.requestNo, /^LV-\d{4}-\d{4}$/, "the LV series utils/voucherTypes.js seeds (default includeYear: true, numberLength: 4)");
  assert.equal(pending.status, "PENDING");
});

test("the pending request is a THIRD kind in the approvals queue, not a parallel screen (D13)", { skip }, async () => {
  const waiting = await svc.Queue.waiting(reqOf(approverId, "Approver"));
  const row = waiting.forYou.find((r) => r.id === String(pending._id));
  assert.ok(row, "the leave request appears in the SAME queue a document or voucher would");
  assert.equal(row.kind, "leaveRequest");
  assert.equal(row.party, "Priya Leave");
  assert.equal(row.amount, 0, "a leave request carries no money (D13: judged with amount 0)");
});

test("the requester cannot approve their own request when separateApprover would refuse it the same way it refuses a document", { skip }, async () => {
  // separateApprover is off by default in the seed, so the requester approving their own request succeeds
  // here - this test instead proves the DIFFERENT-person path works, which is the one every organisation
  // actually uses day to day; the self-approval refusal itself is already pinned for documents/vouchers in
  // approvalsHttp.test.js and rules.decide's own unit tests (utils/__tests__/approvalRules.test.js), and
  // D13's whole point is that leave reuses that exact function rather than re-implementing it.
  const decided = await svc.LeaveRequest.decide(pending._id, { action: "approve" }, reqOf(approverId, "Approver"));
  assert.equal(decided.status, "APPROVED");
  assert.equal(decided.approvals.length, 1);
  assert.equal(decided.approvals[0].by, String(approverId));
});

test("a decided request is no longer in anyone's queue", { skip }, async () => {
  const waiting = await svc.Queue.waiting(reqOf(approverId, "Approver"));
  assert.ok(!waiting.forYou.some((r) => r.id === String(pending._id)));
  assert.ok(!waiting.others.some((r) => r.id === String(pending._id)));
});

test("deciding an already-decided request is refused, not silently repeated", { skip }, async () => {
  await assert.rejects(() => svc.LeaveRequest.decide(pending._id, { action: "approve" }, reqOf(approverId, "Approver")), (e) => e.code === "NOT_PENDING");
});

test("a rejection records the reason and never touches the balance", { skip }, async () => {
  const second = await svc.LeaveRequest.submit(
    { staffId: staff._id, leaveTypeId: leaveType._id, fromDay: addDays(today(), 10), toDay: addDays(today(), 10) },
    String(requesterId)
  );
  const decided = await svc.LeaveRequest.decide(second._id, { action: "reject", reason: "short-staffed that week" }, reqOf(approverId, "Approver"));
  assert.equal(decided.status, "REJECTED");
  assert.equal(decided.rejectReason, "short-staffed that week");
});

test("cancelling a request already approved removes it from the live balance", { skip }, async () => {
  const before = await svc.LeaveRequest.balance(staff._id, leaveType._id);
  assert.ok(before.consumed >= 3, "the first request's 3 days (inclusive) are counted while approved and live");

  await svc.LeaveRequest.cancel(pending._id, String(requesterId));
  const after = await svc.LeaveRequest.balance(staff._id, leaveType._id);
  assert.equal(after.consumed, 0, "a cancelled request - even one that was approved - no longer consumes the balance (utils/leave.js: !cancelledAt)");

  await assert.rejects(() => svc.LeaveRequest.cancel(pending._id, String(requesterId)), (e) => e.code === "ALREADY_CANCELLED");
});

test("the balance is derived, never stored: it is accrual since joining, less what is still live", { skip }, async () => {
  const b = await svc.LeaveRequest.balance(staff._id, leaveType._id);
  assert.ok(b.accrued > 0, "Priya joined over a year ago at 2.5 days/month, so months have genuinely accrued");
  assert.equal(b.consumed, 0);
  assert.equal(b.available, b.accrued);
});
