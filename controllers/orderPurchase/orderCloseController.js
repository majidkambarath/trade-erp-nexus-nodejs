const OrderCloseService = require("../../services/orderPurchase/orderCloseService");
const DocumentAuditService = require("../../services/orderPurchase/documentAuditService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const resolveCreatedBy = (req) => req.admin?.id || req.user?.id || "system";
const ok = (res, data) => res.status(200).json({ success: true, data });

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const left = (lines) => lines.map((l) => `${l.short} x ${l.description}`).join(", ");

// The order as the deal screen needs it back: what was stored, without the copy kept for reopening.
const present = (order) => {
  const o = order.toObject();
  if (o.closedShort) delete o.closedShort.original;
  return o;
};

exports.preview = catchAsync(async (req, res) => ok(res, await OrderCloseService.preview(req.params.id)));

exports.closeShort = catchAsync(async (req, res) => {
  const order = await OrderCloseService.closeShort(req.params.id, req.body, resolveCreatedBy(req));
  const c = order.closedShort;
  await AuditService.log({
    req,
    action: "TRANSACTION_CLOSED_SHORT",
    entity: "Transaction",
    entityId: order._id,
    summary: `${DocumentAuditService.describe(order)} closed short: ${left(c.lines)} not delivered (${money(c.valueShort)}). Reason: ${c.reason}`,
    after: { ...DocumentAuditService.snapshot(order), closedShort: { reason: c.reason, trimmed: c.trimmed, valueShort: c.valueShort, lines: c.lines } },
  });
  ok(res, present(order));
});

exports.reopen = catchAsync(async (req, res) => {
  const order = await OrderCloseService.reopen(req.params.id, resolveCreatedBy(req));
  await AuditService.log({
    req,
    action: "TRANSACTION_REOPENED",
    entity: "Transaction",
    entityId: order._id,
    summary: `${DocumentAuditService.describe(order)} reopened: no longer closed short`,
    after: DocumentAuditService.snapshot(order),
  });
  ok(res, present(order));
});
