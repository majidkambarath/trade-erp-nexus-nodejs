const DeliveryNoteService = require("../../services/orderPurchase/deliveryNoteService");
const DocumentAuditService = require("../../services/orderPurchase/documentAuditService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const resolveCreatedBy = (req) => req.admin?.id || req.user?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const describe = (d) => `Delivery note ${d.deliveryNoteNo} - ${money(d.totalAmount)}`;
const snapshot = (d) => ({
  deliveryNoteNo: d.deliveryNoteNo, status: d.status, invoiceStatus: d.invoiceStatus, partyId: d.partyId, date: d.date,
  source: d.source, invoice: d.invoice || null, totalAmount: d.totalAmount, lines: d.items?.length || 0,
  deliveredAt: d.deliveredAt, receivedBy: d.receivedBy,
});

const log = (req, action, d, summary) =>
  AuditService.log({ req, action, entity: "DeliveryNote", entityId: d._id, summary, after: snapshot(d) });

exports.list = catchAsync(async (req, res) => {
  const { rows, pagination } = await DeliveryNoteService.list(req.query);
  res.status(200).json({ success: true, data: rows, pagination });
});

exports.summary = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.summary()));
exports.uninvoiced = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.uninvoiced({ partyId: req.query.partyId })));
exports.availability = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.availability(req.query.itemIds, { excludeId: req.query.excludeId })));
exports.fromOrder = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.prefillFromOrder(req.params.orderId)));
exports.get = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.getById(req.params.id)));
exports.pickList = catchAsync(async (req, res) => ok(res, await DeliveryNoteService.pickList(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "DeliveryNote", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const d = await DeliveryNoteService.create(req.body, resolveCreatedBy(req));
  await log(req, "DELIVERY_NOTE_CREATED", d, `${describe(d)} saved as draft${d.source?.no ? `, against ${d.source.no}` : ""}`);
  ok(res, DeliveryNoteService.present(d.toObject()), 201);
});

exports.update = catchAsync(async (req, res) => {
  const d = await DeliveryNoteService.update(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "DELIVERY_NOTE_UPDATED", d, `${describe(d)} edited`);
  ok(res, DeliveryNoteService.present(d.toObject()));
});

exports.remove = catchAsync(async (req, res) => {
  const removed = await DeliveryNoteService.remove(req.params.id, resolveCreatedBy(req));
  await AuditService.log({ req, action: "DELIVERY_NOTE_DELETED", entity: "DeliveryNote", entityId: req.params.id, summary: `Delivery note ${removed.deliveryNoteNo} deleted`, before: removed });
  res.status(204).end();
});

exports.dispatch = catchAsync(async (req, res) => {
  const d = await DeliveryNoteService.dispatch(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "DELIVERY_NOTE_DISPATCHED", d, `${describe(d)} dispatched${d.vehicleNo ? ` on ${d.vehicleNo}` : ""}${d.driverName ? ` with ${d.driverName}` : ""}`);
  ok(res, DeliveryNoteService.present(d.toObject()));
});

exports.deliver = catchAsync(async (req, res) => {
  const d = await DeliveryNoteService.deliver(req.params.id, req.body, resolveCreatedBy(req));
  const short = d.items.filter((l) => (l.deliveredQty ?? l.qty) < l.qty).length;
  await log(req, "DELIVERY_NOTE_DELIVERED", d, `${describe(d)} delivered, received by ${d.receivedBy}${short ? `, ${short} line${short === 1 ? "" : "s"} short` : ""}`);
  ok(res, DeliveryNoteService.present(d.toObject()));
});

exports.cancel = catchAsync(async (req, res) => {
  const d = await DeliveryNoteService.cancel(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "DELIVERY_NOTE_CANCELLED", d, `${describe(d)} cancelled${d.cancelReason ? ` - ${d.cancelReason}` : ""}`);
  ok(res, DeliveryNoteService.present(d.toObject()));
});

exports.invoice = catchAsync(async (req, res) => {
  const { salesOrder, deliveryNotes } = await DeliveryNoteService.createInvoice(req.body, resolveCreatedBy(req));
  const nos = deliveryNotes.map((n) => n.deliveryNoteNo).join(", ");
  await AuditService.log({
    req, action: "TRANSACTION_CREATED", entity: "Transaction", entityId: salesOrder._id,
    summary: `${DocumentAuditService.describe(salesOrder)} saved as ${salesOrder.status}, from delivery notes ${nos}`,
    after: DocumentAuditService.snapshot(salesOrder),
  });
  for (const n of deliveryNotes) await log(req, "DELIVERY_NOTE_INVOICED", n, `${describe(n)} put on sales order ${salesOrder.transactionNo}`);
  ok(res, { salesOrder, deliveryNotes: deliveryNotes.map((n) => DeliveryNoteService.present(n.toObject())) }, 201);
});
