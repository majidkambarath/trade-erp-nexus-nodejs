const QuotationService = require("../../services/orderPurchase/quotationService");
const DeliveryNoteService = require("../../services/orderPurchase/deliveryNoteService");
const DocumentAuditService = require("../../services/orderPurchase/documentAuditService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const resolveCreatedBy = (req) => req.admin?.id || req.user?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const describe = (q) => `Quotation ${q.quotationNo} - ${money(q.totalAmount)}`;
const snapshot = (q) => ({
  quotationNo: q.quotationNo, status: q.status, partyId: q.partyId, date: q.date, validUntil: q.validUntil,
  totalAmount: q.totalAmount, lines: q.items?.length || 0, convertedTo: q.convertedTo || null,
});

const log = (req, action, q, summary, extra = {}) =>
  AuditService.log({ req, action, entity: "Quotation", entityId: q._id, summary: summary || `${describe(q)} ${action.replace("QUOTATION_", "").toLowerCase()}`, after: snapshot(q), ...extra });

exports.list = catchAsync(async (req, res) => {
  const { rows, pagination } = await QuotationService.list(req.query);
  res.status(200).json({ success: true, data: rows, pagination });
});

exports.summary = catchAsync(async (req, res) => ok(res, await QuotationService.summary()));

exports.get = catchAsync(async (req, res) => ok(res, await QuotationService.getById(req.params.id)));

exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "Quotation", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const q = await QuotationService.create(req.body, resolveCreatedBy(req));
  await log(req, "QUOTATION_CREATED", q, `${describe(q)} saved as draft`);
  ok(res, QuotationService.present(q.toObject()), 201);
});

exports.update = catchAsync(async (req, res) => {
  const q = await QuotationService.update(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "QUOTATION_UPDATED", q, `${describe(q)} edited`);
  ok(res, QuotationService.present(q.toObject()));
});

exports.remove = catchAsync(async (req, res) => {
  const removed = await QuotationService.remove(req.params.id, resolveCreatedBy(req));
  await AuditService.log({ req, action: "QUOTATION_DELETED", entity: "Quotation", entityId: req.params.id, summary: `Quotation ${removed.quotationNo} deleted`, before: removed });
  res.status(204).end();
});

const transition = (action, past) =>
  catchAsync(async (req, res) => {
    const q = await QuotationService.transition(req.params.id, action, req.body, resolveCreatedBy(req));
    await log(req, `QUOTATION_${past.toUpperCase()}`, q, `${describe(q)} ${past}${action === "reject" && q.rejectionReason ? ` - ${q.rejectionReason}` : ""}`);
    ok(res, QuotationService.present(q.toObject()));
  });
exports.send = transition("send", "sent");
exports.accept = transition("accept", "accepted");
exports.reject = transition("reject", "rejected");

exports.revise = catchAsync(async (req, res) => {
  const { revision, superseded } = await QuotationService.revise(req.params.id, resolveCreatedBy(req));
  await log(req, "QUOTATION_REVISED", revision, `${describe(revision)} created as a revision of ${superseded.quotationNo}`);
  ok(res, QuotationService.present(revision.toObject()), 201);
});

// The order is a sales order in its own right, so it gets the audit row any sales order gets.
exports.convert = catchAsync(async (req, res) => {
  const { quotation, salesOrder } = await QuotationService.convertToSalesOrder(req.params.id, req.body, resolveCreatedBy(req));
  await AuditService.log({
    req, action: "TRANSACTION_CREATED", entity: "Transaction", entityId: salesOrder._id,
    summary: `${DocumentAuditService.describe(salesOrder)} saved as ${salesOrder.status}, from quotation ${quotation.quotationNo}`,
    after: DocumentAuditService.snapshot(salesOrder),
  });
  await log(req, "QUOTATION_CONVERTED", quotation, `${describe(quotation)} converted to sales order ${salesOrder.transactionNo}`);
  ok(res, { quotation: QuotationService.present(quotation.toObject()), salesOrder }, 201);
});

exports.toDeliveryNote = catchAsync(async (req, res) => {
  const { quotation, deliveryNote } = await DeliveryNoteService.createFromQuotation(req.params.id, req.body, resolveCreatedBy(req));
  await AuditService.log({
    req, action: "DELIVERY_NOTE_CREATED", entity: "DeliveryNote", entityId: deliveryNote._id,
    summary: `Delivery note ${deliveryNote.deliveryNoteNo} saved as draft, from quotation ${quotation.quotationNo}`,
    after: { deliveryNoteNo: deliveryNote.deliveryNoteNo, status: deliveryNote.status, source: deliveryNote.source },
  });
  await log(req, "QUOTATION_CONVERTED", quotation, `${describe(quotation)} converted to delivery note ${deliveryNote.deliveryNoteNo}`);
  ok(res, { quotation: QuotationService.present(quotation.toObject()), deliveryNote: DeliveryNoteService.present(deliveryNote.toObject()) }, 201);
});
