const mongoose = require("mongoose");
const { DEFAULT_TENANT, runUnscoped } = require("./tenantContext");

// One-off repairs of data written by older versions. Each is idempotent, so running them on every
// start is safe and cheap.
async function runMigrations() {
  const out = {};
  const Transaction = mongoose.model("Transaction");
  // Receipts and payments used to overwrite an invoice's status with paid / partial / unpaid, which
  // hid it from everything that looks for APPROVED documents. The payment state lives in
  // paidAmount / outstandingAmount; the status goes back to APPROVED.
  const r = await Transaction.updateMany({ status: { $in: ["paid", "partial", "unpaid"] } }, { $set: { status: "APPROVED" } });
  out.settledStatusRepaired = r.modifiedCount;

  // Accounts and sign-in sessions made before organisations existed all belong to the original one. Without
  // this nobody could sign in once an account must name its organisation. These run with no organisation in
  // scope on purpose: it is a repair across every row that has none.
  const Admin = require("../models/core/adminModel");
  const AuthSession = require("../models/core/authSessionModel");
  const original = { companyId: DEFAULT_TENANT.companyId, branchId: DEFAULT_TENANT.branchId };
  const noOrg = { companyId: { $exists: false } };
  const why = "migration: accounts and sessions made before organisations existed belong to the original organisation";
  out.accountsAssigned = (await runUnscoped(why, () => Admin.updateMany(noOrg, { $set: original }))).modifiedCount;
  out.sessionsAssigned = (await runUnscoped(why, () => AuthSession.updateMany(noOrg, { $set: { companyId: original.companyId } }))).modifiedCount;
  return out;
}

module.exports = { runMigrations };
