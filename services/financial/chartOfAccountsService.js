const mongoose = require("mongoose");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountGroupService = require("./accountGroupService");
const AccountConfigService = require("./accountConfigService");
const FinancialService = require("./financialService");
const FiscalYearService = require("../core/fiscalYearService");
const BankMasterService = require("../banking/bankMasterService");
const { BankMaster } = require("../../models/modules/banking/bankingModels");
const AppError = require("../../utils/AppError");
const { naturalBalance, round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

const SUBTYPE = {
  ASSET: "current_asset",
  LIABILITY: "current_liability",
  EQUITY: "retained_earnings",
  INCOME: "other_income",
  EXPENSE: "operating_expense",
};
const CATEGORY_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdmin = (v) => (mongoose.isValidObjectId(v) ? v : SYSTEM_USER);

class ChartOfAccountsService {
  // Natural balance of every account from the ledger (the same source as the Trial Balance, so
  // the chart and the report can never disagree).
  static async balances(asOf) {
    const match = { isReversed: { $ne: true } };
    if (asOf) match.date = { $lte: new Date(asOf) };
    const rows = await LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: "$accountId", debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" }, entries: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  // Every account a voucher may post to, flat and light (no balances): what the account pickers on
  // the voucher forms need. `path` is the group trail, e.g. "Current Assets > Bank".
  static async listPostable(req) {
    const { companyId } = getTenant(req);
    const [groups, accounts] = await Promise.all([
      AccountGroup.find({ companyId }).select("name parentGroup category").lean(),
      LedgerAccount.find({ isActive: { $ne: false }, allowDirectPosting: { $ne: false } })
        .select("accountCode accountName accountType groupId")
        .sort({ accountCode: 1, accountName: 1 })
        .lean(),
    ]);
    const byId = new Map(groups.map((g) => [String(g._id), g]));
    const pathOf = (groupId) => {
      const trail = [];
      for (let g = byId.get(String(groupId)); g; g = g.parentGroup && byId.get(String(g.parentGroup))) trail.unshift(g.name);
      return trail;
    };
    return accounts.map((a) => {
      const trail = pathOf(a.groupId);
      return {
        _id: a._id, accountCode: a.accountCode, accountName: a.accountName, category: (a.accountType || "asset").toUpperCase(),
        groupId: a.groupId || null, groupName: trail[trail.length - 1] || "", path: trail.join(" › "),
      };
    });
  }

  // The whole chart: category -> nested groups -> accounts, with balances rolled up.
  static async getChart(req, { asOf } = {}) {
    const { companyId } = getTenant(req);
    const [groups, accounts, bal, settings] = await Promise.all([
      AccountGroup.find({ companyId }).sort({ name: 1 }).lean(),
      LedgerAccount.find({}).sort({ accountCode: 1, accountName: 1 }).lean(),
      this.balances(asOf),
      CompanySettings.findOne({ companyId }).select("accountConfiguration").lean(),
    ]);

    // Accounts referenced by the posting map are protected from deactivation.
    const mapped = new Set(
      (settings?.accountConfiguration || []).filter((c) => c.targetAccount).map((c) => String(c.targetAccount))
    );

    const banks = new Map((await BankMaster.find({ companyId }).select("bankName bankCode").lean()).map((x) => [String(x._id), x]));
    const shape = (a, category) => {
      const b = bal.get(String(a._id));
      return {
        bank: a.bank && (a.bank.bankId || a.bank.accountNumber || a.bank.iban) ? BankMasterService.describeAccountBank(a.bank, banks) : null,
        _id: a._id,
        accountCode: a.accountCode,
        accountName: a.accountName,
        description: a.description || "",
        isActive: a.isActive !== false,
        isSystemAccount: Boolean(a.isSystemAccount),
        allowDirectPosting: a.allowDirectPosting !== false,
        isMapped: mapped.has(String(a._id)),
        hasEntries: Boolean(b?.entries),
        documents: (a.documents || []).length,
        balance: round2(naturalBalance(category, b?.debit || 0, b?.credit || 0)),
        // debit minus credit: positive is a debit balance, negative a credit balance. The screens
        // show it as "1,250.00 Dr" / "300.00 Cr", whatever the account's normal side is.
        net: round2((b?.debit || 0) - (b?.credit || 0)),
      };
    };

    const byGroup = new Map();
    const ungrouped = [];
    for (const a of accounts) {
      const category = (a.accountType || "asset").toUpperCase();
      if (a.groupId) {
        const k = String(a.groupId);
        if (!byGroup.has(k)) byGroup.set(k, []);
        byGroup.get(k).push(shape(a, category));
      } else {
        ungrouped.push({ ...shape(a, category), category });
      }
    }

    const roles = AccountConfigService.resolveGroupRoles(settings?.accountConfiguration, groups);
    const node = (g) => ({
      _id: g._id, name: g.name, prefix: g.prefix, category: g.category, isActive: g.isActive, role: roles.get(String(g._id)) || "other",
      parentGroup: g.parentGroup, accounts: byGroup.get(String(g._id)) || [], children: [], total: 0, net: 0,
    });
    const nodes = new Map(groups.map((g) => [String(g._id), node(g)]));
    const roots = [];
    for (const n of nodes.values()) {
      const parent = n.parentGroup && nodes.get(String(n.parentGroup));
      (parent ? parent.children : roots).push(n);
    }
    const roll = (n) => {
      const kids = n.children.map((c) => [roll(c), c.net]);
      n.total = round2(n.accounts.reduce((t, a) => t + a.balance, 0) + kids.reduce((t, [total]) => t + total, 0));
      n.net = round2(n.accounts.reduce((t, a) => t + a.net, 0) + kids.reduce((t, [, net]) => t + net, 0));
      return n.total;
    };
    roots.forEach(roll);

    return {
      categories: CATEGORY_ORDER.map((category) => {
        const gs = roots.filter((r) => r.category === category);
        const loose = ungrouped.filter((a) => a.category === category);
        return {
          category,
          total: round2(gs.reduce((t, g) => t + g.total, 0) + loose.reduce((t, a) => t + a.balance, 0)),
          net: round2(gs.reduce((t, g) => t + g.net, 0) + loose.reduce((t, a) => t + a.net, 0)),
          groups: gs,
          ungrouped: loose,
        };
      }),
      counts: { groups: groups.length, accounts: accounts.length, ungrouped: ungrouped.length },
    };
  }

  static async createAccount(data, req, adminId) {
    const { companyId } = getTenant(req);
    const name = String(data.accountName || "").trim();
    if (!name) throw new AppError("Account name is required", 400, "NAME_REQUIRED");
    const group = await AccountGroup.findOne({ _id: data.groupId, companyId });
    if (!group) throw new AppError("Choose an account group", 400, "GROUP_REQUIRED");

    const dup = await LedgerAccount.findOne({
      accountName: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      isActive: true,
    }).lean();
    if (dup) throw new AppError(`An account named "${dup.accountName}" already exists`, 409, "DUPLICATE_ACCOUNT");

    const bank = await BankMasterService.cleanAccountBank(data.bank, req);
    const opening = round2(Number(data.openingBalance) || 0);
    if (opening < 0) throw new AppError("Opening balance cannot be negative; use the debit/credit side", 400);
    if (opening > 0 && !["debit", "credit"].includes(data.openingSide)) {
      throw new AppError("Say whether the opening balance is a debit or a credit", 400, "OPENING_SIDE_REQUIRED");
    }
    const openingDate = data.openingDate ? new Date(data.openingDate) : new Date();

    const session = await mongoose.startSession();
    try {
      let account;
      await session.withTransaction(async () => {
        if (opening > 0) await FiscalYearService.assertPostingAllowed(openingDate, { session });
        const accountCode = await AccountGroupService.generateNextAccountCode(group._id, { session });
        [account] = await LedgerAccount.create(
          [{
            accountCode,
            accountName: name,
            accountType: group.category.toLowerCase(),
            subType: SUBTYPE[group.category],
            groupId: group._id,
            description: data.description?.trim() || undefined,
            allowDirectPosting: data.allowDirectPosting !== false,
            ...(bank ? { bank } : {}),
            openingBalance: opening,
            openingSide: opening > 0 ? data.openingSide : null,
            createdBy: asAdmin(adminId),
          }],
          { session }
        );
        if (opening > 0) await this.postOpening(account, { opening, side: data.openingSide, date: openingDate, adminId, session });
      });
      return account.toObject();
    } finally {
      await session.endSession();
    }
  }

  // The opening balance enters the ledger as a dated entry against Opening Balance Equity, so it
  // shows in the Trial Balance and statements. While ledger posting is off it is only stored.
  static async postOpening(account, { opening, side, date, adminId, session }) {
    if (!(await AccountConfigService.isPostingEnabled({ session }))) {
      const cat = account.accountType.toUpperCase();
      account.currentBalance = naturalBalance(cat, side === "debit" ? opening : 0, side === "credit" ? opening : 0);
      await account.save({ session });
      return;
    }
    const equityId = await AccountConfigService.resolveAccount("opening-balance-equity", { session });
    const equity = await LedgerAccount.findById(equityId).select("accountName accountCode").session(session).lean();
    const base = {
      voucherId: account._id, voucherNo: `OB-${account.accountCode}`, voucherType: "opening",
      date, narration: `Opening balance - ${account.accountName}`, referenceType: "opening",
      referenceId: account._id, referenceNo: account.accountCode, createdBy: asAdmin(adminId),
    };
    const docs = [
      { ...base, accountId: account._id, accountName: account.accountName, accountCode: account.accountCode,
        debitAmount: side === "debit" ? opening : 0, creditAmount: side === "credit" ? opening : 0 },
      { ...base, accountId: equityId, accountName: equity.accountName, accountCode: equity.accountCode,
        debitAmount: side === "credit" ? opening : 0, creditAmount: side === "debit" ? opening : 0 },
    ];
    await LedgerEntry.insertMany(docs, { session });
    await FinancialService.updateAccountBalances(docs, session);
  }

  // An account created while ledger posting was off keeps its opening balance only as a stored figure.
  // Once posting is on it gets its dated entry too, so the Trial Balance and statements agree with the
  // chart. Safe to run again: an account that already has its opening entry is left alone.
  static async postStoredOpenings({ adminId } = {}) {
    const result = { posted: 0, failed: [] };
    if (!(await AccountConfigService.isPostingEnabled())) return result;
    const stored = await LedgerAccount.find({ openingBalance: { $gt: 0 }, openingSide: { $in: ["debit", "credit"] } }).select("_id").lean();
    for (const { _id } of stored) {
      if (await LedgerEntry.exists({ voucherType: "opening", voucherId: _id })) continue;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const account = await LedgerAccount.findById(_id).session(session);
          const { openingBalance: opening, openingSide: side } = account;
          const date = account.createdAt || new Date();
          await FiscalYearService.assertPostingAllowed(date, { session });
          // the stored figure was the whole balance so far; posting the entry adds it again
          const storedNet = naturalBalance(account.accountType.toUpperCase(), side === "debit" ? opening : 0, side === "credit" ? opening : 0);
          account.currentBalance = round2((account.currentBalance || 0) - storedNet);
          await account.save({ session });
          await this.postOpening(account, { opening, side, date, adminId, session });
        });
        result.posted += 1;
      } catch (err) {
        result.failed.push({ accountCode: _id.toString(), reason: err.message });
      } finally {
        await session.endSession();
      }
    }
    return result;
  }

  static async updateAccount(id, data, req) {
    const { companyId } = getTenant(req);
    const account = await LedgerAccount.findById(id);
    if (!account) throw new AppError("Account not found", 404);
    const bal = (await this.balances()).get(String(id));
    const used = Boolean(bal?.entries);

    if (data.groupId && String(data.groupId) !== String(account.groupId)) {
      const group = await AccountGroup.findOne({ _id: data.groupId, companyId });
      if (!group) throw new AppError("Account group not found", 400);
      // Moving a used account to another category would change the meaning of its history.
      if (used && group.category.toLowerCase() !== account.accountType) {
        throw new AppError("An account with postings cannot move to another category", 409, "CATEGORY_LOCKED");
      }
      account.groupId = group._id;
      account.accountType = group.category.toLowerCase();
      account.subType = SUBTYPE[group.category];
    }
    if (data.accountName !== undefined) {
      const name = String(data.accountName).trim();
      if (!name) throw new AppError("Account name is required", 400);
      account.accountName = name;
    }
    if (data.description !== undefined) account.description = data.description;
    if (data.bank !== undefined) {
      const cleaned = await BankMasterService.cleanAccountBank(data.bank, req);
      account.bank = cleaned || { bankId: null, branchCode: "", accountNumber: "", iban: "", accountHolder: "" };
    }
    if (data.allowDirectPosting !== undefined) account.allowDirectPosting = Boolean(data.allowDirectPosting);

    if (data.isActive === false && account.isActive !== false) {
      const settings = await CompanySettings.findOne({ companyId }).select("accountConfiguration").lean();
      if ((settings?.accountConfiguration || []).some((c) => String(c.targetAccount) === String(id))) {
        throw new AppError("This account is used by the posting configuration; remap it first", 409, "ACCOUNT_IN_USE_BY_CONFIGURATION");
      }
      if (Math.abs(naturalBalance(account.accountType.toUpperCase(), bal?.debit || 0, bal?.credit || 0)) >= 0.005) {
        throw new AppError("An account with a balance cannot be deactivated", 409, "ACCOUNT_HAS_BALANCE");
      }
    }
    if (data.isActive !== undefined) account.isActive = Boolean(data.isActive);

    await account.save();
    return account.toObject();
  }

  // One account's ledger: opening balance, every entry with a running balance, closing balance.
  static async getLedger(id, { from, to } = {}) {
    const account = await LedgerAccount.findById(id).lean();
    if (!account) throw new AppError("Account not found", 404);
    const cat = (account.accountType || "asset").toUpperCase();
    const acc = new mongoose.Types.ObjectId(id);
    const live = { accountId: acc, isReversed: { $ne: true } };

    let openingDr = 0, openingCr = 0;
    if (from) {
      const [o] = await LedgerEntry.aggregate([
        { $match: { ...live, date: { $lt: new Date(from) } } },
        { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
      ]);
      openingDr = o?.d || 0;
      openingCr = o?.c || 0;
    }
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    const entries = await LedgerEntry.find({ ...live, ...(from || to ? { date: range } : {}) })
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean();

    let running = naturalBalance(cat, openingDr, openingCr);
    let net = round2(openingDr - openingCr); // debit minus credit, so the side can be shown as Dr / Cr
    const opening = round2(running);
    const openingNet = net;
    const rows = entries.map((e) => {
      running += naturalBalance(cat, e.debitAmount, e.creditAmount);
      net = round2(net + e.debitAmount - e.creditAmount);
      return {
        // voucherId is the source document: the ledger screen drills into its audit trail
        _id: e._id, date: e.date, voucherId: e.voucherId, voucherNo: e.voucherNo, voucherType: e.voucherType,
        narration: e.narration, debit: e.debitAmount, credit: e.creditAmount, balance: round2(running), net,
      };
    });
    return {
      account: { _id: account._id, accountCode: account.accountCode, accountName: account.accountName, category: cat },
      opening, openingNet, rows, closing: round2(running), closingNet: net,
      totals: { debit: round2(entries.reduce((t, e) => t + e.debitAmount, 0)), credit: round2(entries.reduce((t, e) => t + e.creditAmount, 0)) },
    };
  }
}

module.exports = ChartOfAccountsService;
