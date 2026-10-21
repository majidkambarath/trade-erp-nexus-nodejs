const ProductionService = require("../../services/stock/productionService");
const AuditService = require("../../services/core/auditService");
const { assertPermission } = require("../../middleware/permissionGate");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const describe = (p) => `Production ${p.productionNo}: ${p.finished.itemName} x ${p.finished.qty}`;
const snapshot = (p) => ({
  productionNo: p.productionNo, status: p.status, date: p.date, finished: { itemId: p.finished.itemId, itemName: p.finished.itemName, qty: p.finished.qty },
  materials: (p.materials || []).map((m) => ({ itemId: m.itemId, qty: m.qty, cost: m.cost })),
  costs: (p.costs || []).map((c) => ({ account: c.accountName, amount: c.amount })), totals: p.totals,
});
const log = (req, action, p, summary) => AuditService.log({ req, action, entity: "ProductionOrder", entityId: p._id, summary, after: snapshot(p) });

// Moving an expense into a product's cost changes the books as much as an expense voucher does, so a cost line
// needs the right to add finance entries (and, to take a posted one back, to delete posted ones), not only stock.
const assertCostRights = (req, costs, key) => {
  if ((costs || []).length) assertPermission(req, key, "moving expenses into a product's cost changes the books");
};

exports.list = catchAsync(async (req, res) => ok(res, await ProductionService.list(req.query)));
exports.costReport = catchAsync(async (req, res) => ok(res, await ProductionService.costReport(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await ProductionService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "ProductionOrder", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  assertCostRights(req, req.body?.costs, "finance.create");
  const p = await ProductionService.create(req.body || {}, by(req));
  await log(req, "PRODUCTION_CREATED", p, `${describe(p)} saved as draft`);
  ok(res, ProductionService.present(p), 201);
});

exports.update = catchAsync(async (req, res) => {
  assertCostRights(req, req.body?.costs, "finance.create");
  const p = await ProductionService.update(req.params.id, req.body || {}, by(req));
  await log(req, "PRODUCTION_UPDATED", p, `${describe(p)} edited`);
  ok(res, ProductionService.present(p));
});

exports.remove = catchAsync(async (req, res) => {
  const p = await ProductionService.remove(req.params.id, by(req));
  await log(req, "PRODUCTION_DELETED", p, `${describe(p)} (draft) deleted`);
  ok(res, { _id: p._id, productionNo: p.productionNo });
});

exports.post = catchAsync(async (req, res) => {
  const current = await ProductionService.getById(req.params.id);
  assertCostRights(req, current.costs, "finance.create");
  const p = await ProductionService.post(req.params.id, { acknowledge: req.body?.acknowledge }, by(req));
  await log(req, "PRODUCTION_POSTED", p, `${describe(p)} posted: unit cost ${money(p.totals.unitCost)}, total ${money(p.totals.total)}`);
  ok(res, ProductionService.present(p));
});

exports.reverse = catchAsync(async (req, res) => {
  const current = await ProductionService.getById(req.params.id);
  assertCostRights(req, current.costs, "finance.deletePosted");
  const p = await ProductionService.reverse(req.params.id, { reason: req.body?.reason }, by(req));
  await log(req, "PRODUCTION_REVERSED", p, `${describe(p)} reversed${p.reverseReason ? `: ${p.reverseReason}` : ""}`);
  ok(res, ProductionService.present(p));
});
