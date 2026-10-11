const GoodsReceiptService = require("../../services/orderPurchase/goodsReceiptService");
const DocumentAuditService = require("../../services/orderPurchase/documentAuditService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const resolveCreatedBy = (req) => req.admin?.id || req.user?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const describe = (g) => `Goods receipt ${g.receiptNo} - ${money(g.totalAmount)}`;
const snapshot = (g) => ({
  receiptNo: g.receiptNo, status: g.status, invoiceStatus: g.invoiceStatus, partyId: g.partyId, date: g.date,
  source: g.source, invoice: g.invoice || null, totalAmount: g.totalAmount, lines: g.items?.length || 0,
  receivedAt: g.receivedAt, receivedBy: g.receivedBy, vendorDeliveryNo: g.vendorDeliveryNo || null,
});
const log = (req, action, g, summary) => AuditService.log({ req, action, entity: "GoodsReceipt", entityId: g._id, summary, after: snapshot(g) });

exports.list = catchAsync(async (req, res) => {
  const { rows, pagination } = await GoodsReceiptService.list(req.query);
  res.status(200).json({ success: true, data: rows, pagination });
});
exports.summary = catchAsync(async (req, res) => ok(res, await GoodsReceiptService.summary()));
exports.fromOrder = catchAsync(async (req, res) => ok(res, await GoodsReceiptService.prefillFromOrder(req.params.orderId)));
exports.get = catchAsync(async (req, res) => ok(res, await GoodsReceiptService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "GoodsReceipt", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const g = await GoodsReceiptService.create(req.body, resolveCreatedBy(req));
  await log(req, "GOODS_RECEIPT_CREATED", g, `${describe(g)} saved as draft${g.source?.no ? `, against ${g.source.no}` : ""}`);
  ok(res, GoodsReceiptService.present(g.toObject()), 201);
});

exports.update = catchAsync(async (req, res) => {
  const g = await GoodsReceiptService.update(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "GOODS_RECEIPT_UPDATED", g, `${describe(g)} edited`);
  ok(res, GoodsReceiptService.present(g.toObject()));
});

exports.remove = catchAsync(async (req, res) => {
  const removed = await GoodsReceiptService.remove(req.params.id, resolveCreatedBy(req));
  await AuditService.log({ req, action: "GOODS_RECEIPT_DELETED", entity: "GoodsReceipt", entityId: req.params.id, summary: `Goods receipt ${removed.receiptNo} deleted`, before: removed });
  res.status(204).end();
});

exports.receive = catchAsync(async (req, res) => {
  const g = await GoodsReceiptService.receive(req.params.id, req.body, resolveCreatedBy(req));
  const short = g.items.filter((l) => (l.receivedQty ?? l.qty) < l.qty).length;
  await log(req, "GOODS_RECEIPT_RECEIVED", g, `${describe(g)} received by ${g.receivedBy}${short ? `, ${short} line${short === 1 ? "" : "s"} short` : ""}`);
  ok(res, GoodsReceiptService.present(g.toObject()));
});

exports.cancel = catchAsync(async (req, res) => {
  const g = await GoodsReceiptService.cancel(req.params.id, req.body, resolveCreatedBy(req));
  await log(req, "GOODS_RECEIPT_CANCELLED", g, `${describe(g)} cancelled${g.cancelReason ? ` - ${g.cancelReason}` : ""}`);
  ok(res, GoodsReceiptService.present(g.toObject()));
});

exports.invoice = catchAsync(async (req, res) => {
  const { purchaseInvoice, goodsReceipts } = await GoodsReceiptService.createInvoice(req.body, resolveCreatedBy(req));
  const nos = goodsReceipts.map((g) => g.receiptNo).join(", ");
  await AuditService.log({
    req, action: "TRANSACTION_CREATED", entity: "Transaction", entityId: purchaseInvoice._id,
    summary: `${DocumentAuditService.describe(purchaseInvoice)} saved as ${purchaseInvoice.status}, from goods received ${nos}`,
    after: DocumentAuditService.snapshot(purchaseInvoice),
  });
  for (const g of goodsReceipts) await log(req, "GOODS_RECEIPT_INVOICED", g, `${describe(g)} put on purchase invoice ${purchaseInvoice.transactionNo}`);
  ok(res, { purchaseInvoice, goodsReceipts: goodsReceipts.map((g) => GoodsReceiptService.present(g.toObject())) }, 201);
});
