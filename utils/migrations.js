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
  const applied = await applyApprovedReturnsToTheirInvoices();
  if (applied) out.returnsApplied = applied;
  const contacts = await backfillCrmContacts();
  if (contacts) out.crmContactsBackfilled = contacts;
  const held = await markVoucherNumbersHeld();
  if (held) out.voucherNumbersMarkedHeld = held;
  return out;
}

// A contact used to be a line inside the party form and nothing else. The CRM gives a person their own record
// (models/modules/crm/contactModel.js), and the two sides are kept in step by SHARING an id: the Contact _id is the
// _id of the row in the party's own `contacts[]`. This copies the rows that existed before that collection did.
//
// Idempotent because every write is an upsert keyed on that shared id, so a repeat finds the same rows and changes
// nothing; the CRM-only fields are only ever set on insert, so a person edited in the CRM is not reset by a restart.
// Unscoped on purpose: it is a repair across every organisation, and each row carries the companyId of its own party.
async function backfillCrmContacts() {
  const Contact = require("../models/modules/crm/contactModel");
  const why = "migration: give the people on customers and suppliers their own CRM records, across every organisation";
  let done = 0;

  for (const [modelName, field] of [["Customer", "customerId"], ["Vendor", "vendorId"]]) {
    const Model = mongoose.model(modelName);
    const parties = await runUnscoped(why, () =>
      Model.find({ "contacts.0": { $exists: true } }).select("contacts companyId").lean()
    );
    const writes = [];
    for (const party of parties) {
      for (const row of party.contacts || []) {
        if (!row?._id) continue;
        writes.push({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                name: row.name,
                designation: row.designation || "",
                email: row.email || "",
                phone: row.phone || "",
                isPrimary: Boolean(row.isPrimary),
                [field]: party._id,
              },
              $setOnInsert: { companyId: party.companyId, createdBy: "system", notes: "", leadId: null },
            },
            upsert: true,
          },
        });
      }
    }
    if (!writes.length) continue;
    const result = await runUnscoped(why, () => Contact.bulkWrite(writes, { ordered: false }));
    done += result?.upsertedCount || 0;
  }
  return done;
}

// A return used to leave the invoice it returned reading "Unpaid" for its full amount. Approved returns are now set against
// that invoice (ReturnService.applyToOriginal); the ones approved before that are set against it here, once. `appliedToInvoice`
// is the marker: a return that has the field has been dealt with (it is claimed BEFORE the invoice is touched, so two
// instances starting together cannot apply one return twice, and a crash in between under-applies rather than double-applies).
async function applyApprovedReturnsToTheirInvoices() {
  const Transaction = mongoose.model("Transaction");
  const why = "migration: set approved returns against the invoices they return, across every organisation";
  const returns = await runUnscoped(why, () =>
    Transaction.find({
      type: { $in: ["sales_return", "purchase_return"] }, status: "APPROVED",
      "returnOf.transactionId": { $ne: null }, appliedToInvoice: { $exists: false },
    }).select("type totalAmount returnOf").lean()
  );
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  let done = 0;
  for (const ret of returns) {
    await runUnscoped(why, async () => {
      const original = await Transaction.findById(ret.returnOf.transactionId).select("outstandingAmount").lean();
      const credit = r2(ret.totalAmount);
      const take = original ? r2(Math.min(Math.max(Number(original.outstandingAmount) || 0, 0), credit)) : 0;
      const claimed = await Transaction.updateOne({ _id: ret._id, appliedToInvoice: { $exists: false } }, { $set: { appliedToInvoice: take } });
      if (!claimed.modifiedCount || !original) return;
      await Transaction.updateOne({ _id: original._id }, { $inc: { creditedAmount: credit, outstandingAmount: -take } });
      done += 1;
    });
  }
  return done;
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

/**
 * A voucher's number is unique within an organisation, and that index now counts only the vouchers that
 * still HOLD their number (models/modules/financial/financialModels.js `numberReleased`), so a number
 * handed back after a deletion can be given to the next voucher.
 *
 * A voucher written before that field existed does not match the index's partial filter at all, which
 * would leave it OUT of the index and take away the very uniqueness the index is there for. This puts
 * the flag on every one of them, then rebuilds the index: Mongoose only ever adds indexes, so the old
 * unconditional one has to be dropped here.
 *
 * Idempotent: the filter is the marker, so a second run matches nothing. Unscoped on purpose - it is a
 * repair across every organisation, and each row carries its own companyId.
 */
async function markVoucherNumbersHeld() {
  const { Voucher } = require("../models/modules/financial/financialModels");
  const why = "migration: mark every voucher as still holding its number, across every organisation";
  const r = await runUnscoped(why, () => Voucher.updateMany({ numberReleased: { $exists: false } }, { $set: { numberReleased: false } }));

  // Only when rows were actually migrated, which is once in a database's life. Rebuilding the index is
  // what DROPS the old unconditional one; the new partial one cannot be created while it is there,
  // because both are named for the same keys. A database that has no voucher without the flag either
  // never had the old index (a new organisation - Mongoose builds the partial one itself) or has
  // already been through this, so there is nothing to drop.
  //
  // It is deliberately NOT run on every boot: syncIndexes drops and recreates, and two processes doing
  // that to one collection at the same time - two instances starting together, or a test that syncs its
  // own indexes while the server starts - leave each other waiting, and the server never reports ready.
  if (r.modifiedCount) await Voucher.syncIndexes();
  return r.modifiedCount;
}

module.exports = { runMigrations, assignCoreToOriginalOrganisation, markVoucherNumbersHeld };
