const RecurringInvoiceService = require("../../services/orderPurchase/recurringInvoiceService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const snapshot = (t) => ({
  name: t.name, partyId: t.partyId, frequency: t.frequency, interval: t.interval, startDay: t.startDay, endDay: t.endDay || null,
  maxCount: t.maxCount || null, status: t.status, nextRunDay: t.nextRunDay, totalAmount: t.totalAmount, lines: t.items?.length || 0,
});
const log = (req, action, t, summary) =>
  AuditService.log({ req, action, entity: "RecurringInvoice", entityId: t._id, summary, after: snapshot(t) });

exports.list = catchAsync(async (req, res) => ok(res, await RecurringInvoiceService.list(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await RecurringInvoiceService.getById(req.params.id)));
exports.preview = catchAsync(async (req, res) => ok(res, RecurringInvoiceService.preview(req.query)));

exports.create = catchAsync(async (req, res) => {
  const t = await RecurringInvoiceService.create(req.body, by(req));
  await log(req, "RECURRING_INVOICE_CREATED", t, `Recurring invoice ${t.name} set up (${t.frequency}, first ${t.startDay})`);
  ok(res, RecurringInvoiceService.present(t), 201);
});

exports.update = catchAsync(async (req, res) => {
  const t = await RecurringInvoiceService.update(req.params.id, req.body, by(req));
  await log(req, "RECURRING_INVOICE_UPDATED", t, `Recurring invoice ${t.name} changed`);
  ok(res, RecurringInvoiceService.present(t));
});

exports.pause = catchAsync(async (req, res) => {
  const t = await RecurringInvoiceService.pause(req.params.id, by(req));
  await log(req, "RECURRING_INVOICE_PAUSED", t, `Recurring invoice ${t.name} paused`);
  ok(res, RecurringInvoiceService.present(t));
});

exports.resume = catchAsync(async (req, res) => {
  const t = await RecurringInvoiceService.resume(req.params.id, by(req));
  await log(req, "RECURRING_INVOICE_RESUMED", t, `Recurring invoice ${t.name} resumed, next ${t.nextRunDay || "none"}`);
  ok(res, RecurringInvoiceService.present(t));
});

exports.run = catchAsync(async (req, res) => {
  const { invoice, day } = await RecurringInvoiceService.runNow(req.params.id, by(req));
  ok(res, { invoice: { _id: invoice._id, transactionNo: invoice.transactionNo, totalAmount: invoice.totalAmount, status: invoice.status }, day }, 201);
});

exports.remove = catchAsync(async (req, res) => {
  const t = await RecurringInvoiceService.remove(req.params.id);
  await AuditService.log({ req, action: "RECURRING_INVOICE_DELETED", entity: "RecurringInvoice", entityId: t._id, summary: `Recurring invoice ${t.name} deleted`, before: snapshot(t) });
  res.status(204).end();
});
