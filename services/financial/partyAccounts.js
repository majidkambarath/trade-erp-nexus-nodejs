const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("./accountConfigService");
const AccountGroupService = require("./accountGroupService");
const AppError = require("../../utils/AppError");

// Every customer and vendor has ledger accounts of their own: what the customer owes us, what we
// owe the vendor, and the advances either side has paid ahead. This is the one place they are
// found or made, so invoices, receipts, payments and a newly created customer all end up with the
// same account, filed in the chart under the receivable / payable group with a code from that
// group (AR0001, AP0001...).
//
// Names are the lookup key ("Customer - <name>"), as they have always been, so the statement, the
// ageing and the older vouchers keep finding the same accounts.
const KINDS = {
  customer:        { prefix: "Customer - ",         type: "asset",     legacyCode: "CUST", groupKey: "account-receivable-group", text: (n) => `Receivables from ${n}` },
  vendor:          { prefix: "Vendor - ",           type: "liability", legacyCode: "VEND", groupKey: "account-payable-group",    text: (n) => `Payables to ${n}` },
  customerAdvance: { prefix: "Customer Advance - ", type: "liability", legacyCode: "CADV", groupKey: "account-payable-group",    text: (n) => `Advances from ${n}` },
  vendorAdvance:   { prefix: "Advance to Vendor - ", type: "asset",    legacyCode: "VADV", groupKey: "account-receivable-group", text: (n) => `Advances to ${n}` },
};
const SUBTYPE = { asset: "current_asset", liability: "current_liability" };
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const sessionOpt = (session) => (session ? { session } : {});

async function groupFor(key, session) {
  try {
    return await AccountConfigService.resolveGroup(key, { session });
  } catch (err) {
    if (err.code === "ACCOUNT_NOT_CONFIGURED") return null; // a company with no chart yet keeps the old behaviour
    throw err;
  }
}

async function ensurePartyAccount(kind, partyId, partyName, { session } = {}) {
  const k = KINDS[kind];
  if (!k) throw new AppError(`Unknown party account kind ${kind}`, 500);
  if (!mongoose.Types.ObjectId.isValid(partyId)) throw new AppError(`Invalid ${kind.replace("Advance", " advance")} ID`, 400);
  const accountName = `${k.prefix}${partyName}`;
  const legacyCode = `${k.legacyCode}${String(partyId).slice(-6)}`;

  let q = LedgerAccount.findOne({ $or: [{ accountName, accountType: k.type }, { accountCode: legacyCode }] });
  let account = await (session ? q.session(session) : q);
  const groupId = await groupFor(k.groupKey, session);

  if (!account) {
    const accountCode = groupId ? await AccountGroupService.generateNextAccountCode(groupId, { session }) : legacyCode;
    try {
      [account] = await LedgerAccount.create(
        [{
          accountCode, accountName, accountType: k.type, subType: SUBTYPE[k.type], groupId: groupId || undefined,
          allowDirectPosting: true, description: k.text(partyName), createdBy: SYSTEM_USER,
        }],
        sessionOpt(session)
      );
    } catch (err) {
      if (err.code !== 11000) throw err;
      q = LedgerAccount.findOne({ $or: [{ accountName }, { accountCode }, { accountCode: legacyCode }] });
      account = await (session ? q.session(session) : q);
      if (!account) throw err;
    }
  } else if (!account.groupId && groupId) {
    // made before groups existed: file it, keep its code
    await LedgerAccount.updateOne({ _id: account._id }, { groupId }, sessionOpt(session));
    account.groupId = groupId;
  }
  return account;
}

// A party was renamed: its accounts follow, so the name lookups above still find them.
async function renamePartyAccounts(partyType, oldName, newName, { session } = {}) {
  if (!oldName || !newName || oldName === newName) return 0;
  const kinds = partyType === "Vendor" ? ["vendor", "vendorAdvance"] : ["customer", "customerAdvance"];
  let renamed = 0;
  for (const kind of kinds) {
    const k = KINDS[kind];
    const clash = await LedgerAccount.exists({ accountName: `${k.prefix}${newName}` });
    if (clash) continue; // never merge two parties' accounts by renaming
    const r = await LedgerAccount.updateOne(
      { accountName: `${k.prefix}${oldName}`, accountType: k.type },
      { accountName: `${k.prefix}${newName}`, description: k.text(newName) },
      sessionOpt(session)
    );
    renamed += r.modifiedCount;
  }
  return renamed;
}

// Every customer and vendor gets its main account if it lacks one (advance accounts stay on demand,
// they are only needed once an advance is taken).
async function backfillPartyAccounts() {
  const Customer = mongoose.model("Customer");
  const Vendor = mongoose.model("Vendor");
  const [customers, vendors] = await Promise.all([
    Customer.find({}).select("customerName").lean(),
    Vendor.find({}).select("vendorName").lean(),
  ]);
  const have = new Set(
    (await LedgerAccount.find({ accountName: /^(Customer|Vendor) - / }).select("accountName").lean()).map((a) => a.accountName)
  );
  let created = 0;
  for (const c of customers) {
    if (c.customerName && !have.has(`Customer - ${c.customerName}`)) { await ensurePartyAccount("customer", c._id, c.customerName); created += 1; }
  }
  for (const v of vendors) {
    if (v.vendorName && !have.has(`Vendor - ${v.vendorName}`)) { await ensurePartyAccount("vendor", v._id, v.vendorName); created += 1; }
  }
  return created;
}

// --- hooks used by the customer and vendor services -------------------------------------------
// Creating, renaming or deleting a party keeps its ledger accounts in step. These never fail the
// party operation: an account that could not be made now is made when the first document needs it
// (or by the backfill when the chart is opened).
const kindOf = (partyType) => (partyType === "Vendor" ? "vendor" : "customer");

async function onPartyCreated(partyType, party) {
  try {
    const name = partyType === "Vendor" ? party.vendorName : party.customerName;
    if (name) await ensurePartyAccount(kindOf(partyType), party._id, name);
  } catch (err) {
    console.error(`[party-account] could not create the account for ${partyType}:`, err.message);
  }
}

async function onPartyRenamed(partyType, oldName, newName) {
  try {
    await renamePartyAccounts(partyType, oldName, newName);
  } catch (err) {
    console.error(`[party-account] could not rename the account of ${partyType}:`, err.message);
  }
}

// An account that has never been posted to is switched off with the party; one with history stays
// (it is part of the books), just no longer offered for new postings.
async function onPartyDeleted(partyType, name) {
  try {
    for (const kind of partyType === "Vendor" ? ["vendor", "vendorAdvance"] : ["customer", "customerAdvance"]) {
      const acc = await LedgerAccount.findOne({ accountName: `${KINDS[kind].prefix}${name}`, accountType: KINDS[kind].type }).select("_id").lean();
      if (acc && !(await LedgerEntry.exists({ accountId: acc._id }))) await LedgerAccount.updateOne({ _id: acc._id }, { isActive: false });
    }
  } catch (err) {
    console.error(`[party-account] could not retire the account of ${partyType}:`, err.message);
  }
}

module.exports = { onPartyCreated, onPartyRenamed, onPartyDeleted, ensurePartyAccount, renamePartyAccounts, backfillPartyAccounts, KINDS };
