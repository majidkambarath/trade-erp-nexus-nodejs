const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const catchAsync = require("../../utils/catchAsync");
const EInvoiceService = require("../../services/einvoice/einvoiceService");
const InboundService = require("../../services/einvoice/inboundService");
const WafeqWebhookService = require("../../services/einvoice/wafeq/webhookService");
const WafeqConnectService = require("../../services/einvoice/wafeq/connectService");
const WafeqHealth = require("../../services/einvoice/wafeq/healthService");
const WafeqInboundPull = require("../../services/einvoice/wafeq/inboundPull");
const AuditService = require("../../services/core/auditService");
const { getTenant } = require("../../utils/tenant");
const Organisation = require("../../models/core/organisationModel");
const AppError = require("../../utils/AppError");
const { runWithTenant, DEFAULT_TENANT } = require("../../utils/tenantContext");

const { requirePermission, publicRoute } = require("../../middleware/permissionGate");
const router = express.Router();
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Delivered by the access point, authenticated by an HMAC signature over the raw body rather than
// by a login. Registered BEFORE authenticateToken.
// There is no login here, so there is no organisation in scope: the URL names it. /inbound/webhook/:org is
// for every organisation; the bare /inbound/webhook is the original URL, kept for the original organisation
// so a service provider that is already configured is not broken. An unknown organisation answers the same
// 404 as an unknown path, so the address cannot be used to find out which organisations exist.
const webhook = (organisationCode) =>
  catchAsync(async (req, res) => {
    const org = await Organisation.findOne({ code: String(organisationCode(req) || "").toLowerCase() });
    if (!org) throw new AppError("Not found", 404, "NOT_FOUND");
    const result = await runWithTenant({ companyId: org.code }, async () => {
      await InboundService.verifyWebhook(req.rawBody, req.get("x-einvoice-signature"), getTenant(req).companyId);
      return InboundService.ingest(req.body, { source: "webhook", req });
    });
    ok(res, { id: result.invoice._id, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  });
router.post("/inbound/webhook/:org", publicRoute("a signed e-invoice delivery: verified by HMAC over the raw body, no login"), webhook((req) => req.params.org));
router.post("/inbound/webhook", publicRoute("a signed e-invoice delivery: verified by HMAC over the raw body, no login"), webhook(() => DEFAULT_TENANT.companyId));

// Wafeq's own deliveries (Standard Webhooks): authenticated by the signature over the raw body, no login. :mode is "test" or "live".
router.post("/wafeq/webhook/:mode", publicRoute("a signed Wafeq delivery: verified by the Standard Webhooks signature over the raw body, no login"), catchAsync(async (req, res) => {
  const r = await WafeqWebhookService.handle({ mode: req.params.mode, rawBody: req.rawBody, headers: req.headers, body: req.body });
  ok(res, { duplicate: r.duplicate });
}));

router.use(authenticateToken);
router.use(requireFeature("einvoicing"));

// Linking the business to Wafeq (OAuth authorization code + PKCE). The callback is a page of the app, which hands the code here.
router.post("/wafeq/connect/start", requirePermission("settings.manage"), catchAsync(async (req, res) => ok(res, await WafeqConnectService.start(req.body || {}, req))));
router.post("/wafeq/connect/finish", requirePermission("settings.manage"), catchAsync(async (req, res) => ok(res, await WafeqConnectService.finish(req.body || {}, req))));
router.post("/wafeq/disconnect", requirePermission("settings.manage"), catchAsync(async (req, res) => ok(res, await WafeqConnectService.disconnect(req))));

router.get("/settings", requirePermission(["settings.view","reports.financial"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.getSettings(req))));
router.put(
  "/settings", requirePermission("settings.manage"),
  catchAsync(async (req, res) => {
    const out = await EInvoiceService.updateSettings(req.body, req);
    // never log the secrets themselves
    await AuditService.log({ req, action: "EINVOICE_SETTINGS_CHANGED", entity: "EInvoiceSettings", summary: Object.keys(req.body).join(", "), after: { ...req.body, webhookSecret: req.body.webhookSecret ? "(changed)" : undefined } });
    ok(res, out);
  })
);

router.get("/readiness", requirePermission(["settings.view","reports.financial","sales.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.readiness(req))));
router.patch("/parties/:id", requirePermission("sales.edit"), catchAsync(async (req, res) => ok(res, await EInvoiceService.updateParty(req.params.id, req.body))));

router.get("/documents", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.documents(req, req.query))));
router.get("/preview/:transactionId", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.preview(req.params.transactionId, req))));
router.post("/submit/:transactionId", requirePermission("sales.approve"), catchAsync(async (req, res) => {
  const r = await EInvoiceService.submit(req.params.transactionId, req);
  ok(res, r, r.alreadySubmitted ? 200 : 201);
}));

router.post("/submissions/:id/correct", requirePermission("sales.approve"), catchAsync(async (req, res) => ok(res, await EInvoiceService.correct(req.params.id, req))));
router.post("/documents/:transactionId/credit-in-full", requirePermission("sales.create"), catchAsync(async (req, res) => ok(res, await EInvoiceService.creditInFull(req.params.transactionId, req), 201)));
router.get("/submissions", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.listSubmissions(req, req.query))));
router.get("/submissions/:id", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.getSubmission(req.params.id, req))));
router.post("/submissions/:id/retry", requirePermission("sales.approve"), catchAsync(async (req, res) => ok(res, await EInvoiceService.retry(req.params.id, req))));
router.post("/submissions/:id/refresh", requirePermission("sales.approve"), catchAsync(async (req, res) => ok(res, await EInvoiceService.refresh(req.params.id, req))));
router.get("/dashboard", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await EInvoiceService.dashboard(req, req.query))));
router.get("/wafeq/health", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await WafeqHealth.health(getTenant(req).companyId))));
router.get("/wafeq/summary", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await WafeqHealth.summary(getTenant(req).companyId, req.query))));

router.get("/inbound", requirePermission(["reports.financial","sales.view","purchase.view"]), catchAsync(async (req, res) => ok(res, await InboundService.list(req, req.query))));
router.post("/inbound", requirePermission("purchase.create"), catchAsync(async (req, res) => {
  const r = await InboundService.ingest(req.body, { source: "manual", req });
  ok(res, { id: r.invoice._id, duplicate: r.duplicate, matchNote: r.invoice.matchNote }, r.duplicate ? 200 : 201);
}));
// "Check for new": ask Wafeq for received invoices now (the background pass also does it every ten minutes).
router.post("/inbound/pull", requirePermission("purchase.view"), catchAsync(async (req, res) => ok(res, await WafeqInboundPull.pull(getTenant(req).companyId, { force: true }))));
router.post("/inbound/:id/purchase", requirePermission("purchase.create"), catchAsync(async (req, res) => ok(res, await InboundService.recordAsPurchase(req.params.id, req.body || {}, req), 201)));
router.post("/inbound/:id/accept", requirePermission("purchase.approve"), catchAsync(async (req, res) => ok(res, await InboundService.decide(req.params.id, "ACCEPTED", req.body, req))));
router.post("/inbound/:id/reject", requirePermission("purchase.approve"), catchAsync(async (req, res) => ok(res, await InboundService.decide(req.params.id, "REJECTED", req.body, req))));

module.exports = router;
