const TradeOrderService = require("../../services/orderPurchase/tradeOrderService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const resolveCreatedBy = (req) => req.admin?.id || req.user?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const noun = (o) => (o.kind === "sales" ? "Sales order" : "Purchase order");
const describe = (o) => `${noun(o)} ${o.orderNo} - ${money(o.totalAmount)}`;
const snapshot = (o) => ({
  orderNo: o.orderNo, kind: o.kind, status: o.status, partyId: o.partyId, date: o.date, expectedDate: o.expectedDate,
  totalAmount: o.totalAmount, lines: o.items?.length || 0, reference: o.reference || null,
});
const log = (req, action, o, summary) => AuditService.log({ req, action, entity: "TradeOrder", entityId: o._id, summary, after: snapshot(o) });
const shaped = (o) => TradeOrderService.present(o.toObject(), { lines: {}, totals: { ordered: 0, received: 0, invoiced: 0 }, receiving: "NONE", invoicing: "NONE" });

exports.list = catchAsync(async (req, res) => {
  const { rows, pagination } = await TradeOrderService.list(req.query);
  res.status(200).json({ success: true, data: rows, pagination });
});
exports.summary = catchAsync(async (req, res) => ok(res, await TradeOrderService.summary(req.query.kind)));
exports.get = catchAsync(async (req, res) => ok(res, await TradeOrderService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "TradeOrder", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const o = await TradeOrderService.create(req.body, resolveCreatedBy(req));
  await log(req, "ORDER_CREATED", o, `${describe(o)} saved as draft`);
  ok(res, shaped(o), 201);
});

exports.update = catchAsync(async (req, res) => {
  const o = await TradeOrderService.update(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "ORDER_UPDATED", o, `${describe(o)} edited`);
  ok(res, shaped(o));
});

exports.remove = catchAsync(async (req, res) => {
  const removed = await TradeOrderService.remove(req.params.id, resolveCreatedBy(req));
  await AuditService.log({ req, action: "ORDER_DELETED", entity: "TradeOrder", entityId: req.params.id, summary: `${removed.kind === "sales" ? "Sales order" : "Purchase order"} ${removed.orderNo} deleted`, before: removed });
  res.status(204).end();
});

const transition = (name, action, text) =>
  catchAsync(async (req, res) => {
    const o = await TradeOrderService[name](req.params.id, req.body, resolveCreatedBy(req));
    await log(req, action, o, `${describe(o)} ${text}${req.body?.reason ? `: ${String(req.body.reason).slice(0, 200)}` : ""}`);
    ok(res, shaped(o));
  });

exports.confirm = transition("confirm", "ORDER_CONFIRMED", "confirmed");
exports.cancel = transition("cancel", "ORDER_CANCELLED", "cancelled");
exports.close = transition("close", "ORDER_CLOSED", "closed");
exports.reopen = transition("reopen", "ORDER_REOPENED", "reopened");
