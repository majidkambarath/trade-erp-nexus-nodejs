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
  const r = await runUnscoped("migration: repair settled-status rows across every organisation", () =>
    Transaction.updateMany({ status: { $in: ["paid", "partial", "unpaid"] } }, { $set: { status: "APPROVED" } })
  );
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
  const core = await assignCoreToOriginalOrganisation();
  if (Object.keys(core).length) out.coreAssigned = core; // only reported when something was actually assigned
  return out;
}

// The original collections (orders, ledger, parties, stock, masters ...) were written before organisations
// existed, so none of their rows names one. They all belong to the original organisation. This back-fills them,
// THEN rebuilds their indexes: the old UNIQUE indexes were global (one transactionNo in the whole database), which
// would stop a second organisation numbering its own first invoice, and Mongoose only ever adds indexes, so the old
// ones must be dropped here. Order matters: new rows must name an organisation before the per-organisation unique
// indexes are built over them. Idempotent: a repeat finds nothing to assign and nothing to drop.
const CORE = [
  ["Transaction", true], ["Voucher", true], ["LedgerEntry", true], ["LedgerAccount"], ["Customer"], ["Vendor"], ["Stock"],
  ["Category"], ["UOM"], ["UOMConversion"], ["Staff"], ["Transactor"], ["ExpenseCategory"], ["Sequence"], ["VATReport"],
  ["StockPurchaseLog", true], ["CreditLog"], ["DebitLog"], ["InventoryMovement", true], ["OpeningBalanceVoucher"],
];
const missing = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }] });

async function assignCoreToOriginalOrganisation() {
  const why = "migration: collections written before organisations existed belong to the original organisation";
  const done = {};
  for (const [name, hasBranch] of CORE) {
    const Model = mongoose.models[name];
    if (!Model) { done[name] = "model not loaded"; continue; }
    await Model.init(); // let Mongoose finish creating the collection and its indexes first
    const c = await runUnscoped(why, () => Model.updateMany(missing("companyId"), { $set: { companyId: DEFAULT_TENANT.companyId } }));
    let b = { modifiedCount: 0 };
    if (hasBranch) b = await runUnscoped(why, () => Model.updateMany(missing("branchId"), { $set: { branchId: DEFAULT_TENANT.branchId } }));
    await Model.syncIndexes(); // drops the old global unique indexes and builds the per-organisation ones
    if (c.modifiedCount || b.modifiedCount) done[name] = { companyId: c.modifiedCount, branchId: b.modifiedCount };
  }
  return done;
}

module.exports = { runMigrations, assignCoreToOriginalOrganisation };
