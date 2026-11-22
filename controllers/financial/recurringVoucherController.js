const RecurringVoucherService = require("../../services/financial/recurringVoucherService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const snapshot = (t) => ({
  name: t.name, kind: t.kind, frequency: t.frequency, interval: t.interval, startDay: t.startDay, endDay: t.endDay || null,
  maxCount: t.maxCount || null, status: t.status, nextRunDay: t.nextRunDay, totalAmount: t.totalAmount, lines: t.lines?.length || 0,
});
const log = (req, action, t, summary) => AuditService.log({ req, action, entity: "RecurringVoucher", entityId: t._id, summary, after: snapshot(t) });

exports.list = catchAsync(async (req, res) => ok(res, await RecurringVoucherService.list(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await RecurringVoucherService.getById(req.params.id)));
exports.preview = catchAsync(async (req, res) => ok(res, RecurringVoucherService.preview(req.query)));

exports.create = catchAsync(async (req, res) => {
  const t = await RecurringVoucherService.create(req.body, by(req));
  await log(req, "RECURRING_VOUCHER_CREATED", t, `Recurring ${t.kind} voucher ${t.name} set up (${t.frequency}, first ${t.startDay})`);
  ok(res, RecurringVoucherService.present(t), 201);
});

exports.update = catchAsync(async (req, res) => {
  const t = await RecurringVoucherService.update(req.params.id, req.body, by(req));
  await log(req, "RECURRING_VOUCHER_UPDATED", t, `Recurring voucher ${t.name} changed`);
  ok(res, RecurringVoucherService.present(t));
});

exports.pause = catchAsync(async (req, res) => {
  const t = await RecurringVoucherService.pause(req.params.id, by(req));
  await log(req, "RECURRING_VOUCHER_PAUSED", t, `Recurring voucher ${t.name} paused`);
  ok(res, RecurringVoucherService.present(t));
});

exports.resume = catchAsync(async (req, res) => {
  const t = await RecurringVoucherService.resume(req.params.id, by(req));
  await log(req, "RECURRING_VOUCHER_RESUMED", t, `Recurring voucher ${t.name} resumed, next ${t.nextRunDay || "none"}`);
  ok(res, RecurringVoucherService.present(t));
});

exports.run = catchAsync(async (req, res) => {
  const { voucher, day } = await RecurringVoucherService.runNow(req.params.id);
  ok(res, { voucher: { _id: voucher._id, voucherNo: voucher.voucherNo, totalAmount: voucher.totalAmount, status: voucher.status }, day }, 201);
});

exports.remove = catchAsync(async (req, res) => {
  const t = await RecurringVoucherService.remove(req.params.id);
  await AuditService.log({ req, action: "RECURRING_VOUCHER_DELETED", entity: "RecurringVoucher", entityId: t._id, summary: `Recurring voucher ${t.name} deleted`, before: snapshot(t) });
  res.status(204).end();
});
