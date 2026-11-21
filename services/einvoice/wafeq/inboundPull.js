// Received supplier e-invoices: fetched from Wafeq, read from their UBL XML and handed to the existing InboundService (vendor matching, the
// purchase invoice it may bill). Wafeq has no API to accept or reject one, so the decision stays ours.
//
// Two paths into one function: the webhook `document.received` (pullOne) and a poll (pull: every 10 minutes from the background pass, or the
// screen's "Check for new"). A document already stored is never stored twice: providerId (Wafeq's document id) is unique per organisation.
const { runWithTenant } = require("../../../utils/tenantContext");
const { parseUbl } = require("../../../utils/ublInvoice");
const { EInvoiceSettings, InboundInvoice } = require("../../../models/modules/einvoiceModels");
const InboundService = require("../inboundService");
const { WafeqClient } = require("./client");

const OVERLAP_MS = 24 * 60 * 60 * 1000;
const THROTTLE_MS = 10 * 60 * 1000;

const linkOf = async (companyId) => {
  const s = await EInvoiceSettings.findOne({ companyId }).lean();
  if (!s || s.provider !== "wafeq" || s.wafeq?.status !== "active" || !s.wafeq.taxpayerId) return null;
  return { settings: s, mode: s.environment === "live" ? "live" : "sandbox", taxpayerId: s.wafeq.taxpayerId };
};

// One received document: download its XML, parse it, store it. -> "added" | "have" | throws a short message
async function ingestOne(link, companyId, documentId) {
  if (await InboundInvoice.exists({ companyId, providerId: documentId })) return "have";
  const res = await WafeqClient.xml(link.mode, link.taxpayerId, documentId);
  if (res.status === 402) throw Object.assign(new Error("Wafeq document credits have run out, so received invoices cannot be read"), { credits: true });
  if (res.status !== 200 || !res.text) throw new Error(`Wafeq could not give the e-invoice ${documentId} (${res.status})`);
  const doc = parseUbl(res.text);
  await InboundService.ingest({ ...doc, providerId: documentId }, {
    source: "wafeq", extra: { kind: doc.kind, wafeqDocumentId: documentId, dueDate: doc.dueDate ? new Date(doc.dueDate) : undefined, xml: res.text },
  });
  return "added";
}

class WafeqInboundPull {
  /** Ask Wafeq for received invoices and credit notes since the last time. `force` skips the 10-minute throttle (the screen's button). */
  static async pull(companyId, { force = false, now = new Date() } = {}) {
    return runWithTenant({ companyId }, async () => {
      const link = await linkOf(companyId);
      if (!link) return { skipped: true, reason: "Wafeq is not connected" };
      const last = link.settings.wafeq.inboundPulledAt ? new Date(link.settings.wafeq.inboundPulledAt) : null;
      if (!force && last && now - last < THROTTLE_MS) return { skipped: true, reason: "checked a moment ago" };

      const since = last ? new Date(last.getTime() - OVERLAP_MS).toISOString().slice(0, 10) : undefined;
      const out = { found: 0, added: 0, errors: [] };
      let listed = true;
      for (const path of ["/invoices", "/credit-notes"]) {
        const res = await WafeqClient.list(link.mode, link.taxpayerId, path, `direction=inbound${since ? `&date_from=${since}` : ""}`).catch((e) => ({ status: 0, error: e.message }));
        if (res.status !== 200) { listed = false; out.errors.push(`${path}: ${res.error || `Wafeq answered ${res.status}`}`); continue; }
        for (const item of res.body?.items || []) {
          if (item.direction && item.direction !== "inbound") continue;
          const id = item.id || item.document_id;
          if (!id) continue;
          out.found += 1;
          try {
            if ((await ingestOne(link, companyId, id)) === "added") out.added += 1;
          } catch (err) {
            out.errors.push(`${item.invoice_number || id}: ${err.message}`);
            if (err.credits) await EInvoiceSettings.updateOne({ companyId }, { $set: { "wafeq.lastError": err.message } });
          }
        }
      }
      // the clock only moves when Wafeq could be asked, so a failed listing is tried again, not skipped
      if (listed) await EInvoiceSettings.updateOne({ companyId }, { $set: { "wafeq.inboundPulledAt": now } });
      return out;
    });
  }

  /** One document the webhook named. */
  static async pullOne(companyId, documentId) {
    return runWithTenant({ companyId }, async () => {
      const link = await linkOf(companyId);
      if (!link) return "not_connected";
      try { return await ingestOne(link, companyId, documentId); } catch (err) { return `error: ${err.message}`; }
    });
  }
}

module.exports = WafeqInboundPull;
