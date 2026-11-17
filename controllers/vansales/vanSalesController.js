const AppError = require("../../utils/AppError");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");
const AuditService = require("../../services/core/auditService");
const VanService = require("../../services/vansales/vanService");
const VanTripService = require("../../services/vansales/vanTripService");
const VanTripSales = require("../../services/vansales/vanTripSales");
const VanTripSettlement = require("../../services/vansales/vanTripSettlement");
const VanSalesReportService = require("../../services/vansales/vanSalesReportService");
const { loadTrip } = require("../../services/vansales/vanTripStock");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const holds = (req, key) => roles.can(req.admin?.grants, key);
const log = (req, action, trip, summary, extra = {}) =>
  AuditService.log({ req, action, entity: "VanTrip", entityId: trip._id, summary, after: { tripNo: trip.tripNo, status: trip.status, vanCode: trip.vanCode, ...extra } });

// The salesman's own trip: whoever manages or settles van sales may act on any trip, a salesman only on the one the
// trip names them for - the same shape as a process step's assignee and a garage technician's task. A salesman with no
// other permission must still be able to work their own van.
async function assertMayWork(req, { loaderToo = false } = {}) {
  if (holds(req, "vansales.manage") || holds(req, "vansales.settle") || (loaderToo && holds(req, "vansales.load"))) return;
  const trip = await loadTrip(req.params.tripId);
  if (String(trip.salesmanId) !== String(req.admin?.id)) {
    throw new AppError("Only the salesman this trip is given to, or someone who manages the vans, can do this", 403, "PERMISSION_DENIED", { required: ["vansales.manage"] });
  }
}

// Pressing on past a credit warning is its own right, as it is on the invoice screen (transactionController.js).
function assertMayAcknowledge(req) {
  if (req.body?.acknowledged && !holds(req, "sales.creditOverride") && !holds(req, "vansales.manage")) {
    throw new AppError("Your role does not allow you to sell past a customer's credit limit.", 403, "PERMISSION_DENIED", { required: ["sales.creditOverride"], role: req.admin?.role?.key || null });
  }
}

// ---- vans and routes -----------------------------------------------------------------------------------------
exports.listVans = catchAsync(async (req, res) => ok(res, await VanService.list({ includeInactive: req.query.all === "1" })));
exports.getVan = catchAsync(async (req, res) => ok(res, await VanService.get(req.params.vanId)));
exports.createVan = catchAsync(async (req, res) => {
  const v = await VanService.create(req.body || {}, by(req), req);
  await AuditService.log({ req, action: "VAN_CREATED", entity: "Van", entityId: v.id, summary: `Van ${v.code} ${v.name} added` });
  ok(res, v, 201);
});
exports.updateVan = catchAsync(async (req, res) => {
  const v = await VanService.update(req.params.vanId, req.body || {}, by(req));
  await AuditService.log({ req, action: "VAN_UPDATED", entity: "Van", entityId: v.id, summary: `Van ${v.code} changed` });
  ok(res, v);
});
exports.listRoutes = catchAsync(async (req, res) => ok(res, await VanService.listRoutes({ includeInactive: req.query.all === "1" })));
exports.getRoute = catchAsync(async (req, res) => ok(res, await VanService.getRoute(req.params.routeId)));
exports.createRoute = catchAsync(async (req, res) => {
  const r = await VanService.createRoute(req.body || {}, by(req));
  await AuditService.log({ req, action: "VAN_ROUTE_CREATED", entity: "VanRoute", entityId: r.id, summary: `Route ${r.name} added` });
  ok(res, r, 201);
});
exports.updateRoute = catchAsync(async (req, res) => {
  const r = await VanService.updateRoute(req.params.routeId, req.body || {}, by(req));
  await AuditService.log({ req, action: "VAN_ROUTE_UPDATED", entity: "VanRoute", entityId: r.id, summary: `Route ${r.name} changed` });
  ok(res, r);
});
exports.assignees = catchAsync(async (req, res) => ok(res, await VanService.assignees()));
exports.paymentChoices = catchAsync(async (req, res) => ok(res, await VanService.paymentChoices(req)));
exports.customers = catchAsync(async (req, res) => ok(res, await VanService.customerChoices(req.query)));

// ---- trips ---------------------------------------------------------------------------------------------------
exports.listTrips = catchAsync(async (req, res) => ok(res, await VanTripService.list(req.query)));
exports.mine = catchAsync(async (req, res) => ok(res, await VanTripService.mine(by(req))));
exports.getTrip = catchAsync(async (req, res) => ok(res, await VanTripService.getById(req.params.tripId)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "VanTrip", entityId: req.params.tripId, limit: 100 })));

exports.openTrip = catchAsync(async (req, res) => {
  const trip = await VanTripService.open(req.body || {}, by(req));
  await log(req, "VAN_TRIP_OPENED", trip, `Van trip ${trip.tripNo} opened for ${trip.vanCode}, ${trip.salesmanName}`);
  ok(res, await VanTripService.getById(trip._id), 201);
});
exports.load = catchAsync(async (req, res) => {
  const trip = await VanTripService.load(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req));
  const units = (req.body?.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
  await log(req, "VAN_LOADED", trip, `Van ${trip.vanCode} loaded: ${units} units on ${trip.tripNo}`, { load: trip.loads.length });
  ok(res, await VanTripService.getById(trip._id));
});
exports.depart = catchAsync(async (req, res) => {
  const trip = await VanTripService.depart(req.params.tripId, by(req));
  await log(req, "VAN_DEPARTED", trip, `Van ${trip.vanCode} sent out on ${trip.tripNo}`);
  ok(res, await VanTripService.getById(trip._id));
});
exports.cancel = catchAsync(async (req, res) => {
  const trip = await VanTripService.cancel(req.params.tripId, by(req));
  await log(req, "VAN_TRIP_CANCELLED", trip, `Van trip ${trip.tripNo} cancelled`);
  ok(res, await VanTripService.getById(trip._id));
});

exports.sell = catchAsync(async (req, res) => {
  await assertMayWork(req);
  assertMayAcknowledge(req);
  const { invoice, receipt } = await VanTripSales.sell(req.params.tripId, req.body || {}, by(req), { req });
  await AuditService.log({ req, action: "VAN_SALE", entity: "VanTrip", entityId: req.params.tripId, summary: `${invoice.transactionNo} sold on the van${receipt ? `, ${receipt.voucherNo} received` : ""}`, after: { invoice: invoice.transactionNo } });
  ok(res, { invoice, receipt, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.collect = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { receipt } = await VanTripSales.collect(req.params.tripId, req.body || {}, by(req), { req });
  await AuditService.log({ req, action: "VAN_COLLECTION", entity: "VanTrip", entityId: req.params.tripId, summary: `${receipt.voucherNo} taken on the van (${receipt.paymentMode})`, after: { voucher: receipt.voucherNo } });
  ok(res, { receipt, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.returnGoods = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { creditNote } = await VanTripSales.returnGoods(req.params.tripId, req.body || {}, by(req), { req });
  await AuditService.log({ req, action: "VAN_RETURN", entity: "VanTrip", entityId: req.params.tripId, summary: `${creditNote.transactionNo} taken back on the van`, after: { return: creditNote.transactionNo } });
  ok(res, { creditNote, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.customerPosition = catchAsync(async (req, res) => ok(res, await VanTripSales.customerPosition(req.params.customerId)));
exports.returnable = catchAsync(async (req, res) => ok(res, await VanTripSales.returnable(req.params.invoiceId)));

exports.unload = catchAsync(async (req, res) => {
  await assertMayWork(req, { loaderToo: true });
  const trip = await VanTripSettlement.unload(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req));
  await log(req, "VAN_UNLOADED", trip, `Van ${trip.vanCode} counted back in on ${trip.tripNo}`);
  ok(res, await VanTripService.getById(trip._id));
});
exports.settlementPreview = catchAsync(async (req, res) => ok(res, await VanTripSettlement.preview(req.params.tripId, { ...req.query, chequesHanded: req.query.chequesHanded ? String(req.query.chequesHanded).split(",") : undefined }, { req })));
exports.settle = catchAsync(async (req, res) => {
  const { trip, plan } = await VanTripSettlement.settle(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req), { req });
  await log(req, "VAN_SETTLED", trip, `Van trip ${trip.tripNo} settled: cash ${plan.cash.handed.toFixed(2)} of ${plan.cash.expected.toFixed(2)}`, { cashVariance: plan.cash.variance, stockVarianceValue: plan.stockVarianceValue });
  ok(res, { trip: await VanTripService.getById(trip._id), plan });
});

exports.summary = catchAsync(async (req, res) => ok(res, await VanSalesReportService.summary(req.query)));
