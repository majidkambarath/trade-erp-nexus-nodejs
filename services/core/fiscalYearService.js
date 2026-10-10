const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const tz = require("../../utils/tz");
const orgLocale = require("../../utils/orgLocale");
const P = require("../../utils/periodClose");

// The zone a company's calendar runs in: the one named, else the organisation in scope.
const zoneOf = (companyId) => (companyId ? orgLocale.forCompany(companyId).timezone : orgLocale.timezone());

// Calendar year of an instant as seen in the organisation's zone (a UTC read files the first hours of a day into the
// previous day in a zone ahead of UTC, and on 1 Jan into the previous year).
const orgYear = (date, companyId) => tz.yearOf(new Date(date), zoneOf(companyId));

class FiscalYearService {
  static async list(req) {
    const { companyId } = getTenant(req);
    const rows = await FiscalYear.find({ companyId }).sort({ startDate: -1 }).lean();
    return rows.map((y) => this.withMonths(y, companyId));
  }

  // A year as the month close reads it: its days in the organisation's zone, and the month lock.
  static periodView(y, companyId) {
    const zone = zoneOf(companyId);
    return {
      code: y.code, status: y.status, startDay: tz.dayOf(y.startDate, zone), endDay: tz.dayOf(y.endDate, zone),
      lockedThroughDay: y.lockedThrough || null, monthCloses: y.monthCloses || [],
    };
  }

  // The year with its months and where each stands (open / closed / locked with the year). Read-only: the month close
  // itself is services/financial/periodCloseService.js.
  static withMonths(y, companyId) {
    const v = this.periodView(y, companyId);
    return { ...y, startDay: v.startDay, endDay: v.endDay, lockedThrough: v.lockedThroughDay, months: P.monthStates(v) };
  }

  static async getForDate(date, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const d = new Date(date);
    const q = FiscalYear.findOne({ companyId: company, startDate: { $lte: d }, endDate: { $gte: d } });
    return (session ? q.session(session) : q).lean();
  }

  // The label that scopes a number series. The fiscal year's code when one is defined for the
  // date, otherwise the organisation's calendar year, so numbering works before any year is configured.
  static async keyForDate(date, opts = {}) {
    const fy = await this.getForDate(date, opts);
    return fy ? fy.code : String(orgYear(date, opts.companyId));
  }

  // The gate every create / update / delete / cancel path calls before it writes.
  //
  // Bootstrap rule: while NO fiscal year exists for the company, posting is allowed. Once any
  // year is defined, a date outside every year is rejected, and a date in a closed year is
  // rejected. This is what makes the period lock real: a fiscal-year master on its own
  // restricts nothing unless every posting path consults it, and every one here does.
  //
  // Inside an OPEN year a second lock applies: the month lock (`lockedThrough`, utils/periodClose.js). A date on or before
  // that day is refused with PERIOD_CLOSED and the message names the day. The two locks are independent fields, so a closed
  // year is locked whatever its month lock says, and reopening the year gives back exactly the months closed before.
  // The year-end closing entry and PostingService.catchUp's document postings write their rows directly and do not come
  // through here (the closing entry is dated inside the month it closes). A reversal comes through with the DOCUMENT's date,
  // so undoing something dated in a locked month is refused, while a payment dated today settling an old invoice is not.
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
    if (fy.lockedThrough && tz.dayOf(new Date(date), zoneOf(company)) <= fy.lockedThrough) {
      throw new AppError(P.lockedMessage(fy.lockedThrough), 422, "PERIOD_CLOSED");
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

  // Creates the calendar year (in the organisation's zone) containing `date` if the company has no years yet.
  static async ensureDefault(date = new Date(), companyId) {
    const company = companyId || getTenant().companyId;
    if (await FiscalYear.exists({ companyId: company })) return null;
    const zone = zoneOf(company);
    const y = tz.yearOf(new Date(date), zone);
    return FiscalYear.create({
      companyId: company,
      code: String(y),
      startDate: tz.dayStart(`${y}-01-01`, zone), // 00:00 on 1 January there
      endDate: new Date(tz.dayStart(`${y + 1}-01-01`, zone).getTime() - 1),
      status: "open",
    });
  }
}

module.exports = FiscalYearService;
module.exports.orgYear = orgYear;
