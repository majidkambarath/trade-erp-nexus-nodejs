const { Currency, ExchangeRate } = require("../../models/modules/financial/currencyModels");
const { Voucher } = require("../../models/modules/financial/financialModels");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AuditService = require("../core/auditService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { RATE_DECIMALS, decimalPlaces, orgDay, orgDayStart, isCalendarDay, displayDay } = require("../../utils/fx");

const orgLocale = require("../../utils/orgLocale");

// What a company's base currency reads as when its settings do not say: the organisation's own (AED for the original one).
const DEFAULT_BASE = "AED";
const DEFAULT_TOLERANCE_PERCENT = 5;
const RATE_SOURCES = ["manual", "cbuae", "import"];
const MAX_RATE = 1e9;

// What a company starts with: the base currency, active, and the currencies a UAE food trader
// is most likely to deal in, switched off until somebody enables them. None of them has a rate.
const SEED = [
  { code: "AED", name: "UAE Dirham", symbol: "AED", decimals: 2, isBase: true, isActive: true },
  { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "Pound Sterling", symbol: "£", decimals: 2 },
  { code: "SAR", name: "Saudi Riyal", symbol: "SAR", decimals: 2 },
  { code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2 },
  { code: "KWD", name: "Kuwaiti Dinar", symbol: "KWD", decimals: 3 },
  { code: "BHD", name: "Bahraini Dinar", symbol: "BHD", decimals: 3 },
  { code: "OMR", name: "Omani Rial", symbol: "OMR", decimals: 3 },
  { code: "QAR", name: "Qatari Riyal", symbol: "QAR", decimals: 2 },
];

const withSession = (q, session) => (session ? q.session(session) : q);

function normCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new AppError("A currency code is three letters, for example USD", 400, "INVALID_CURRENCY_CODE");
  return c;
}

// An effective date or a lookup date as a Dubai calendar day "YYYY-MM-DD". A plain day is taken as
// it is; a full timestamp is read as the Dubai day it falls in.
function toDay(value, label = "date") {
  if (value === undefined || value === null || value === "") return orgDay(new Date());
  const day = orgDay(value);
  if (!day || !isCalendarDay(day)) throw new AppError(`Enter a valid ${label}`, 400, "INVALID_DATE");
  return day;
}

const shapeRate = (r) => ({
  _id: r._id, code: r.code, rate: r.rate, effectiveDate: r.effectiveDate, effectiveDay: orgDay(r.effectiveDate),
  source: r.source, note: r.note || "", createdBy: r.createdBy || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

// The currency master and its exchange-rate history. AED is the base currency: every ledger amount
// is in it, it is seeded on first use, and it can be neither deleted, deactivated nor given a rate.
//
// PHASE 1 stops at receipts and payments in a foreign currency (FxVoucherService). Foreign-currency
// INVOICES, the realised exchange gain or loss when one is settled at a different rate, and
// period-end revaluation of open foreign balances (IAS 21) are phase 2 and build on the same
// master and the same rateOn() lookup.
class CurrencyService {
  static DEFAULT_BASE = DEFAULT_BASE;
  static DEFAULT_TOLERANCE_PERCENT = DEFAULT_TOLERANCE_PERCENT;

  // First use: the base currency and the starter list. Idempotent and safe to race (upserts).
  // A company that already has currencies is never re-seeded, so a currency somebody deleted stays gone.
  static async ensureSeeded(req) {
    const { companyId } = getTenant(req);
    const count = await Currency.countDocuments({ companyId });
    if (count === 0) {
      await Currency.bulkWrite(
        SEED.map((c) => ({ updateOne: { filter: { companyId, code: c.code }, update: { $setOnInsert: { isBase: false, isActive: false, ...c, companyId } }, upsert: true } })),
        { ordered: false }
      );
    } else if (!(await Currency.exists({ companyId, isBase: true }))) {
      const base = SEED[0];
      await Currency.updateOne({ companyId, code: base.code }, { $setOnInsert: { ...base, companyId } }, { upsert: true });
    }
  }

  // The code of the base currency. Never seeds (it runs inside posting transactions).
  static async baseCode({ session, req } = {}) {
    const { companyId } = getTenant(req);
    const base = await withSession(Currency.findOne({ companyId, isBase: true }).select("code").lean(), session);
    return base?.code || orgLocale.baseCurrency();
  }

  static async get(code, { session, req } = {}) {
    const { companyId } = getTenant(req);
    return withSession(Currency.findOne({ companyId, code: normCode(code) }).lean(), session);
  }

  static async #must(code, req) {
    const c = await this.get(code, { req });
    if (!c) throw new AppError(`Currency ${normCode(code)} is not in the list`, 404, "CURRENCY_NOT_FOUND");
    return c;
  }

  // Codes of currencies that appear on a voucher as the foreign currency.
  static async usedCodes() {
    return new Set(await Voucher.distinct("currency", { foreignAmount: { $exists: true } }));
  }

  // Every currency, base first, with the rate that applies today and how many rates it has.
  static async list(req) {
    await this.ensureSeeded(req);
    const { companyId } = getTenant(req);
    const asOf = orgDayStart(orgDay(new Date()));
    const [rows, latest, counts, used] = await Promise.all([
      Currency.find({ companyId }).lean(),
      ExchangeRate.aggregate([
        { $match: { companyId, effectiveDate: { $lte: asOf } } },
        { $sort: { effectiveDate: -1 } },
        { $group: { _id: "$code", rate: { $first: "$rate" }, effectiveDate: { $first: "$effectiveDate" }, source: { $first: "$source" } } },
      ]),
      ExchangeRate.aggregate([{ $match: { companyId } }, { $group: { _id: "$code", n: { $sum: 1 } } }]),
      this.usedCodes(),
    ]);
    const latestBy = new Map(latest.map((r) => [r._id, r]));
    const countBy = new Map(counts.map((r) => [r._id, r.n]));
    return rows
      .map((c) => {
        const l = latestBy.get(c.code);
        return {
          _id: c._id, code: c.code, name: c.name, symbol: c.symbol, decimals: c.decimals, isBase: c.isBase, isActive: c.isActive,
          latestRate: c.isBase ? 1 : l?.rate ?? null,
          latestRateDate: c.isBase ? null : l ? orgDay(l.effectiveDate) : null,
          latestSource: c.isBase ? null : l?.source ?? null,
          rateCount: countBy.get(c.code) || 0,
          used: used.has(c.code),
        };
      })
      .sort((a, b) => Number(b.isBase) - Number(a.isBase) || Number(b.isActive) - Number(a.isActive) || a.code.localeCompare(b.code));
  }

  static async create(data = {}, req) {
    await this.ensureSeeded(req);
    const { companyId } = getTenant(req);
    const code = normCode(data.code);
    const name = String(data.name ?? "").trim();
    if (!name) throw new AppError("Enter the currency's name", 400, "NAME_REQUIRED");
    const decimals = data.decimals === undefined || data.decimals === "" ? 2 : Number(data.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw new AppError("Decimal places must be a whole number from 0 to 4", 400, "INVALID_DECIMALS");
    if (await Currency.exists({ companyId, code })) throw new AppError(`Currency ${code} is already in the list`, 409, "DUPLICATE_CURRENCY");
    const row = await Currency.create({ companyId, code, name, symbol: String(data.symbol ?? "").trim(), decimals, isBase: false, isActive: data.isActive === undefined ? true : Boolean(data.isActive) });
    await AuditService.log({ req, action: "CURRENCY_CREATED", entity: "Currency", entityId: row._id, summary: `${code} ${name}`, after: { code, name, decimals } });
    return row.toObject();
  }

  static async update(code, data = {}, req) {
    await this.ensureSeeded(req);
    const { companyId } = getTenant(req);
    const current = await this.#must(code, req);
    if (current.isBase) throw new AppError(`${current.code} is the base currency and cannot be changed`, 409, "BASE_CURRENCY_LOCKED");
    const set = {};
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new AppError("Enter the currency's name", 400, "NAME_REQUIRED");
      set.name = name;
    }
    if (data.symbol !== undefined) set.symbol = String(data.symbol).trim();
    if (data.decimals !== undefined) {
      const decimals = Number(data.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw new AppError("Decimal places must be a whole number from 0 to 4", 400, "INVALID_DECIMALS");
      if (decimals !== current.decimals && (await this.usedCodes()).has(current.code)) {
        throw new AppError(`${current.code} is on vouchers already, so its decimal places can no longer change`, 409, "CURRENCY_IN_USE");
      }
      set.decimals = decimals;
    }
    if (data.isActive !== undefined) set.isActive = Boolean(data.isActive);
    const row = await Currency.findOneAndUpdate({ companyId, code: current.code }, { $set: set }, { new: true, runValidators: true }).lean();
    const action = set.isActive !== undefined && Object.keys(set).length === 1 ? (set.isActive ? "CURRENCY_ENABLED" : "CURRENCY_DISABLED") : "CURRENCY_UPDATED";
    await AuditService.log({ req, action, entity: "Currency", entityId: row._id, summary: `${row.code} ${row.name}`, before: { name: current.name, symbol: current.symbol, decimals: current.decimals, isActive: current.isActive }, after: set });
    return row;
  }

  // Only a currency that was never used can go: not the base, not one on any voucher, and not one
  // with a rate history (that history is an audit trail). Anything else is switched off instead.
  static async remove(code, req) {
    const { companyId } = getTenant(req);
    const current = await this.#must(code, req);
    if (current.isBase) throw new AppError(`${current.code} is the base currency and cannot be deleted`, 409, "BASE_CURRENCY_LOCKED");
    if ((await this.usedCodes()).has(current.code)) {
      throw new AppError(`${current.code} is used on vouchers and cannot be deleted. Deactivate it instead.`, 409, "CURRENCY_IN_USE");
    }
    if (await ExchangeRate.exists({ companyId, code: current.code })) {
      throw new AppError(`${current.code} has an exchange-rate history and cannot be deleted. Deactivate it instead.`, 409, "CURRENCY_HAS_RATES");
    }
    await Currency.deleteOne({ companyId, code: current.code });
    await AuditService.log({ req, action: "CURRENCY_DELETED", entity: "Currency", entityId: current._id, summary: `${current.code} ${current.name}` });
    return { code: current.code };
  }

  // ------------------------------------------------------------------------------------ rates

  // Records the rate that applies from `effectiveDate`. A second rate for the same day replaces the
  // first (a correction); the replaced value is kept in the audit log.
  static async addRate(code, data = {}, req) {
    await this.ensureSeeded(req);
    const { companyId } = getTenant(req);
    const currency = await this.#must(code, req);
    if (currency.isBase) throw new AppError(`${currency.code} is the base currency; its rate is always 1`, 409, "BASE_CURRENCY_NO_RATE");

    const rate = Number(data.rate);
    if (data.rate === undefined || data.rate === null || data.rate === "" || !Number.isFinite(rate) || rate <= 0) {
      throw new AppError("Enter a rate greater than zero", 400, "INVALID_RATE");
    }
    if (decimalPlaces(rate) > RATE_DECIMALS) throw new AppError(`A rate can have at most ${RATE_DECIMALS} decimal places`, 400, "INVALID_RATE");
    if (rate >= MAX_RATE) throw new AppError("That rate is too large to be right", 400, "INVALID_RATE");
    const source = data.source === undefined || data.source === "" ? "manual" : String(data.source);
    if (!RATE_SOURCES.includes(source)) throw new AppError(`The source must be one of ${RATE_SOURCES.join(", ")}`, 400, "INVALID_SOURCE");
    const day = toDay(data.effectiveDate, "effective date");
    const effectiveDate = orgDayStart(day);
    const note = String(data.note ?? "").trim().slice(0, 200);
    const createdBy = req?.admin?.id ? String(req.admin.id) : null;

    const before = await ExchangeRate.findOneAndUpdate(
      { companyId, code: currency.code, effectiveDate },
      { $set: { rate, source, note, createdBy } },
      { upsert: true, new: false, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    const row = await ExchangeRate.findOne({ companyId, code: currency.code, effectiveDate }).lean();
    await AuditService.log({
      req, action: before ? "EXCHANGE_RATE_REPLACED" : "EXCHANGE_RATE_ADDED", entity: "ExchangeRate", entityId: row._id,
      summary: `${currency.code} ${rate} from ${displayDay(day)}`,
      before: before ? { rate: before.rate, source: before.source, note: before.note, effectiveDate: day } : null,
      after: { rate, source, note, effectiveDate: day },
    });
    return { ...shapeRate(row), replaced: Boolean(before), previousRate: before ? before.rate : null };
  }

  // Newest first.
  static async rateHistory(code, req, { from, to, limit = 100 } = {}) {
    await this.ensureSeeded(req);
    const { companyId } = getTenant(req);
    const currency = await this.#must(code, req);
    const q = { companyId, code: currency.code };
    if (from || to) {
      q.effectiveDate = {};
      if (from) q.effectiveDate.$gte = orgDayStart(toDay(from, "from date"));
      if (to) q.effectiveDate.$lte = orgDayStart(toDay(to, "to date"));
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const rows = await ExchangeRate.find(q).sort({ effectiveDate: -1 }).limit(lim).lean();
    return rows.map(shapeRate);
  }

  // The rate in force on a day: the latest one effective on or before it. There is deliberately no
  // fallback - a missing rate is an error, never a silent 1.
  static async rateOn(code, date, { session, req } = {}) {
    const { companyId } = getTenant(req);
    const c = normCode(code);
    const day = toDay(date);
    if (c === (await this.baseCode({ session, req }))) return { code: c, rate: 1, rateDate: null, rateDay: null, source: "base", note: "", forDay: day };
    const row = await withSession(
      ExchangeRate.findOne({ companyId, code: c, effectiveDate: { $lte: orgDayStart(day) } }).sort({ effectiveDate: -1 }).lean(),
      session
    );
    if (!row) throw new AppError(`No ${c} rate on or before ${displayDay(day)}. Add one under Currencies.`, 422, "NO_RATE");
    return { code: c, rate: row.rate, rateDate: row.effectiveDate, rateDay: orgDay(row.effectiveDate), source: row.source, note: row.note || "", forDay: day };
  }

  // ---------------------------------------------------------------------------------- settings

  static async getSettings(req, { session } = {}) {
    const { companyId } = getTenant(req);
    const s = await withSession(CompanySettings.findOne({ companyId }).select("baseCurrency fxTolerancePercent").lean(), session);
    return { baseCurrency: s?.baseCurrency || orgLocale.baseCurrency(), fxTolerancePercent: s?.fxTolerancePercent ?? DEFAULT_TOLERANCE_PERCENT };
  }

  // How far, in percent, a rate typed on a voucher may be from the master rate before a reason is needed.
  static async updateSettings(data = {}, req) {
    const { companyId } = getTenant(req);
    const set = {};
    if (data.fxTolerancePercent !== undefined) {
      const n = Number(data.fxTolerancePercent);
      if (data.fxTolerancePercent === "" || !Number.isFinite(n) || n < 0 || n > 100 || decimalPlaces(n) > 2) {
        throw new AppError("The allowed difference is a percentage from 0 to 100, with at most two decimals", 400, "INVALID_TOLERANCE");
      }
      set.fxTolerancePercent = n;
    }
    if (Object.keys(set).length) {
      await require("./accountConfigService").ensureSettings(companyId);
      const before = await this.getSettings(req);
      await CompanySettings.updateOne({ companyId }, { $set: set });
      await AuditService.log({ req, action: "FX_SETTINGS_UPDATED", entity: "CompanySettings", entityId: companyId, summary: `Allowed rate difference ${set.fxTolerancePercent}%`, before, after: set });
    }
    return this.getSettings(req);
  }
}

module.exports = CurrencyService;
