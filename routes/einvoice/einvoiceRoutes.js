const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const catchAsync = require("../../utils/catchAsync");
const EInvoiceService = require("../../services/einvoice/einvoiceService");
const InboundService = require("../../services/einvoice/inboundService");
const AuditService = require("../../services/core/auditService");
const { getTenant } = require("../../utils/tenant");
const Organisation = require("../../models/core/organisationModel");
const AppError = require("../../utils/AppError");
const { runWithTenant, DEFAULT_TENANT } = require("../../utils/tenantContext");

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
router.post("/inbound/webhook/:org", webhook((req) => req.params.org));
router.post("/inbound/webhook", webhook(() => DEFAULT_TENANT.companyId));

router.use(authenticateToken);
const canChange = requireRole(["super_admin", "admin"]);
const canSend = requireRole(["super_admin", "admin", "manager"]);

router.get("/settings", catchAsync(async (req, res) => ok(res, await EInvoiceService.getSettings(req))));
router.put(
  "/settings",
  canChange,
  catchAsync(async (req, res) => {
    const out = await EInvoiceService.updateSettings(req.body, req);
    // never log the secrets themselves
    await AuditService.log({ req, action: "EINVOICE_SETTINGS_CHANGED", entity: "EInvoiceSettings", summary: Object.keys(req.body).join(", "), after: { ...req.body, webhookSecret: req.body.webhookSecret ? "(changed)" : undefined } });
    ok(res, out);
  })
);

router.get("/readiness", catchAsync(async (req, res) => ok(res, await EInvoiceService.readiness(req))));
router.patch("/parties/:id", canChange, catchAsync(async (req, res) => ok(res, await EInvoiceService.updateParty(req.params.id, req.body))));

router.get("/documents", catchAsync(async (req, res) => ok(res, await EInvoiceService.documents(req, req.query))));
router.get("/preview/:transactionId", catchAsync(async (req, res) => ok(res, await EInvoiceService.preview(req.params.transactionId, req))));
router.post("/submit/:transactionId", canSend, catchAsync(async (req, res) => {
  const r = await EInvoiceService.submit(req.params.transactionId, req);
  ok(res, r, r.alreadySubmitted ? 200 : 201);
}));

router.get("/submissions", catchAsync(async (req, res) => ok(res, await EInvoiceService.listSubmissions(req, req.query))));
router.get("/submissions/:id", catchAsync(async (req, res) => ok(res, await EInvoiceService.getSubmission(req.params.id, req))));
router.post("/submissions/:id/retry", canSend, catchAsync(async (req, res) => ok(res, await EInvoiceService.retry(req.params.id, req))));
router.post("/submissions/:id/refresh", catchAsync(async (req, res) => ok(res, await EInvoiceService.refresh(req.params.id, req))));
router.get("/dashboard", catchAsync(async (req, res) => ok(res, await EInvoiceService.dashboard(req))));

router.get("/inbound", catchAsync(async (req, res) => ok(res, await InboundService.list(req, req.query))));
router.post("/inbound", canChange, catchAsync(async (req, res) => {
  const r = await InboundService.ingest(req.body, { source: "manual", req });
  ok(res, { id: r.invoice._id, duplicate: r.duplicate, matchNote: r.invoice.matchNote }, r.duplicate ? 200 : 201);
}));
router.post("/inbound/:id/accept", canSend, catchAsync(async (req, res) => ok(res, await InboundService.decide(req.params.id, "ACCEPTED", req.body, req))));
router.post("/inbound/:id/reject", canSend, catchAsync(async (req, res) => ok(res, await InboundService.decide(req.params.id, "REJECTED", req.body, req))));

module.exports = router;
