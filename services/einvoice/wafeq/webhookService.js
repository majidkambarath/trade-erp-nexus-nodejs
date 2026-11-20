// Wafeq's webhooks (Standard Webhooks format). A delivery names a Wafeq TAXPAYER, not one of our organisations, so the organisation is found from
// the taxpayer id the business was linked with, and only then does any work run, inside that organisation's own scope.
//
// Order of the checks, and why: signature first (nothing is believed before it), then the delivery id is recorded (a retry is recognised and
// does nothing), then the organisation is found. An unknown taxpayer is answered 200 and logged: a 4xx would make Wafeq retry for 8 hours.
const AppError = require("../../../utils/AppError");
const logger = require("../../../utils/logger");
const { verify } = require("../../../utils/standardWebhooks");
const { runUnscoped, runWithTenant } = require("../../../utils/tenantContext");
const { EInvoiceSettings, EInvoiceSubmission, WafeqEvent } = require("../../../models/modules/einvoiceModels");
const { modeConfig, modeOfWebhook } = require("./config");
const { statusFrom } = require("./provider");
const WafeqInboundPull = require("./inboundPull");

class WafeqWebhookService {
  static async handle({ mode: routeMode, rawBody, headers, body }) {
    const mode = modeOfWebhook(routeMode);
    if (!mode) throw new AppError("Not found", 404, "NOT_FOUND");
    const cfg = modeConfig(mode);
    if (!cfg.webhookSecret) throw new AppError("Webhook is not configured", 503, "WEBHOOK_NOT_CONFIGURED");
    const v = verify({ secret: cfg.webhookSecret, id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], signature: headers["webhook-signature"], rawBody });
    if (!v.ok) throw new AppError("Invalid webhook signature", 401, "INVALID_SIGNATURE");

    const event = body || {};
    const data = event.data || {};
    const eventId = String(headers["webhook-id"]);
    try {
      await WafeqEvent.create({ eventId, type: event.type, taxpayerId: data.taxpayer_id || null });
    } catch (err) {
      if (err.code === 11000) return { duplicate: true };
      throw err;
    }
    // an event from the other mode (a live event on the test endpoint, or the reverse) is not for this link
    if (event.environment && event.environment !== (mode === "live" ? "live" : "sandbox")) return this.finish(eventId, "wrong_environment");
    if (!data.taxpayer_id) return this.finish(eventId, "no_taxpayer");

    const link = await runUnscoped("a Wafeq delivery names a taxpayer, not an organisation: found by the id the business was linked with", () =>
      EInvoiceSettings.findOne({ "wafeq.taxpayerId": data.taxpayer_id, "wafeq.mode": mode }).select("companyId").lean()
    );
    if (!link) {
      logger.warn?.(`[wafeq] webhook for an unlinked taxpayer (${event.type})`);
      return this.finish(eventId, "unknown_taxpayer");
    }
    const result = await runWithTenant({ companyId: link.companyId }, () => this.apply(event, data, link.companyId));
    return this.finish(eventId, result, link.companyId);
  }

  static async finish(eventId, result, org) {
    await WafeqEvent.updateOne({ eventId }, { $set: { result, processedAt: new Date(), ...(org ? { org } : {}) } });
    return { duplicate: false, result };
  }

  static async apply(event, data, companyId) {
    const type = String(event.type || "");
    if (type.startsWith("document.") && type !== "document.received") {
      if (!data.document_id) return "no_document";
      const sub = await EInvoiceSubmission.findOne({ companyId, providerEntryId: String(data.document_id) });
      if (!sub) return "unknown_document";
      const EInvoiceService = require("../einvoiceService"); // required late: einvoiceService requires the providers that require this folder
      const r = statusFrom(data);
      await EInvoiceService.applyStatus(sub, r);
      return `applied:${r.status || "none"}`;
    }
    if (type === "taxpayer.deleted") {
      await EInvoiceSettings.updateOne({ companyId, "wafeq.taxpayerId": data.taxpayer_id }, { $set: { "wafeq.status": "revoked", "wafeq.lastError": "Wafeq reports this business was removed" } });
      return "taxpayer_revoked";
    }
    if (type === "taxpayer.updated") {
      const set = {};
      if (data.name) set["wafeq.name"] = data.name;
      if (data.participant_id) set["wafeq.participantId"] = data.participant_id;
      if (Object.keys(set).length) await EInvoiceSettings.updateOne({ companyId, "wafeq.taxpayerId": data.taxpayer_id }, { $set: set });
      return "taxpayer_updated";
    }
    if (type === "document.received") return `received:${await WafeqInboundPull.pullOne(companyId, data.document_id)}`;
    return "ignored"; // anything newer: stored and acknowledged only
  }
}

module.exports = WafeqWebhookService;
