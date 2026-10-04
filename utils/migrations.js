const mongoose = require("mongoose");

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
  return out;
}

module.exports = { runMigrations };
