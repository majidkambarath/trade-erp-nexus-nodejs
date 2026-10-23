const IssuedNumber = require("../../models/modules/financial/issuedNumberModel");
const NumberSeries = require("../../models/modules/financial/numberSeriesModel");
const VoucherTypeService = require("./voucherTypeService");
const { getTenant } = require("../../utils/tenant");
const { ambientTenant } = require("../../utils/tenantContext");
const V = require("../../utils/voucherTypes");

// Reading the register of numbers given out: what is in use, what was deleted and why, and whether a
// series' sequence is unbroken. Read-only - the register is written by services/core/numberSeriesService.js
// inside the same transaction as the document it numbers.

const PAGE = 50;
const names = (types) => new Map(types.map((t) => [t.key, t.name]));

class NumberRegisterService {
  // A head office in the all-branches view reads every branch's numbers; a branch reads its own.
  // branchView is only on the ambient scope, since getTenant() does not carry it.
  static viewOf(req) {
    const { companyId, branchId } = getTenant(req);
    const ambient = ambientTenant();
    const view = ambient && Object.prototype.hasOwnProperty.call(ambient, "branchView") ? ambient.branchView : branchId;
    return { companyId, branchId, view };
  }

  /**
   * The register, newest first. `status: "ended"` is the deleted list - every number whose document was
   * removed, whether the number went back to be used again or was retired for good.
   */
  static async list(req, { series, status, branch, from, to, page = 1, limit = PAGE } = {}) {
    const { companyId, view } = this.viewOf(req);
    const filter = { companyId };
    if (view) filter.branchId = view;
    else if (branch) filter.branchId = String(branch).toLowerCase();
    if (series) filter.series = String(series).toUpperCase();
    if (status === "ended") filter.status = { $in: ["released", "cancelled"] };
    else if (["issued", "released", "cancelled"].includes(status)) filter.status = status;
    if (from || to) {
      filter.at = {};
      if (from) filter.at.$gte = new Date(from);
      if (to) filter.at.$lte = new Date(to);
    }

    const lim = Math.min(Math.max(Number(limit) || PAGE, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const [rows, total, types] = await Promise.all([
      IssuedNumber.find(filter).sort({ at: -1, _id: -1 }).skip(skip).limit(lim).lean(),
      IssuedNumber.countDocuments(filter),
      VoucherTypeService.all(req),
    ]);
    const label = names(types);
    return {
      rows: rows.map((r) => ({ ...r, typeName: label.get(r.series) || r.series, scope: V.labelText(r.label) })),
      total,
      page: Math.max(Number(page) || 1, 1),
      pages: Math.ceil(total / lim) || 1,
    };
  }

  /** How many numbers are in use, how many were handed back, how many retired. */
  static async summary(req, { series } = {}) {
    const { companyId, view } = this.viewOf(req);
    const match = { companyId };
    if (view) match.branchId = view;
    if (series) match.series = String(series).toUpperCase();
    const rows = await IssuedNumber.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    return { issued: by.issued || 0, released: by.released || 0, cancelled: by.cancelled || 0 };
  }

  /**
   * Is this series' sequence unbroken, and where it is not, why. One counter at a time (a series and a
   * label), because that is the only thing a sequence means.
   *
   * The counter is read too, so a number taken by a transaction that then rolled back shows as a hole
   * rather than as nothing at all: the counter has moved past it and the register never saw it.
   */
  static async gaps(req, { series, label, branch } = {}) {
    const { companyId, branchId, view } = this.viewOf(req);
    const s = String(series || "").toUpperCase();
    if (!s) return { series: null, scopes: [] };
    const where = { companyId, series: s };
    const b = view || (branch ? String(branch).toLowerCase() : branchId);
    if (b) where.branchId = b;

    const counters = await NumberSeries.find(where).lean();
    const wanted = label ? counters.filter((c) => c.fiscalYear === label) : counters;
    const type = await VoucherTypeService.configFor({ series: s, companyId });

    const scopes = [];
    for (const counter of wanted) {
      const rows = await IssuedNumber.find({ companyId, branchId: counter.branchId, series: s, label: counter.fiscalYear })
        .select("seq status number reason docType docId at endedAt endedBy by manual")
        .sort({ seq: 1 })
        .lean();
      scopes.push({
        branchId: counter.branchId,
        label: counter.fiscalYear,
        scope: V.labelText(counter.fiscalYear),
        counter: Number(counter.next) || 0,
        ...V.gapsOf(rows, { upTo: Number(counter.next) || 0 }),
        rows,
      });
    }
    return { series: s, name: type ? type.name : s, scopes };
  }
}

module.exports = NumberRegisterService;
