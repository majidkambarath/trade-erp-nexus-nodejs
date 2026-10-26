const mongoose = require("mongoose");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const { groupFamily } = require("./cardService");
const rules = require("../../utils/chequeRules");
const reports = require("../../utils/chequeReports");
const AppError = require("../../utils/AppError");
const { isCalendarDay, todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const { ambientTenant } = require("../../utils/tenantContext");

// Reports over the cheques still in the air. The figures are made by utils/chequeReports.js (pure); this reads the rows,
// the names of the accounts, and what the bank accounts hold, and checks what it was asked.
//
// Read-only, and it follows the branch being worked in like the register does: a branch sees its own cheques.

const CAP = 5000; // a business with more cheques in the air than this is told the figures are partial rather than slow

function parse(query = {}) {
  const asOn = query.asOn ? String(query.asOn) : todayInOrg();
  if (!isCalendarDay(asOn)) throw new AppError("Enter a valid date", 400, "INVALID_DATE");
  if (query.direction && !["receipt", "payment"].includes(query.direction)) throw new AppError("Direction is receipt or payment", 400, "INVALID_DIRECTION");
  for (const k of ["bankAccountId", "partyId"]) {
    if (query[k] && !mongoose.isValidObjectId(query[k])) throw new AppError("That is not a valid id", 400, "INVALID_INPUT");
  }
  return { asOn, direction: query.direction || null, bankAccountId: query.bankAccountId || null, partyId: query.partyId || null };
}

class ChequeReportService {
  // Every cheque still in the air that matches, as the pure code wants it: its date as the organisation's calendar day,
  // and the account it moves money in or out of, by name.
  static async rows({ direction, bankAccountId, partyId }) {
    const filter = { status: { $in: rules.LIVE } };
    if (direction) filter.direction = direction;
    if (bankAccountId) filter.bankAccountId = bankAccountId;
    if (partyId) filter.partyId = partyId;
    const found = await Cheque.find(filter)
      .select("direction status chequeNo chequeDate partyId partyName bankAccountId amount voucherNo voucherId holdReason presentedOn")
      .sort({ chequeDate: 1, _id: 1 }).limit(CAP + 1).lean();
    const capped = found.length > CAP;
    const list = capped ? found.slice(0, CAP) : found;
    const ids = [...new Set(list.map((c) => String(c.bankAccountId)))];
    const accounts = ids.length ? await LedgerAccount.find({ _id: { $in: ids } }).select("accountName").lean() : [];
    const name = new Map(accounts.map((a) => [String(a._id), a.accountName]));
    return {
      capped,
      rows: list.map((c) => ({
        _id: String(c._id), direction: c.direction, status: c.status, chequeNo: c.chequeNo, chequeDay: toExpiryDay(c.chequeDate),
        partyId: c.partyId ? String(c.partyId) : null, partyName: c.partyName || "", bankAccountId: String(c.bankAccountId), bankName: name.get(String(c.bankAccountId)) || "",
        amount: c.amount, voucherNo: c.voucherNo, voucherId: String(c.voucherId), holdReason: c.holdReason || "",
      })),
    };
  }

  // What falls due and when, grouped by how far away (default), party, the bank account it moves, or month.
  static async maturity(query = {}) {
    const q = parse(query);
    const { rows, capped } = await this.rows(q);
    return { ...reports.maturity(rows, q.asOn, { groupBy: query.groupBy }), capped };
  }

  // What the cheques do to the bank, week by week or month by month, from what the bank accounts hold now.
  // The opening balance is the whole organisation's, so in a single-branch view (whose cheques are only that branch's) it
  // is left out rather than shown against figures it does not belong with.
  static async forward(query = {}) {
    const q = parse(query);
    const unit = query.unit === "month" ? "month" : "week";
    const count = query.count === undefined || query.count === "" ? 12 : Number(query.count);
    if (!Number.isInteger(count) || count < 1 || count > 52) throw new AppError("Show between 1 and 52 periods", 400, "INVALID_PERIODS");
    const { rows, capped } = await this.rows(q);
    const inBranch = Boolean(ambientTenant()?.branchView);
    let opening = null;
    if (!inBranch) {
      const { ids } = await groupFamily("bank-account-group", {});
      const filter = q.bankAccountId ? { _id: q.bankAccountId, groupId: { $in: ids } } : { isActive: true, groupId: { $in: ids } };
      const accounts = await LedgerAccount.find(filter).select("currentBalance").lean();
      opening = accounts.reduce((t, a) => t + (a.currentBalance || 0), 0);
    }
    return { ...reports.forward(rows, q.asOn, { unit, count, opening: opening ?? 0 }), openingKnown: opening !== null, capped };
  }
}

module.exports = ChequeReportService;
