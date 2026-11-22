// The cash flow forecast (utils/cashForecast.js is the arithmetic): today's cash and bank balance, then everything the books already say
// will come in or go out, week by week. Read live; nothing is stored and nothing is posted.
//
// WHERE EACH LINE COMES FROM, and what it deliberately is NOT:
//   receivables / payables     the open invoices and bills on their due day (AgeingService.openInvoices). A paid one is no longer open, so a
//                              cheque that settled an invoice is not counted twice (the cheque is in the cheque register, but the invoice
//                              it paid is out of the ageing).
//   cheques                    received and issued cheques not yet cleared, on the cheque's own date; one on hold is kept out of the balance.
//   recurring invoices         each coming run of a running template, on its run day plus the customer's terms. A GUIDE (`certain: false`):
//                              each invoice is priced on its own day.
//   recurring expenses         each coming run of a running expense template (the recurring-voucher module), with its tax. Journals move no
//                              cash and are left out. Skipped quietly when that module is not in this build.
//   payroll                    only where the organisation bought HR: salaries already posted and not yet paid (the Salaries Payable balance)
//                              in week 1, then each coming month end at the last posted net pay (or a plan for that month when none).
// An overdue document is NOT promised in the balance: it is reported apart (utils/cashForecast.js).
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const plans = require("../../utils/plans");
const Organisation = require("../../models/core/organisationModel");
const { LedgerEntry } = require("../../models/modules/financial/financialModels");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const rules = require("../../utils/recurring");
const forecast = require("../../utils/cashForecast");
const LedgerReportsService = require("./ledgerReportsService");
const AgeingService = require("../financial/ageingService");
const ChequeReportService = require("../banking/chequeReportService");

const DEFAULT_WEEKS = 13;
const RUNS_CAP = 60; // coming runs read per template: a weekly template over 26 weeks is 26

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const scheduleOf = (t) => ({ frequency: t.frequency, interval: t.interval, startDay: t.startDay, endDay: t.endDay || undefined, maxCount: t.maxCount || undefined });

function weeksOf(query = {}) {
  if (query.weeks === undefined || query.weeks === "") return DEFAULT_WEEKS;
  // a number or text only: Number(["3"]) is 3, so a repeated query key (weeks[]=3) would otherwise pass
  const n = typeof query.weeks === "number" || typeof query.weeks === "string" ? Number(query.weeks) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > forecast.MAX_WEEKS) throw new AppError(`Weeks is a whole number from 1 to ${forecast.MAX_WEEKS}`, 400, "INVALID_WEEKS");
  return n;
}

/** "YYYY-MM" of every month end that falls inside [from, to]. */
function monthEnds(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  for (let i = 0; i < 40; i += 1) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const day = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    if (day > to) break;
    if (day >= from) out.push({ period: `${y}-${String(m).padStart(2, "0")}`, day });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

class CashForecastService {
  static async forecast(query = {}, { now = new Date() } = {}) {
    const count = weeksOf(query);
    const today = todayInOrg(now);
    const grid = forecast.weeks(today, count);
    const horizon = grid[grid.length - 1].to;
    const notes = [];
    const items = [];

    // ---- today's cash and bank, from the ledger (the cash book respects the branch being viewed)
    const book = await LedgerReportsService.cashBook({ from: today, to: today });
    const opening = round2(book.totals?.all?.closing ?? 0);
    const accounts = (book.rows || []).map((r) => ({ accountId: String(r.accountId), name: r.accountName, kind: r.kind, balance: round2(r.closing) }));

    const attempt = async (what, fn) => {
      try {
        await fn();
      } catch (error) {
        notes.push(`${what} could not be read (${error.message}), so it is left out of the forecast.`);
      }
    };

    // ---- open invoices and bills, on their due day
    await attempt("The open invoices and bills", async () => {
      const [receivable, payable] = await Promise.all([AgeingService.openInvoices({ type: "receivable" }), AgeingService.openInvoices({ type: "payable" })]);
      const add = (rows, sign, source) => {
        for (const r of rows) {
          if (r.isOpening && !r.outstanding) continue;
          items.push({ day: toExpiryDay(r.dueDate), amount: sign * r.outstanding, source, label: r.partyName, ref: r.transactionNo, certain: true });
        }
      };
      add(receivable, 1, "receivables");
      add(payable, -1, "payables");
    });

    // ---- cheques not yet in the bank
    await attempt("The cheque register", async () => {
      const { rows, capped } = await ChequeReportService.rows({});
      if (capped) notes.push("There are more cheques than the forecast reads; the earliest are included.");
      for (const c of rows) {
        items.push({
          day: c.chequeDay, amount: (c.direction === "receipt" ? 1 : -1) * c.amount, source: c.direction === "receipt" ? "chequesIn" : "chequesOut",
          label: c.partyName || c.bankName, ref: `Cheque ${c.chequeNo}`, certain: true, onHold: c.status === "hold",
        });
      }
    });

    // ---- recurring invoices (a guide)
    await attempt("The recurring invoices", async () => {
      const RecurringInvoice = require("../../models/modules/recurringInvoiceModel");
      const Customer = require("../../models/modules/customerModel");
      const templates = await RecurringInvoice.find({ status: "ACTIVE" }).select("name partyId totalAmount frequency interval startDay endDay maxCount cursor made").limit(300).lean();
      const customers = await Customer.find({ _id: { $in: templates.map((t) => t.partyId) } }).select("customerName paymentTerms").lean();
      const byId = new Map(customers.map((c) => [String(c._id), c]));
      for (const t of templates) {
        const c = byId.get(String(t.partyId));
        const terms = AgeingService.termDays(c?.paymentTerms);
        for (const day of rules.upcoming(scheduleOf(t), t.cursor || 0, RUNS_CAP, t.made || 0)) {
          items.push({ day: forecast.addDays(day, terms), amount: t.totalAmount, source: "recurringSales", label: t.name, ref: c?.customerName || "", certain: false });
        }
      }
    });

    // ---- recurring expenses (only where the recurring-voucher module exists in this build)
    let RecurringVoucher = null;
    try {
      RecurringVoucher = require("../../models/modules/financial/recurringVoucherModel");
    } catch {
      RecurringVoucher = null;
    }
    if (RecurringVoucher) {
      await attempt("The recurring expenses", async () => {
        const TaxCode = require("../../models/modules/financial/taxCodeModel");
        const templates = await RecurringVoucher.find({ status: "ACTIVE", kind: "expense" }).select("name amount taxCodeId frequency interval startDay endDay maxCount cursor made").limit(300).lean();
        const codes = await TaxCode.find({ _id: { $in: templates.map((t) => t.taxCodeId).filter(Boolean) } }).select("ratePercent").lean();
        const rate = new Map(codes.map((c) => [String(c._id), c.ratePercent]));
        for (const t of templates) {
          const gross = forecast.grossOf(t.amount, t.taxCodeId ? rate.get(String(t.taxCodeId)) : 0);
          for (const day of rules.upcoming(scheduleOf(t), t.cursor || 0, RUNS_CAP, t.made || 0)) {
            items.push({ day, amount: -gross, source: "recurringExpenses", label: t.name, certain: false });
          }
        }
      });
    }

    // ---- payroll, only where HR was bought
    const { companyId } = getTenant();
    const organisation = await Organisation.findOne({ code: companyId }).lean();
    if (organisation && plans.moduleAllows(organisation, "hr.view")) {
      await attempt("The payroll", async () => {
        const PayrollRun = require("../../models/modules/hr/payrollRunModel");
        const PayrollService = require("../hr/payrollService");
        const AccountConfigService = require("../financial/accountConfigService");
        // salaries already posted and not yet paid: the Salaries Payable account's credit balance, in week 1
        const accountId = await AccountConfigService.resolveAccount("salaries-payable").catch(() => null);
        if (accountId) {
          const [row] = await LedgerEntry.aggregate([{ $match: { accountId, isReversed: { $ne: true } } }, { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } }]);
          const owed = round2((row?.credit || 0) - (row?.debit || 0));
          if (owed > 0) items.push({ day: today, amount: -owed, source: "payroll", label: "Salaries posted and not yet paid", certain: true });
        }
        // each coming month end: the last posted net pay, unless that month is already posted (then it is the amount above)
        const runs = await PayrollRun.find({ status: "POSTED" }).sort({ period: -1 }).select("period totalNet").limit(24).lean();
        const posted = new Set(runs.map((r) => r.period));
        const last = runs[0]?.totalNet || 0;
        for (const { period, day } of monthEnds(today, horizon)) {
          if (posted.has(period)) continue;
          let net = last;
          if (!net) net = (await PayrollService.plan(period).catch(() => null))?.totals?.net || 0;
          if (net > 0) items.push({ day, amount: -net, source: "payroll", label: `Salaries for ${period}`, certain: false });
        }
      });
    } else {
      notes.push("Salaries are not in this forecast: payroll is not part of this plan.");
    }

    const result = forecast.buildForecast({ today, opening, items, count });
    if (result.overdue.count) notes.push(`${result.overdue.count} overdue invoices, bills or cheques are shown apart and are not counted in the balance: they may be paid tomorrow or never.`);
    return { ...result, accounts, notes, sources: forecast.SOURCES, currency: require("../../utils/orgLocale").baseCurrency() };
  }
}

module.exports = CashForecastService;
