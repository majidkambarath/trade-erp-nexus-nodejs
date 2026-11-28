const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Van = require("../../models/modules/vansales/vanModel");
const Organisation = require("../../models/core/organisationModel");
const plans = require("../../utils/plans");
const { getTenant } = require("../../utils/tenant");
const { findExpenseKind } = require("../../utils/vanSettings");
const VanSettingsService = require("./vanSettingsService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

// Which van a bill was spent on (repairs, tyres, insurance, fines paid by the office), so the van reports count it beside
// what the salesman spends on the road. A TAG on an expense voucher: it posts nothing and changes no figure in the books.
// A road expense recorded on a trip is tagged by the van module itself, and keeps that van.
class VanExpenseTagService {
  /** True when this organisation sells from vans at all. */
  static async vanSalesBought({ session } = {}) {
    const org = await Organisation.findOne({ code: getTenant().companyId }).session(session || null).lean();
    return Boolean(org) && plans.moduleAllows(org, "vansales.view");
  }

  /** The stored tag for { vanId, vanExpenseKind }, or null when no van is named. */
  static async resolve({ vanId, vanExpenseKind } = {}, { session } = {}) {
    if (vanId === undefined || vanId === null || vanId === "") return null;
    if (!(await this.vanSalesBought({ session }))) throw fail("Van sales is not part of this organisation", 403, "VAN_SALES_OFF");
    if (typeof vanId !== "string" && !(vanId instanceof mongoose.Types.ObjectId)) throw fail("Choose a van", 400, "VAN_NOT_FOUND");
    const van = mongoose.isValidObjectId(vanId) ? await Van.findById(vanId).select("code").session(session || null).lean() : null;
    if (!van) throw fail("That van does not exist", 400, "VAN_NOT_FOUND");
    const settings = await VanSettingsService.settings({ session });
    const wanted = vanExpenseKind || (findExpenseKind(settings, "other") ? "other" : settings.expenseKinds[0].key);
    const kind = findExpenseKind(settings, wanted);
    if (!kind) throw fail("Choose what the van expense was for", 400, "EXPENSE_KIND_UNKNOWN");
    return { vanRef: { vanId: van._id, vanCode: van.code }, vanExpenseKind: kind.key, vanExpenseLabel: kind.label };
  }

  /**
   * An edit of an expense voucher's tag, applied to the document. A body that says nothing changes nothing; an empty
   * van clears it; a road expense keeps the van and the kind it was taken with (its kind chose the account it posted to).
   */
  static async apply(voucher, data = {}, { session } = {}) {
    if (data.vanId === undefined && data.vanExpenseKind === undefined) return;
    const current = voucher.vanRef?.vanId ? String(voucher.vanRef.vanId) : "";
    const vanId = data.vanId === undefined ? current : String(data.vanId || "");
    const kind = data.vanExpenseKind === undefined ? voucher.vanExpenseKind : data.vanExpenseKind;
    if (vanId === current && (!vanId || (kind || "") === (voucher.vanExpenseKind || ""))) return;
    if (voucher.vanTripRef?.tripId) throw fail(`This is a road expense of van trip ${voucher.vanTripRef.tripNo}: its van and type are the trip's`, 409, "VAN_EXPENSE_FROM_TRIP");
    const tag = vanId ? await this.resolve({ vanId, vanExpenseKind: kind }, { session }) : null;
    voucher.vanRef = tag?.vanRef;
    voucher.vanExpenseKind = tag?.vanExpenseKind;
    voucher.vanExpenseLabel = tag?.vanExpenseLabel;
  }

  /** The office expense form's pick lists: every van by code and name, and the expense types. Empty without van sales. */
  static async choices() {
    if (!(await this.vanSalesBought())) return { vans: [], expenseKinds: [] };
    const [vans, settings] = await Promise.all([Van.find({}).select("code name active").sort({ code: 1 }).lean(), VanSettingsService.settings()]);
    return { vans: vans.map((v) => ({ id: String(v._id), code: v.code, name: v.name || "", active: v.active !== false })), expenseKinds: settings.expenseKinds };
  }
}

module.exports = VanExpenseTagService;
