const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const { SEED } = require("../../utils/accountConfigSeed");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

// Merge the canonical seed into a company's stored configuration. The seed owns a key's shape;
// the company owns its chosen target. Matching is by configKey only.
function mergeSeed(stored) {
  const byKey = new Map(stored.map((c) => [c.configKey, c]));
  return SEED.map((s) => {
    const existing = byKey.get(s.configKey);
    return {
      ...s,
      targetGroup: existing?.targetGroup ?? null,
      targetAccount: existing?.targetAccount ?? null,
      isActive: existing?.isActive ?? true,
    };
  });
}

class AccountConfigService {
  static async ensureSettings(companyId) {
    let settings = await CompanySettings.findOne({ companyId });
    if (!settings) settings = new CompanySettings({ companyId, accountConfiguration: [] });
    const merged = mergeSeed(settings.accountConfiguration.map((c) => c.toObject?.() ?? c));
    settings.accountConfiguration = merged;
    await settings.save();
    return settings;
  }

  static async getConfiguration(req) {
    const { companyId } = getTenant(req);
    const settings = await this.ensureSettings(companyId);
    const populated = await CompanySettings.findById(settings._id)
      .populate("accountConfiguration.targetGroup", "name prefix category")
      .populate("accountConfiguration.targetAccount", "accountName accountCode accountType")
      .lean();
    return {
      accountConfiguration: populated.accountConfiguration,
      fiscalYearStartMonth: populated.fiscalYearStartMonth,
      ledgerPostingEnabled: Boolean(populated.ledgerPostingEnabled),
    };
  }

  // mappings: [{ configKey, targetGroup?, targetAccount? }]. null/absent clears the mapping.
  static async updateMappings(mappings, req) {
    const { companyId } = getTenant(req);
    if (!Array.isArray(mappings)) throw new AppError("mappings must be an array", 400);
    const settings = await this.ensureSettings(companyId);
    const byKey = new Map(settings.accountConfiguration.map((c) => [c.configKey, c]));

    for (const m of mappings) {
      const entry = byKey.get(m.configKey);
      if (!entry) throw new AppError(`Unknown configuration key: ${m.configKey}`, 400, "UNKNOWN_CONFIG_KEY");
      if (entry.targetKind === "none") {
        throw new AppError(`${m.configKey} takes no mapping`, 400, "NOT_MAPPABLE");
      }

      if (entry.targetKind === "group") {
        if (!m.targetGroup) {
          entry.targetGroup = null;
          continue;
        }
        const group = await AccountGroup.findOne({ _id: m.targetGroup, companyId }).lean();
        if (!group) throw new AppError(`Account group not found for ${m.configKey}`, 400, "TARGET_NOT_FOUND");
        // The picker is filtered by the seed's category; enforce the same rule server-side.
        if (entry.accountCategory && group.category !== entry.accountCategory) {
          throw new AppError(
            `${m.configKey} needs a ${entry.accountCategory} group, got ${group.category}`,
            400,
            "CATEGORY_MISMATCH"
          );
        }
        entry.targetGroup = group._id;
      } else {
        if (!m.targetAccount) {
          entry.targetAccount = null;
          continue;
        }
        const account = await LedgerAccount.findById(m.targetAccount).lean();
        if (!account || !account.isActive) {
          throw new AppError(`Ledger account not found for ${m.configKey}`, 400, "TARGET_NOT_FOUND");
        }
        const want = entry.accountCategory?.toLowerCase();
        if (want && account.accountType !== want) {
          throw new AppError(
            `${m.configKey} needs a ${want} account, got ${account.accountType}`,
            400,
            "CATEGORY_MISMATCH"
          );
        }
        entry.targetAccount = account._id;
      }
    }

    await settings.save();
    return this.getConfiguration(req);
  }

  // The ledger account a business event posts to. Throws when unmapped: a missing mapping must
  // fail loudly, never post to a fallback account.
  static async resolveAccount(configKey, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const q = CompanySettings.findOne({ companyId: company }).lean();
    const settings = await (session ? q.session(session) : q);
    const entry = settings?.accountConfiguration?.find((c) => c.configKey === configKey && c.isActive);
    if (!entry?.targetAccount) {
      throw new AppError(
        `Account not configured: "${configKey}". Map it under Accounting > Account configuration.`,
        422,
        "ACCOUNT_NOT_CONFIGURED"
      );
    }
    return entry.targetAccount;
  }

  static async resolveGroup(configKey, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const q = CompanySettings.findOne({ companyId: company }).lean();
    const settings = await (session ? q.session(session) : q);
    const entry = settings?.accountConfiguration?.find((c) => c.configKey === configKey && c.isActive);
    if (!entry?.targetGroup) {
      throw new AppError(`Account group not configured: "${configKey}"`, 422, "ACCOUNT_NOT_CONFIGURED");
    }
    return entry.targetGroup;
  }

  static async getSettings(req) {
    const { companyId } = getTenant(req);
    await this.ensureSettings(companyId);
    const s = await CompanySettings.findOne({ companyId }).select("-accountConfiguration").lean();
    return {
      ledgerPostingEnabled: Boolean(s.ledgerPostingEnabled),
      creditControl: { mode: "off", overdueBlockDays: 0, ...(s.creditControl || {}) },
      returnWindowDays: s.returnWindowDays || 0,
      requireReturnLink: Boolean(s.requireReturnLink),
      fiscalYearStartMonth: s.fiscalYearStartMonth,
      amountDecimal: s.amountDecimal,
      quantityDecimal: s.quantityDecimal,
      rateDecimal: s.rateDecimal,
      profile: s.profile || {},
    };
  }

  static async updateSettings(data, req) {
    const { companyId } = getTenant(req);
    await this.ensureSettings(companyId);
    const set = {};
    if (data.creditControl) {
      const { mode, overdueBlockDays } = data.creditControl;
      if (mode !== undefined) {
        if (!["off", "warn", "block"].includes(mode)) throw new AppError("creditControl.mode must be off, warn or block", 400);
        set["creditControl.mode"] = mode;
      }
      if (overdueBlockDays !== undefined) {
        const n = Number(overdueBlockDays);
        if (!Number.isInteger(n) || n < 0) throw new AppError("overdueBlockDays must be a whole number, 0 or more", 400);
        set["creditControl.overdueBlockDays"] = n;
      }
    }
    if (data.returnWindowDays !== undefined) {
      const n = Number(data.returnWindowDays);
      if (!Number.isInteger(n) || n < 0) throw new AppError("returnWindowDays must be a whole number, 0 or more", 400);
      set.returnWindowDays = n;
    }
    if (data.requireReturnLink !== undefined) set.requireReturnLink = Boolean(data.requireReturnLink);
    if (data.fiscalYearStartMonth !== undefined) {
      const n = Number(data.fiscalYearStartMonth);
      if (!Number.isInteger(n) || n < 1 || n > 12) throw new AppError("fiscalYearStartMonth must be 1-12", 400);
      set.fiscalYearStartMonth = n;
    }
    if (data.profile) {
      for (const k of ["legalName", "trn", "addressLine1", "city", "emirate", "countryCode", "email", "phone"]) {
        if (data.profile[k] !== undefined) set[`profile.${k}`] = String(data.profile[k]).trim();
      }
      if (data.profile.vatRegistered !== undefined) set["profile.vatRegistered"] = Boolean(data.profile.vatRegistered);
      const trn = set["profile.trn"];
      if (trn && !/^\d{15}$/.test(trn)) throw new AppError("A UAE TRN is 15 digits", 400, "INVALID_TRN");
    }
    await CompanySettings.updateOne({ companyId }, { $set: set });
    return this.getSettings(req);
  }

  static async isPostingEnabled({ session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const q = CompanySettings.findOne({ companyId: company }).select("ledgerPostingEnabled").lean();
    const settings = await (session ? q.session(session) : q);
    return Boolean(settings?.ledgerPostingEnabled);
  }

  // Switching posting ON requires every key to be mapped, so an approval can never fail halfway
  // on a missing account.
  static async setPostingEnabled(enabled, req, { auto = false } = {}) {
    const { companyId } = getTenant(req);
    if (enabled) {
      const r = await this.getReadiness(req);
      if (r.missing.length) {
        throw new AppError(
          `Map these accounts first: ${r.missing.map((m) => m.configKey).join(", ")}`,
          422,
          "ACCOUNT_NOT_CONFIGURED"
        );
      }
    }
    await this.ensureSettings(companyId);
    await CompanySettings.updateOne({ companyId }, { ledgerPostingEnabled: Boolean(enabled), ...(auto ? {} : { ledgerPostingTouched: true }) });
    return { ledgerPostingEnabled: Boolean(enabled) };
  }

  // Every active, mappable key that has no target yet. Feeds the readiness view.
  static async getReadiness(req) {
    const { accountConfiguration } = await this.getConfiguration(req);
    const mappable = accountConfiguration.filter((c) => c.isActive && c.targetKind !== "none");
    const missing = mappable
      .filter((c) => !(c.targetKind === "group" ? c.targetGroup : c.targetAccount))
      .map((c) => ({ configKey: c.configKey, displayName: c.displayName, targetKind: c.targetKind }));
    return { total: mappable.length, mapped: mappable.length - missing.length, missing };
  }
}

module.exports = AccountConfigService;
