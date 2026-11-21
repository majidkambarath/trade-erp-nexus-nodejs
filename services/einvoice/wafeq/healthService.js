// Two on-demand reads for the dashboard's connection card. Kept apart from the dashboard itself so Wafeq's shared rate budget is never
// spent on every page load, and cached for five minutes per business.
const CompanySettings = require("../../../models/modules/financial/companySettingsModel");
const { EInvoiceSettings } = require("../../../models/modules/einvoiceModels");
const { WafeqClient } = require("./client");
const { profileMismatches } = require("../../../utils/einvoiceDashboard");

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
};

async function linkOf(companyId) {
  const s = await EInvoiceSettings.findOne({ companyId }).lean();
  if (!s || s.provider !== "wafeq" || s.wafeq?.status !== "active" || !s.wafeq.taxpayerId) return null;
  return { mode: s.wafeq.mode === "live" ? "live" : "sandbox", taxpayerId: s.wafeq.taxpayerId };
}

class WafeqHealth {
  static clearCache() { cache.clear(); }

  /** The taxpayer as Wafeq holds it, set beside our company profile. */
  static async health(companyId) {
    const link = await linkOf(companyId);
    if (!link) return { connected: false };
    return cached(`h:${companyId}:${link.taxpayerId}`, async () => {
      const res = await WafeqClient.profile(link.mode, link.taxpayerId).catch((e) => ({ status: 0, error: e.message }));
      if (res.status !== 200) return { connected: true, ok: false, note: res.error || `Wafeq answered ${res.status}` };
      const b = res.body || {};
      const wafeq = { legalName: b.profile?.legal_name || "", vatNumber: b.profile?.vat_number || "", participantId: b.participant_id || "", verifiedAt: b.verified_at || null, environment: b.environment || link.mode };
      const cs = await CompanySettings.findOne({ companyId }).select("profile").lean();
      const mismatches = profileMismatches(wafeq, { trn: cs?.profile?.trn, name: cs?.profile?.legalName });
      return { connected: true, ok: mismatches.length === 0, ...wafeq, mismatches };
    });
  }

  /** Wafeq's own count of what it holds for this business, for the period. Our figures are put beside it by the caller. */
  static async summary(companyId, { from, to } = {}) {
    const link = await linkOf(companyId);
    if (!link) return { connected: false };
    return cached(`s:${companyId}:${link.taxpayerId}:${from || ""}:${to || ""}`, async () => {
      const q = (dir) => `direction=${dir}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
      const out = { connected: true, sandbox: link.mode === "sandbox" };
      for (const dir of ["outbound", "inbound"]) {
        const res = await WafeqClient.summary(link.mode, link.taxpayerId, q(dir)).catch((e) => ({ status: 0, error: e.message }));
        if (res.status !== 200) { out.note = res.error || `Wafeq answered ${res.status}`; out[dir] = null; continue; }
        const b = res.body || {};
        out[dir] = { count: b.count || 0, byStatus: b.by_status || [], totals: b.totals_by_currency || [], byMonth: b.by_month || [] };
      }
      return out;
    });
  }
}

module.exports = WafeqHealth;
