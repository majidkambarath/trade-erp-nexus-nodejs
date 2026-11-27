const AppError = require("../../utils/AppError");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");
const AuditService = require("../../services/core/auditService");
const VanService = require("../../services/vansales/vanService");
const VanTripService = require("../../services/vansales/vanTripService");
const VanTripSales = require("../../services/vansales/vanTripSales");
const VanTripSettlement = require("../../services/vansales/vanTripSettlement");
const VanSalesReportService = require("../../services/vansales/vanSalesReportService");
const VanVisitService = require("../../services/vansales/vanVisitService");
const PriceListService = require("../../services/vansales/priceListService");
const { loadTrip } = require("../../services/vansales/vanTripStock");
const VanCrmService = require("../../services/vansales/vanCrmService");
const VanSettingsService = require("../../services/vansales/vanSettingsService");
const VanSlipService = require("../../services/vansales/vanSlipService");
const logger = require("../../utils/logger");
const vanRules = require("../../utils/vanSales");

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

// A salesman (sells, and holds nothing else in van sales) reads only his own: another salesman's trip or van answers as
// if it did not exist, the way another organisation's record does, and lists and reports hold only his.
const sellerOnly = (req) => vanRules.isSellerOnly(req.admin?.grants);
const ownerFilter = (req) => (sellerOnly(req) ? String(req.admin?.id) : null);
async function assertOwnTripIfSeller(req) {
  if (!sellerOnly(req)) return;
  const trip = await loadTrip(req.params.tripId);
  if (String(trip.salesmanId) !== String(req.admin?.id)) throw new AppError("That van trip does not exist", 404, "TRIP_NOT_FOUND");
}

// Pressing on past a credit warning is its own right, as it is on the invoice screen (transactionController.js).
function assertMayAcknowledge(req) {
  if (req.body?.acknowledged && !holds(req, "sales.creditOverride") && !holds(req, "vansales.manage")) {
    throw new AppError("Your role does not allow you to sell past a customer's credit limit.", 403, "PERMISSION_DENIED", { required: ["sales.creditOverride"], role: req.admin?.role?.key || null });
  }
}

// ---- vans and routes -----------------------------------------------------------------------------------------
exports.listVans = catchAsync(async (req, res) => ok(res, await VanService.list({ includeInactive: req.query.all === "1", onlySalesman: ownerFilter(req) })));
exports.getVan = catchAsync(async (req, res) => {
  const van = await VanService.get(req.params.vanId);
  if (sellerOnly(req) && String(van.salesmanId) !== String(req.admin?.id)) throw new AppError("That van does not exist", 404, "VAN_NOT_FOUND");
  ok(res, van);
});
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
exports.cardMachines = catchAsync(async (req, res) => ok(res, await VanService.cardMachines(req)));
exports.customers = catchAsync(async (req, res) => ok(res, await VanService.customerChoices(req.query)));
exports.vanChoices = catchAsync(async (req, res) => ok(res, await require("../../services/vansales/vanExpenseTagService").choices()));

// ---- the organisation's rules for its vans ---------------------------------------------------------------------
exports.getSettings = catchAsync(async (req, res) => ok(res, await VanSettingsService.settings()));
exports.saveSettings = catchAsync(async (req, res) => {
  const before = await VanSettingsService.settings();
  const after = await VanSettingsService.save(req.body);
  await AuditService.log({ req, action: "VAN_SALES_SETTINGS_SAVED", entity: "CompanySettings", summary: "Van sales rules changed", before, after });
  ok(res, after);
});

// ---- trips ---------------------------------------------------------------------------------------------------
exports.listTrips = catchAsync(async (req, res) => ok(res, await VanTripService.list(sellerOnly(req) ? { ...req.query, salesmanId: ownerFilter(req) } : req.query)));
exports.mine = catchAsync(async (req, res) => ok(res, await VanTripService.mine(by(req))));
exports.getTrip = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await VanTripService.getById(req.params.tripId));
});
exports.activity = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await AuditService.list(req, { entity: "VanTrip", entityId: req.params.tripId, limit: 100 }));
});

// Where loads go through a request, a salesman opens his OWN van's trip to ask for his load; nobody else's, and only then.
async function assertMayOpen(req) {
  if (holds(req, "vansales.load")) return;
  const Van = require("../../models/modules/vansales/vanModel");
  const van = require("mongoose").isValidObjectId(req.body?.vanId) ? await Van.findById(req.body.vanId).select("salesmanId rules").lean() : null;
  const ownVan = van && String(van.salesmanId) === String(req.admin?.id);
  const asks = van && (await VanSettingsService.forVan(van)).loadRequests;
  if (!ownVan || !asks || (req.body?.salesmanId && String(req.body.salesmanId) !== String(req.admin?.id))) {
    throw new AppError("Only the storekeeper or a supervisor opens a trip, except a salesman asking for the load of the van they drive", 403, "PERMISSION_DENIED", { required: ["vansales.load"] });
  }
}

exports.openTrip = catchAsync(async (req, res) => {
  await assertMayOpen(req);
  const trip = await VanTripService.open(req.body || {}, by(req));
  await log(req, "VAN_TRIP_OPENED", trip, `Van trip ${trip.tripNo} opened for ${trip.vanCode}, ${trip.salesmanName}`);
  ok(res, await VanTripService.getById(trip._id), 201);
});
exports.load = catchAsync(async (req, res) => {
  await require("../../services/vansales/vanPlanningService").assertExpiryOk(req.params.tripId, { lines: (req.body?.lines || []).map((l) => ({ stockId: l?.stockId, qty: l?.qty })) }, { mayOverride: holds(req, "vansales.manage") });
  const trip =await VanTripService.load(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req));
  const units = (req.body?.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
  await log(req, "VAN_LOADED", trip, `Van ${trip.vanCode} loaded: ${units} units on ${trip.tripNo}`, { load: trip.loads.length });
  ok(res, await VanTripService.getById(trip._id));
});
// ---- load requests: the salesman asks, the storekeeper loads, the salesman accepts the count ---------------------
const LoadRequests = () => require("../../services/vansales/vanLoadRequestService");
const units = (lines, key) => (lines || []).reduce((n, l) => n + (Number(l[key]) || 0), 0);
exports.listLoadRequests = catchAsync(async (req, res) => ok(res, await LoadRequests().waiting()));
exports.loadRequestCounts = catchAsync(async (req, res) => ok(res, await LoadRequests().counts(by(req), { mayLoad: holds(req, "vansales.load") })));
exports.requestLoad = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { trip, request } = await LoadRequests().request(req.params.tripId, req.body || {}, by(req), { byName: req.admin?.name });
  await log(req, "VAN_LOAD_REQUESTED", trip, `Load request ${request.no} on ${trip.tripNo}: ${units(request.lines, "requested")} units asked for`, { requestNo: request.no });
  ok(res, { request, trip: await VanTripService.getById(trip._id) }, 201);
});
exports.cancelLoadRequest = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { trip, request } = await LoadRequests().cancel(req.params.tripId, req.params.no, by(req), { byName: req.admin?.name, reason: req.body?.reason });
  await log(req, "VAN_LOAD_REQUEST_CANCELLED", trip, `Load request ${request.no} on ${trip.tripNo} cancelled`, { requestNo: request.no });
  ok(res, { request, trip: await VanTripService.getById(trip._id) });
});
exports.rejectLoadRequest = catchAsync(async (req, res) => {
  const { trip, request } = await LoadRequests().reject(req.params.tripId, req.params.no, req.body || {}, by(req), { byName: req.admin?.name });
  await log(req, "VAN_LOAD_REQUEST_REJECTED", trip, `Load request ${request.no} on ${trip.tripNo} refused: ${request.reason}`, { requestNo: request.no });
  ok(res, { request, trip: await VanTripService.getById(trip._id) });
});
exports.loadFromRequest = catchAsync(async (req, res) => {
  const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l) => Number(l?.qty) > 0).map((l) => ({ stockId: l?.stockId, qty: l?.qty }));
  if (lines.length) await require("../../services/vansales/vanPlanningService").assertExpiryOk(req.params.tripId, { lines }, { mayOverride: holds(req, "vansales.manage") });
  const { trip, request } = await LoadRequests().load(req.params.tripId, req.params.no, req.body || {}, by(req), { byName: req.admin?.name });
  await log(req, "VAN_LOAD_REQUEST_LOADED", trip, `Load request ${request.no} on ${trip.tripNo} loaded: ${units(request.lines, "loaded")} of ${units(request.lines, "requested")} units asked for`, { requestNo: request.no });
  ok(res, { request, trip: await VanTripService.getById(trip._id) });
});
exports.acceptLoad = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { trip, request, short } = await LoadRequests().accept(req.params.tripId, req.params.no, req.body || {}, by(req), { byName: req.admin?.name });
  const missing = short.reduce((n, l) => n + l.missing, 0);
  await log(req, "VAN_LOAD_ACCEPTED", trip, `Load request ${request.no} on ${trip.tripNo} accepted${missing ? `, ${missing} units short: ${request.reason}` : " in full"}`, { requestNo: request.no, short });
  ok(res, { request, short, trip: await VanTripService.getById(trip._id) });
});

exports.depart = catchAsync(async (req, res) => {
  const trip = await VanTripService.depart(req.params.tripId, by(req), { odometer: req.body?.odometer });
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
  await Containers().ensureAccount(req); // before the sale's transaction: a deposit needs its account
  const { invoice, receipt, containers, deposit, depositNote } = await VanTripSales.sell(req.params.tripId, req.body || {}, by(req), { req, mayUnderprice: holds(req, "vansales.manage") });
  await AuditService.log({ req, action: "VAN_SALE", entity: "VanTrip", entityId: req.params.tripId, summary: `${invoice.transactionNo} sold on the van${receipt ? `, ${receipt.voucherNo} ${receipt.status === "pending" ? "taken, waiting for the bank" : "received"} (${receipt.paymentMode})` : ""}${depositNote ? `, container deposit ${depositNote}` : ""}`, after: { invoice: invoice.transactionNo, ...(containers?.length ? { containers, deposit } : {}) } });
  // after the sale committed, never able to fail it: the call on the customer's CRM timeline
  await VanCrmService.record("sale", { tripId: req.params.tripId, customerId: invoice.partyId, refId: invoice._id, ref: invoice.transactionNo, total: invoice.totalAmount, by: by(req) });
  // the slip, read after the sale committed by the same function a reprint uses, so the two can never differ
  // (a failure here must not fail a sale that is already made: the slip can be printed again from the trip)
  const slip = await VanSlipService.forInvoice(req.params.tripId, invoice._id).catch((err) => {
    logger.warn(`Van slip for ${invoice.transactionNo} could not be read: ${err.message}`);
    return null;
  });
  ok(res, { invoice, receipt, containers, deposit, depositNote, slip, trip: await VanTripService.getById(req.params.tripId) }, 201);
});

// ---- the printed slip: any invoice sold on the trip, printed again ----------------------------------------------
exports.tripInvoices = catchAsync(async (req, res) => {
  await assertMayWork(req);
  ok(res, await VanSlipService.invoices(req.params.tripId));
});
exports.invoiceSlip = catchAsync(async (req, res) => {
  await assertMayWork(req);
  ok(res, await VanSlipService.forInvoice(req.params.tripId, req.params.invoiceId));
});

// ---- returnable containers (crates, bottles, cylinders) ----------------------------------------------------------
const Containers = () => require("../../services/vansales/vanContainerService");
exports.listContainerTypes = catchAsync(async (req, res) => ok(res, await Containers().types({ includeInactive: req.query.all === "1" })));
exports.createContainerType = catchAsync(async (req, res) => {
  const t = await Containers().create(req.body || {}, by(req));
  await AuditService.log({ req, action: "VAN_CONTAINER_TYPE_CREATED", entity: "ContainerType", entityId: t.id, summary: `Container ${t.code} ${t.name} added`, after: t });
  ok(res, t, 201);
});
exports.updateContainerType = catchAsync(async (req, res) => {
  const t = await Containers().update(req.params.typeId, req.body || {}, by(req));
  await AuditService.log({ req, action: "VAN_CONTAINER_TYPE_UPDATED", entity: "ContainerType", entityId: t.id, summary: `Container ${t.code} changed`, after: t });
  ok(res, t);
});
exports.customerContainers = catchAsync(async (req, res) => ok(res, await Containers().balances(req.params.customerId)));
exports.empties = catchAsync(async (req, res) => {
  await assertMayWork(req);
  await Containers().ensureAccount(req);
  const r = await Containers().empties(req.params.tripId, req.body || {}, by(req), { byName: req.admin?.name, mayOverride: holds(req, "vansales.manage") });
  const trip = await loadTrip(req.params.tripId);
  await log(req, "VAN_CONTAINERS_MOVED", trip, `Containers at a stop on ${trip.tripNo}${r.voucher ? `, deposit ${r.voucher.voucherNo}` : ""}`, { deposit: r.deposit });
  ok(res, { deposit: r.deposit, depositNote: r.voucher ? r.voucher.voucherNo : null, moves: r.moves.length, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.adjustContainers = catchAsync(async (req, res) => {
  const r = await Containers().adjust(req.body || {}, by(req), { byName: req.admin?.name });
  await AuditService.log({ req, action: "VAN_CONTAINERS_ADJUSTED", entity: "Customer", entityId: req.body?.customerId, summary: `Containers a customer holds set to ${r.holds}: ${String(req.body?.reason || "").slice(0, 120)}` });
  ok(res, { holds: r.holds, balances: await Containers().balances(req.body.customerId) });
});

exports.collect = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { receipt } = await VanTripSales.collect(req.params.tripId, req.body || {}, by(req), { req });
  await AuditService.log({ req, action: "VAN_COLLECTION", entity: "VanTrip", entityId: req.params.tripId, summary: `${receipt.voucherNo} taken on the van (${receipt.paymentMode})`, after: { voucher: receipt.voucherNo } });
  ok(res, { receipt, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.returnGoods = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const { creditNote } = await VanTripSales.returnGoods(req.params.tripId, req.body || {}, by(req), { req, mayUnderprice: holds(req, "vansales.manage") });
  const loose = !creditNote.returnOf?.transactionId;
  await AuditService.log({ req, action: "VAN_RETURN", entity: "VanTrip", entityId: req.params.tripId, summary: `${creditNote.transactionNo} taken back on the van${loose ? " without an invoice" : ""}`, after: { return: creditNote.transactionNo, withoutInvoice: loose, amount: creditNote.totalAmount } });
  ok(res, { creditNote, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.returnQuote = catchAsync(async (req, res) => {
  await assertMayWork(req);
  ok(res, await VanTripSales.returnQuote(req.params.tripId, req.body || {}, { mayUnderprice: holds(req, "vansales.manage") }));
});
exports.customerPosition = catchAsync(async (req, res) => ok(res, await VanTripSales.customerPosition(req.params.customerId)));
exports.returnable = catchAsync(async (req, res) => ok(res, await VanTripSales.returnable(req.params.invoiceId)));

exports.unload = catchAsync(async (req, res) => {
  await assertMayWork(req, { loaderToo: true });
  const trip = await VanTripSettlement.unload(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req));
  await log(req, "VAN_UNLOADED", trip, `Van ${trip.vanCode} counted back in on ${trip.tripNo}`);
  ok(res, await VanTripService.getById(trip._id));
});
exports.recount = catchAsync(async (req, res) => {
  const { trip, changed } = await VanTripSettlement.recount(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req));
  await log(req, "VAN_RECOUNTED", trip, `Van ${trip.vanCode} counted again on ${trip.tripNo}: ${changed.length ? changed.join("; ") : "no change"}`, { changed });
  ok(res, await VanTripService.getById(trip._id));
});
exports.settlementPreview = catchAsync(async (req, res) => ok(res, await VanTripSettlement.preview(req.params.tripId, { ...req.query, chequesHanded: req.query.chequesHanded !== undefined ? String(req.query.chequesHanded).split(",").filter(Boolean) : undefined }, { req })));
exports.settle = catchAsync(async (req, res) => {
  const { trip, plan } = await VanTripSettlement.settle(req.params.tripId, { ...(req.body || {}), byName: req.admin?.name }, by(req), { req });
  await log(req, "VAN_SETTLED", trip, `Van trip ${trip.tripNo} settled: cash ${plan.cash.handed.toFixed(2)} of ${plan.cash.expected.toFixed(2)}`, { cashVariance: plan.cash.variance, stockVarianceValue: plan.stockVarianceValue });
  ok(res, { trip: await VanTripService.getById(trip._id), plan });
});

// ---- visits, prices, transfers, price lists (phase 2) -----------------------------------------------------------
exports.recordVisit = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const v = await VanVisitService.record(req.params.tripId, req.body || {}, by(req), req.admin?.name);
  await VanCrmService.record("visit", { tripId: req.params.tripId, customerId: v.customerId, refId: v._id, reason: v.reason, note: v.note, by: by(req) });
  ok(res, { visit: v, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.visits = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await VanVisitService.forTrip(req.params.tripId));
});
exports.insight = catchAsync(async (req, res) => {
  await assertMayWork(req);
  ok(res, await VanTripSales.insight(req.params.tripId, req.params.customerId));
});
exports.prices = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await VanTripSales.prices(req.params.tripId, req.query.customerId));
});
exports.transfer = catchAsync(async (req, res) => {
  const { from, to } = await VanTripService.transfer(req.params.tripId, req.body || {}, by(req));
  const units = (req.body?.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
  await log(req, "VAN_TRANSFER", from, `${units} units handed from ${from.vanCode} (${from.tripNo}) to ${to.vanCode} (${to.tripNo})`, { to: to.tripNo });
  ok(res, { from: await VanTripService.getById(from._id), to: await VanTripService.getById(to._id) });
});
exports.listPriceLists = catchAsync(async (req, res) => ok(res, await PriceListService.list({ includeInactive: req.query.all === "1" })));
exports.getPriceList = catchAsync(async (req, res) => ok(res, await PriceListService.get(req.params.listId)));
exports.createPriceList = catchAsync(async (req, res) => {
  const l = await PriceListService.create(req.body || {}, by(req));
  await AuditService.log({ req, action: "PRICE_LIST_CREATED", entity: "PriceList", entityId: l.id, summary: `Price list ${l.name} added (${l.lines.length} prices)` });
  ok(res, l, 201);
});
exports.updatePriceList = catchAsync(async (req, res) => {
  const l = await PriceListService.update(req.params.listId, req.body || {}, by(req));
  await AuditService.log({ req, action: "PRICE_LIST_UPDATED", entity: "PriceList", entityId: l.id, summary: `Price list ${l.name} changed` });
  ok(res, l);
});

// Send the invoice to the customer on WhatsApp at the door. The messaging route asks for sales.send, which a van
// salesman need not hold; this narrow door lets them send THEIR OWN trip's invoices and nothing else, through the very
// same MessagingService.handoff (share link, history, the organisation's sending settings).
exports.whatsappInvoice = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const Transaction = require("../../models/modules/transactionModel");
  const MessagingService = require("../../services/messaging/messagingService");
  const inv = await Transaction.findById(req.params.invoiceId).select("type status vanTripRef transactionNo").lean().catch(() => null);
  if (!inv || inv.type !== "sales_order" || String(inv.vanTripRef?.tripId || "") !== String(req.params.tripId)) {
    throw new AppError("That invoice was not raised on this trip", 404, "INVOICE_NOT_ON_TRIP");
  }
  const r = await MessagingService.handoff({ docType: "tax_invoice", sourceId: String(inv._id), phone: req.body?.phone, note: req.body?.note }, req);
  await AuditService.log({ req, action: "VAN_INVOICE_SENT", entity: "VanTrip", entityId: req.params.tripId, summary: `${inv.transactionNo} handed to the customer on WhatsApp from the van` });
  ok(res, r);
});

// ---- working with no signal (phase 3) -----------------------------------------------------------------------
exports.offlinePack = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const extra = String(req.query.customers || "").split(",").filter(Boolean).slice(0, 100);
  ok(res, await VanTripSales.offlinePack(req.params.tripId, { extraCustomerIds: extra }));
});
exports.sync = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const acknowledging = (req.body?.ops || []).some((o) => o?.body?.acknowledged);
  if (acknowledging) assertMayAcknowledge({ ...req, body: { acknowledged: true } });
  const VanSyncService = require("../../services/vansales/vanSyncService");
  const out = await VanSyncService.sync(req.params.tripId, req.body?.ops, by(req), { req, mayUnderprice: holds(req, "vansales.manage"), byName: req.admin?.name });
  // what the phone did offline lands on the CRM timeline too, once (a repeat was written the first time it came in)
  const byClient = new Map((req.body?.ops || []).map((o) => [String(o?.clientId || ""), o]));
  for (const r of out.results.filter((x) => x.ok && !x.repeat)) {
    const op = byClient.get(r.clientId);
    if (op?.kind === "sell") await VanCrmService.record("sale", { tripId: req.params.tripId, customerId: op.body?.customerId, refId: r.result?.invoiceId, ref: r.result?.invoiceNo, total: r.result?.total, by: by(req) });
    if (op?.kind === "visit") await VanCrmService.record("visit", { tripId: req.params.tripId, customerId: op.body?.customerId, refId: r.result?.visitId, reason: op.body?.reason, note: op.body?.note, by: by(req) });
  }
  if (out.applied) await AuditService.log({ req, action: "VAN_SYNCED", entity: "VanTrip", entityId: req.params.tripId, summary: `${out.applied} done with no signal sent from the van${out.refused ? `, ${out.refused} refused` : ""}` });
  ok(res, { ...out, trip: await VanTripService.getById(req.params.tripId) });
});

exports.summary = catchAsync(async (req, res) => ok(res, await VanSalesReportService.summary({ from: req.query.from, to: req.query.to, onlySalesman: ownerFilter(req) })));

// ---- selling more (phase 4): promotions, pre-orders, the suggested load ----------------------------------------
const PromotionService = require("../../services/vansales/promotionService");
const VanPlanningService = require("../../services/vansales/vanPlanningService");

exports.listPromotions = catchAsync(async (req, res) => ok(res, await PromotionService.list({ includeInactive: req.query.all === "1" })));
exports.getPromotion = catchAsync(async (req, res) => ok(res, await PromotionService.get(req.params.promotionId)));
exports.createPromotion = catchAsync(async (req, res) => {
  const p = await PromotionService.create(req.body || {}, by(req));
  await AuditService.log({ req, action: "PROMOTION_CREATED", entity: "Promotion", entityId: p.id, summary: `Promotion ${p.name} added` });
  ok(res, p, 201);
});
exports.updatePromotion = catchAsync(async (req, res) => {
  const p = await PromotionService.update(req.params.promotionId, req.body || {}, by(req));
  await AuditService.log({ req, action: "PROMOTION_UPDATED", entity: "Promotion", entityId: p.id, summary: `Promotion ${p.name} changed` });
  ok(res, p);
});

exports.createPreorder = catchAsync(async (req, res) => {
  await assertMayWork(req);
  await VanTripSales.assertCustomerAllowed(req.params.tripId, req.body?.customerId, { mayOverride: holds(req, "vansales.manage") });
  const order = await VanPlanningService.createPreorder(req.params.tripId, { ...(req.body || {}), fromLink: false }, by(req));
  await AuditService.log({ req, action: "VAN_PREORDER", entity: "VanTrip", entityId: req.params.tripId, summary: `${order.orderNo} taken on the van for the next visit` });
  ok(res, order, 201);
});
exports.tripPreorders = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await VanPlanningService.preordersForTrip(req.params.tripId));
});
exports.routePreorders = catchAsync(async (req, res) => {
  // a salesman sees the orders of a route he is out on, not another's
  if (sellerOnly(req)) {
    const mine = await VanTripService.mine(String(req.admin?.id));
    if (!mine.some((t) => String(t.routeId) === String(req.params.routeId))) throw new AppError("That route does not exist", 404, "ROUTE_NOT_FOUND");
  }
  ok(res, await VanPlanningService.preordersForRoute(req.params.routeId, { customerId: req.query.customerId }));
});
// a salesman asking for his load may start from the suggestion, for his own van only
exports.suggestedLoad = catchAsync(async (req, res) => {
  if (!holds(req, "vansales.load")) await assertMayWork(req);
  ok(res, await VanPlanningService.suggestedLoad(req.params.tripId));
});
exports.loadCheck = catchAsync(async (req, res) => ok(res, await VanPlanningService.loadCheck(req.params.tripId, req.body || {})));

// ---- running the fleet (phase 5): the board, road expenses, pins, route profitability --------------------------
const VanFleetService = require("../../services/vansales/vanFleetService");

exports.board = catchAsync(async (req, res) => ok(res, await VanFleetService.board()));
exports.tripExpenses = catchAsync(async (req, res) => {
  await assertOwnTripIfSeller(req);
  ok(res, await VanFleetService.tripExpenses(req.params.tripId));
});
exports.expense = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const v = await VanFleetService.expense(req.params.tripId, req.body || {}, by(req), { req });
  await AuditService.log({ req, action: "VAN_EXPENSE", entity: "VanTrip", entityId: req.params.tripId, summary: `${v.voucherNo} paid from the van's cash (${req.body?.kind || "expense"}, ${Number(v.totalAmount).toFixed(2)})`, after: { voucher: v.voucherNo } });
  ok(res, { voucher: v, trip: await VanTripService.getById(req.params.tripId) }, 201);
});
exports.pinCustomer = catchAsync(async (req, res) => {
  await assertMayWork(req);
  const r = await VanFleetService.pinCustomer(req.params.tripId, req.params.customerId, req.body?.location, by(req), { mayRepin: holds(req, "vansales.manage") });
  await AuditService.log({ req, action: "VAN_CUSTOMER_PINNED", entity: "Customer", entityId: r.customerId, summary: `${r.customerName} pinned on the map from the van` });
  ok(res, r);
});
exports.routeProfit = catchAsync(async (req, res) => ok(res, await VanSalesReportService.routeProfit({ from: req.query.from, to: req.query.to, by: req.query.by, onlySalesman: ownerFilter(req) })));
