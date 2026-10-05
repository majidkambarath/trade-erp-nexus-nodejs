const mongoose = require("mongoose");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AccountGroupService = require("./accountGroupService");
const AccountConfigService = require("./accountConfigService");
const TaxCodeService = require("./taxCodeService");
const PostingService = require("./postingService");
const AuditService = require("../core/auditService");
const { backfillPartyAccounts } = require("./partyAccounts");
const { GROUPS, ACCOUNTS, GROUP_FOR_KEY } = require("../../utils/defaultChart");
const { getTenant } = require("../../utils/tenant");

const SUBTYPE = {
  ASSET: "current_asset", LIABILITY: "current_liability", EQUITY: "retained_earnings",
  INCOME: "other_income", EXPENSE: "operating_expense",
};
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");

// Creates the default chart of accounts, maps the posting configuration onto it and adds the
// standard tax codes. Idempotent: anything that already exists (matched by name) is left exactly
// as the company has it, so it can be run again to restore a deleted default.
//
// It deliberately does NOT create a fiscal year (that starts restricting which dates may be
// posted) and does NOT switch ledger posting on. Both are decisions for the company.
class DefaultChartService {
  static async provision(req) {
    const { companyId } = getTenant(req);
    const created = { groups: 0, accounts: 0, mapped: 0, taxCodes: 0 };

    // Groups: look up what exists in one query, create the missing ones in one insert (their ids are
    // made up front so a child can name its parent).
    const groups = {};
    for (const g of await AccountGroup.find({ companyId })) groups[g.name] = g;
    const newGroups = [];
    for (const [name, prefix, category, parentName] of GROUPS) {
      if (groups[name]) continue;
      const doc = { _id: new mongoose.Types.ObjectId(), companyId, name, prefix, category, parentGroup: parentName ? groups[parentName]._id : null };
      groups[name] = doc;
      newGroups.push(doc);
    }
    if (newGroups.length) {
      await AccountGroup.insertMany(newGroups);
      created.groups = newGroups.length;
    }

    // Accounts: the same, with each group's new codes reserved together.
    const existing = await LedgerAccount.find({ accountName: { $in: ACCOUNTS.map((a) => a[0]) } });
    const accountByKey = {};
    const missing = []; // [accountName, group, configKey]
    for (const [accountName, groupName, configKey] of ACCOUNTS) {
      const group = groups[groupName];
      let acc = existing.find((a) => a.accountName === accountName && String(a.groupId) === String(group._id));
      if (!acc) {
        // An account with this name may already exist outside a group (created before groups).
        acc = existing.find((a) => a.accountName === accountName && !a.groupId);
        if (acc) {
          acc.groupId = group._id;
          await acc.save();
        }
      }
      if (acc) {
        if (configKey) accountByKey[configKey] = acc;
      } else {
        missing.push([accountName, group, configKey]);
      }
    }
    const perGroup = new Map();
    for (const m of missing) perGroup.set(String(m[1]._id), [...(perGroup.get(String(m[1]._id)) || []), m]);
    // each group has its own counter, so the groups can reserve their codes at the same time
    const docs = (
      await Promise.all(
        [...perGroup.values()].map(async (items) => {
          const codes = await AccountGroupService.reserveAccountCodes(items[0][1]._id, items.length);
          return items.map(([accountName, group, configKey], i) => ({
            _id: new mongoose.Types.ObjectId(), accountName, accountCode: codes[i], accountType: group.category.toLowerCase(),
            subType: SUBTYPE[group.category], groupId: group._id, isSystemAccount: true, createdBy: SYSTEM_USER, configKey,
          }));
        })
      )
    ).flat();
    if (docs.length) {
      const inserted = await LedgerAccount.insertMany(docs.map(({ configKey, ...d }) => d));
      created.accounts = inserted.length;
      for (const d of docs) if (d.configKey) accountByKey[d.configKey] = inserted.find((x) => String(x._id) === String(d._id));
    }

    await AccountConfigService.ensureSettings(companyId);
    const settings = await CompanySettings.findOne({ companyId });
    for (const entry of settings.accountConfiguration) {
      if (entry.targetKind === "group" && !entry.targetGroup && GROUP_FOR_KEY[entry.configKey]) {
        entry.targetGroup = groups[GROUP_FOR_KEY[entry.configKey]]._id;
        created.mapped += 1;
      }
      if (entry.targetKind === "account" && !entry.targetAccount && accountByKey[entry.configKey]) {
        entry.targetAccount = accountByKey[entry.configKey]._id;
        created.mapped += 1;
      }
    }
    await settings.save();

    created.taxCodes = await TaxCodeService.ensureStarter(companyId);
    return created;
  }

  // onOpen, but not more than once a minute per server process: it is a safety net, not something to
  // pay for on every request.
  static async onOpenThrottled(req) {
    // A page that fires several requests at once must not let the later ones read before the first
    // has finished: callers that arrive while a run is in flight wait for that same run.
    if (this._opening) return this._opening;
    if (Date.now() - (this._lastOpen || 0) < 60_000) return null;
    // The minute only starts once the company's posting choice is settled: a run before the chart
    // exists (the one at server start on a new database) must not hold off the first real open.
    this._opening = this.onOpen(req)
      .then((out) => {
        if (out.settled) this._lastOpen = Date.now();
        return out;
      })
      .finally(() => {
        this._opening = null;
      });
    return this._opening;
  }

  // Run whenever the chart is opened. A company's customers and vendors each get their ledger
  // account (so they show under Receivable / Payable from the start), and a company that has never
  // chosen otherwise has ledger posting switched on once every account is mapped, with the
  // documents approved so far posted. Returns what it did, for the caller to report.
  static async onOpen(req) {
    const out = { partyAccounts: 0, postingEnabled: false, catchUp: null, settled: false };
    out.partyAccounts = await backfillPartyAccounts();

    const { companyId } = getTenant(req);
    const settings = await CompanySettings.findOne({ companyId }).select("ledgerPostingEnabled ledgerPostingTouched").lean();
    if (settings && !settings.ledgerPostingEnabled && !settings.ledgerPostingTouched) {
      let readiness = await AccountConfigService.getReadiness(req);
      if (readiness.missing.length) {
        // posting keys added since this company's chart was made (cheques, cards...) are mapped
        // onto the defaults, never over a mapping the company already chose
        await this.provision(req);
        readiness = await AccountConfigService.getReadiness(req);
      }
      if (!readiness.missing.length) {
        await AccountConfigService.setPostingEnabled(true, req, { auto: true });
        out.postingEnabled = true;
      }
    }
    // only when posting has just been switched on: earlier documents get their entries once
    if (out.postingEnabled) {
      out.catchUp = await PostingService.catchUp();
      // switched on by the system, not by a person: the audit log says so
      const done = out.catchUp;
      await AuditService.log({
        req, action: "LEDGER_POSTING_ENABLED", entity: "CompanySettings",
        summary: `Switched on automatically once every posting account was mapped; ${done.posted} earlier document(s) and ${done.openingsPosted || 0} opening balance(s) posted${done.failed.length ? `, ${done.failed.length} could not be` : ""}`,
      });
    }
    // settled: the company has a posting choice (on, or deliberately off), so there is nothing left to wait for
    out.settled = Boolean(out.postingEnabled || (settings && (settings.ledgerPostingEnabled || settings.ledgerPostingTouched)));
    return out;
  }

  // Called when the chart is first opened: a company with no groups at all gets the defaults, so
  // the screen is never an empty page. Two first requests at once race on the unique indexes; the
  // loser just reads what the winner created.
  static async ensure(req) {
    const { companyId } = getTenant(req);
    if (await AccountGroup.exists({ companyId })) return null;
    try {
      return await this.provision(req);
    } catch (err) {
      if (err?.code === 11000) return null;
      throw err;
    }
  }
}

module.exports = DefaultChartService;
