const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const TIMEZONE = "Asia/Dubai";

// Calendar year of an instant as seen in Dubai (a UTC read files 00:00-04:00 local into the
// previous day, and on 1 Jan into the previous year).
const dubaiYear = (date) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, year: "numeric" }).format(new Date(date)));

class FiscalYearService {
  static async list(req) {
    const { companyId } = getTenant(req);
    return FiscalYear.find({ companyId }).sort({ startDate: -1 }).lean();
  }

  static async getForDate(date, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const d = new Date(date);
    const q = FiscalYear.findOne({ companyId: company, startDate: { $lte: d }, endDate: { $gte: d } });
    return (session ? q.session(session) : q).lean();
  }

  // The label that scopes a number series. The fiscal year's code when one is defined for the
  // date, otherwise the Dubai calendar year, so numbering works before any year is configured.
  static async keyForDate(date, opts = {}) {
    const fy = await this.getForDate(date, opts);
    return fy ? fy.code : String(dubaiYear(date));
  }

  // The gate every create / update / delete / cancel path calls before it writes.
  //
  // Bootstrap rule: while NO fiscal year exists for the company, posting is allowed. Once any
  // year is defined, a date outside every year is rejected, and a date in a closed year is
  // rejected. This is what makes the period lock real: a fiscal-year master on its own
  // restricts nothing unless every posting path consults it, and every one here does.
  static async assertPostingAllowed(date, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const anyQ = FiscalYear.exists({ companyId: company });
    const any = await (session ? anyQ.session(session) : anyQ);
    if (!any) return null;

    const fy = await this.getForDate(date, { session, companyId: company });
    if (!fy) {
      throw new AppError(
        `No fiscal year covers ${new Date(date).toISOString().slice(0, 10)}`,
        422,
        "NO_FISCAL_YEAR"
      );
    }
    if (fy.status === "closed") {
      throw new AppError(`Fiscal year ${fy.code} is closed`, 422, "PERIOD_CLOSED");
    }
    return fy;
  }

  static async create(data, req) {
    const { companyId } = getTenant(req);
    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);
    if (!(endDate > startDate)) throw new AppError("End date must be after start date", 400, "INVALID_PERIOD");

    // Years of one company may not overlap.
    const overlap = await FiscalYear.findOne({
      companyId,
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    }).lean();
    if (overlap) {
      throw new AppError(`Fiscal year overlaps with existing year ${overlap.code}`, 409, "DATE_OVERLAP");
    }
    return FiscalYear.create({ companyId, code: data.code, startDate, endDate, status: "open" });
  }

  static async setStatus(id, status, adminId) {
    const fy = await FiscalYear.findById(id);
    if (!fy) throw new AppError("Fiscal year not found", 404);
    fy.status = status;
    fy.closedAt = status === "closed" ? new Date() : undefined;
    fy.closedBy = status === "closed" ? adminId : undefined;
    return fy.save();
  }

  // Creates the Dubai-calendar year containing `date` if the company has no years yet.
  static async ensureDefault(date = new Date(), companyId) {
    const company = companyId || getTenant().companyId;
    if (await FiscalYear.exists({ companyId: company })) return null;
    const y = dubaiYear(date);
    return FiscalYear.create({
      companyId: company,
      code: String(y),
      startDate: new Date(Date.UTC(y, 0, 1) - 4 * 3600 * 1000), // 00:00 Dubai
      endDate: new Date(Date.UTC(y + 1, 0, 1) - 4 * 3600 * 1000 - 1),
      status: "open",
    });
  }
}

module.exports = FiscalYearService;
module.exports.dubaiYear = dubaiYear;
