const mongoose = require("mongoose");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("./accountConfigService");
const ChartOfAccountsService = require("./chartOfAccountsService");
const FiscalYearService = require("../core/fiscalYearService");
const CustomerService = require("../customer/customerService");
const VendorService = require("../vendor/vendorService");
const { KINDS } = require("./partyAccounts");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

// The account form for a Receivable / Payable group is a customer / vendor form: creating one
// creates the party through the same customer / vendor service every other screen uses (so all its
// rules and the party-account hook run) and files its ledger account in the CHOSEN group, which may
// be a sub-group of Receivables / Payables, with a code from that group.
const ROLE_KIND = { receivable: "customer", payable: "vendor" };
const MODEL = { customer: "Customer", vendor: "Vendor" };
const NAME_FIELD = { customer: "customerName", vendor: "vendorName" };
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class PartyAccountService {
  // The group and the kind of party it holds ("customer" for a receivable group, "vendor" for payable).
  static async groupKind(groupId, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(groupId)) throw new AppError("Choose an account group", 400, "GROUP_REQUIRED");
    const group = await AccountGroup.findOne({ _id: groupId, companyId }).lean();
    if (!group) throw new AppError("Choose an account group", 400, "GROUP_REQUIRED");
    const role = await AccountConfigService.roleOfGroup(group._id, { companyId });
    return { group, role, kind: ROLE_KIND[role] || null };
  }

  static async assertNameFree(accountName, exceptId) {
    const dup = await LedgerAccount.findOne({
      accountName: new RegExp(`^${escapeRe(accountName)}$`, "i"),
      isActive: true,
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    }).lean();
    if (dup) throw new AppError(`An account named "${dup.accountName}" already exists`, 409, "DUPLICATE_ACCOUNT");
  }

  // data: { groupId, party: {customerName | vendorName, ...customer / vendor fields}, description?,
  //         allowDirectPosting?, openingBalance?, openingSide?, openingDate? }
  static async create(data, req, adminId) {
    const { group, kind } = await this.groupKind(data.groupId, req);
    if (!kind) {
      throw new AppError("Customer and vendor details belong to a Receivable or Payable group. Choose one of those groups.", 400, "PARTY_GROUP_REQUIRED");
    }
    const k = KINDS[kind];
    const party = { ...(data.party || {}) };
    const name = String(party[NAME_FIELD[kind]] ?? "").trim();
    if (!name) throw new AppError(`${kind === "customer" ? "Customer" : "Vendor"} name is required`, 400, "NAME_REQUIRED");
    party[NAME_FIELD[kind]] = name;
    const accountName = `${k.prefix}${name}`;
    await this.assertNameFree(accountName);

    const opening = round2(Number(data.openingBalance) || 0);
    if (opening < 0) throw new AppError("Opening balance cannot be negative; use the debit/credit side", 400);
    if (opening > 0 && !["debit", "credit"].includes(data.openingSide)) {
      throw new AppError("Say whether the opening balance is a debit or a credit", 400, "OPENING_SIDE_REQUIRED");
    }
    const openingDate = data.openingDate ? new Date(data.openingDate) : new Date();
    if (opening > 0) {
      // refuse before the party exists, so a closed period or an unmapped equity account leaves nothing behind
      await FiscalYearService.assertPostingAllowed(openingDate);
      if (await AccountConfigService.isPostingEnabled()) await AccountConfigService.resolveAccount("opening-balance-equity");
    }

    const created = kind === "customer"
      ? await CustomerService.createCustomer(party, { groupId: group._id })
      : await VendorService.createVendor(party, { groupId: group._id });
    let account = await LedgerAccount.findOne({ accountName, accountType: k.type });
    try {
      if (!account) throw new AppError("The account could not be created", 500, "ACCOUNT_NOT_CREATED");
      const set = {};
      if (data.description?.trim()) set.description = data.description.trim();
      if (data.allowDirectPosting === false) set.allowDirectPosting = false;
      if (Object.keys(set).length) await LedgerAccount.updateOne({ _id: account._id }, set);

      if (opening > 0) {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const acc = await LedgerAccount.findById(account._id).session(session);
            acc.openingBalance = opening;
            acc.openingSide = data.openingSide;
            await acc.save({ session });
            await ChartOfAccountsService.postOpening(acc, { opening, side: data.openingSide, date: openingDate, adminId, session });
          });
        } finally {
          await session.endSession();
        }
      }
      account = await LedgerAccount.findById(account._id).lean();
    } catch (err) {
      await this.rollback(kind, created, account);
      throw err;
    }
    return { account, party: created };
  }

  // Undo a half-made party: remove it, and its account when nothing was posted to it.
  static async rollback(kind, party, account) {
    try {
      if (kind === "customer") await CustomerService.deleteCustomer(party._id);
      else await VendorService.deleteVendor(party._id);
      if (account && !(await LedgerEntry.exists({ accountId: account._id }))) await LedgerAccount.deleteOne({ _id: account._id });
    } catch (err) {
      console.error("[party-account] could not roll back a half-made party:", err.message);
    }
  }

  // The customer / vendor behind an account: { kind, party } - kind is null when the account's group
  // is not a Receivable / Payable one, party is null when the account is not a party account
  // (an advance account, or one made by hand in the group).
  static async partyOf(accountId, req) {
    if (!mongoose.isValidObjectId(accountId)) throw new AppError("Account not found", 404);
    const account = await LedgerAccount.findById(accountId).lean();
    if (!account) throw new AppError("Account not found", 404);
    const role = await AccountConfigService.roleOfGroup(account.groupId, { companyId: getTenant(req).companyId });
    const kind = ROLE_KIND[role] || null;
    if (!kind) return { account, kind: null, party: null };
    const prefix = KINDS[kind].prefix;
    if (!account.accountName.startsWith(prefix)) return { account, kind, party: null };
    const party = await mongoose
      .model(MODEL[kind])
      .findOne({ [NAME_FIELD[kind]]: account.accountName.slice(prefix.length) })
      .sort({ createdAt: 1 });
    return { account, kind, party };
  }

  static async get(accountId, req) {
    const { kind, party } = await this.partyOf(accountId, req);
    return { kind, party };
  }

  // data: { party: {...fields to change}, groupId?, description?, allowDirectPosting?, isActive? }.
  // The party is saved first (a new name renames its accounts), then the account's own settings.
  static async update(accountId, data, req) {
    const { account, kind, party } = await this.partyOf(accountId, req);
    if (!party) throw new AppError("This account has no customer or vendor record behind it", 404, "PARTY_NOT_FOUND");

    const wasRole = Object.keys(ROLE_KIND).find((r) => ROLE_KIND[r] === kind);
    if (data.groupId && String(data.groupId) !== String(account.groupId)) {
      const target = await this.groupKind(data.groupId, req);
      if (target.kind !== kind) {
        throw new AppError(`A ${wasRole} account can only move to another ${wasRole} group`, 409, "PARTY_GROUP_MISMATCH");
      }
    }

    const fields = { ...(data.party || {}) };
    const nameField = NAME_FIELD[kind];
    if (fields[nameField] !== undefined) {
      const name = String(fields[nameField]).trim();
      if (!name) throw new AppError(`${kind === "customer" ? "Customer" : "Vendor"} name is required`, 400, "NAME_REQUIRED");
      fields[nameField] = name;
      if (name !== party[nameField]) await this.assertNameFree(`${KINDS[kind].prefix}${name}`, account._id);
    }
    const saved = Object.keys(fields).length
      ? kind === "customer" ? await CustomerService.updateCustomer(party._id, fields) : await VendorService.updateVendor(party._id, fields)
      : party;

    const accountPatch = {};
    for (const key of ["groupId", "description", "allowDirectPosting", "isActive"]) if (data[key] !== undefined) accountPatch[key] = data[key];
    const updated = Object.keys(accountPatch).length ? await ChartOfAccountsService.updateAccount(accountId, accountPatch, req) : account;
    return { account: updated, party: saved };
  }
}

module.exports = PartyAccountService;
