// Linking a client business to Wafeq. The partner model: Zarvia holds the Wafeq organisation and its keys (environment), a client business only
// approves us once ("Connect with Wafeq", OAuth authorization code + PKCE S256) and we keep the ids Wafeq gives back: the taxpayer and the grant.
// The access and refresh tokens that come with the grant are never stored: every call uses the installation's API key plus the taxpayer id.
//
// Two ways in: the client's own OAuth connect (start / finish), and the developer console's direct link (linkDirect: a taxpayer id typed by a
// developer, checked with Wafeq, for sandbox testing and support). One Wafeq taxpayer belongs to ONE of our organisations.
const crypto = require("crypto");
const AppError = require("../../../utils/AppError");
const { encrypt, decrypt } = require("../../../utils/secretBox");
const { getTenant } = require("../../../utils/tenant");
const { runWithTenant, runUnscoped } = require("../../../utils/tenantContext");
const { EInvoiceSettings } = require("../../../models/modules/einvoiceModels");
const CompanySettings = require("../../../models/modules/financial/companySettingsModel");
const AuditService = require("../../core/auditService");
const { WafeqClient } = require("./client");
const { modeConfig, MODES } = require("./config");

const STATE_MAX_MS = 15 * 60 * 1000;
const SCOPE = "invoices:write invoices:read taxpayer:read";
const fail = (message, status = 400, code) => new AppError(message, status, code);

const signState = (payload) => crypto.createHmac("sha256", process.env.SECRET_BOX_KEY || process.env.JWT_SECRET || "dev").update(`wafeq|${payload}`).digest("base64url");
const redirectUri = () => `${String(process.env.PUBLIC_APP_URL || "https://zarvia.onrender.com").replace(/\/+$/, "")}/settings/einvoicing/wafeq/callback`;
const sha256url = (s) => crypto.createHash("sha256").update(s).digest("base64url");

function readState(state, adminId, companyId) {
  const [encoded, signature] = String(state || "").split(".");
  const bad = () => fail("That connection could not be checked. Start it again.", 400, "WAFEQ_STATE_INVALID");
  if (!encoded || !signature) throw bad();
  const payload = Buffer.from(encoded, "base64url").toString();
  const a = Buffer.from(signature);
  const b = Buffer.from(signState(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad();
  const [company, who, at, nonce] = payload.split("|");
  if (company !== companyId || String(who) !== String(adminId)) throw fail("That connection belongs to somebody else.", 400, "WAFEQ_STATE_INVALID");
  if (Date.now() - Number(at) > STATE_MAX_MS) throw fail("That took too long. Start the connection again.", 400, "WAFEQ_STATE_EXPIRED");
  return { nonce };
}

// the taxpayer may belong to one organisation only: asked across organisations, the one deliberate unscoped read
async function assertTaxpayerFree(taxpayerId, companyId) {
  const other = await runUnscoped("one Wafeq taxpayer may be linked to only one organisation: checked across organisations", () =>
    EInvoiceSettings.findOne({ "wafeq.taxpayerId": taxpayerId, "wafeq.status": { $in: ["active", "revoked"] }, companyId: { $ne: companyId } }).select("companyId").lean()
  );
  if (other) throw fail("That Wafeq business is already linked to another organisation", 409, "WAFEQ_TAXPAYER_IN_USE");
}

async function remember(companyId, { mode, taxpayerId, grantId, profile, via, by }) {
  const w = {
    taxpayerId, grantId: grantId || undefined, tin: profile.tin, participantId: profile.participant_id, name: profile.profile?.legal_name || "",
    status: "active", mode, linkedVia: via, connectedAt: new Date(), connectedBy: by || null, lastError: null,
  };
  await EInvoiceSettings.findOneAndUpdate(
    { companyId },
    { $set: { wafeq: w, provider: "wafeq", environment: mode, participantId: profile.participant_id }, $unset: { wafeqPending: "" } },
    { upsert: true, new: true }
  );
}

async function readProfile(mode, taxpayerId) {
  const res = await WafeqClient.profile(mode, taxpayerId);
  if (res.status === 404) throw fail("Wafeq does not know that business", 404, "WAFEQ_TAXPAYER_UNKNOWN");
  if (res.status !== 200 || !res.body) throw fail(`Wafeq could not confirm the business (${res.status})`, 502, "WAFEQ_UNREACHABLE");
  return res.body;
}

class WafeqConnectService {
  /** Where to send the person. Records the PKCE verifier (encrypted) and signs a state that names who asked and when. */
  static async start({ mode }, req) {
    if (!MODES.includes(mode)) throw fail("Choose test or live", 400, "INVALID_ENVIRONMENT");
    const cfg = modeConfig(mode);
    if (!cfg.available || !cfg.oauth) throw fail(`Wafeq ${mode === "live" ? "live" : "test"} connections are not set up on this server yet`, 422, "WAFEQ_NOT_CONFIGURED");
    const { companyId } = getTenant(req);
    const adminId = String(req?.admin?.id || "");

    const cs = await CompanySettings.findOne({ companyId }).select("profile").lean();
    const trn = String(cs?.profile?.trn || "").replace(/\D/g, "");
    const tin = trn.length === 15 ? trn.slice(0, 10) : "";

    // If Wafeq can say the business has not appointed it yet, say so with the steps, rather than a dead end after the approval screen.
    if (tin) {
      try {
        const r = await WafeqClient.registrationCheck(mode, tin);
        if (r.status === 200 && r.body && r.body.taxpayer_registered === false) {
          throw fail("This business has not appointed Wafeq FZ LLC as its e-invoicing service provider yet. In EmaraTax, open e-Invoicing and appoint Wafeq FZ LLC, then connect again.", 409, "WAFEQ_NOT_APPOINTED");
        }
      } catch (err) {
        if (err.code === "WAFEQ_NOT_APPOINTED") throw err; // anything else: the check is a courtesy, never a blocker
      }
    }

    const verifier = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(8).toString("hex");
    const at = Date.now();
    const payload = `${companyId}|${adminId}|${at}|${nonce}`;
    const state = `${Buffer.from(payload).toString("base64url")}.${signState(payload)}`;
    await EInvoiceSettings.findOneAndUpdate(
      { companyId },
      { $set: { wafeqPending: { verifierEnc: encrypt(verifier), nonce, mode, at: new Date(at), by: adminId } } },
      { upsert: true }
    );
    const params = new URLSearchParams({
      response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri(), scope: SCOPE, state,
      code_challenge: sha256url(verifier), code_challenge_method: "S256", external_id: companyId,
      ...(tin ? { tin_hint: tin } : {}), grant_label: cs?.profile?.legalName ? String(cs.profile.legalName).slice(0, 80) : companyId,
    });
    return { url: `${cfg.authorizeUrl}?${params.toString()}`, mode };
  }

  /** The approval came back with a code. Trade it for the taxpayer and grant, confirm them with Wafeq, remember them. */
  static async finish({ code, state }, req) {
    const { companyId } = getTenant(req);
    const adminId = String(req?.admin?.id || "");
    const { nonce } = readState(state, adminId, companyId);
    const row = await EInvoiceSettings.findOne({ companyId }).select("+wafeqPending");
    const pending = row?.wafeqPending;
    if (!pending?.verifierEnc || pending.nonce !== nonce) throw fail("That connection was already used or replaced. Start it again.", 400, "WAFEQ_STATE_INVALID");
    const mode = pending.mode;
    // a code works once: whatever happens next, the pending attempt is spent
    await EInvoiceSettings.updateOne({ companyId }, { $unset: { wafeqPending: "" } });
    if (!code || typeof code !== "string") throw fail("Wafeq did not return an approval code", 400, "WAFEQ_CODE_MISSING");

    const res = await WafeqClient.exchangeCode(mode, { code, verifier: decrypt(pending.verifierEnc), redirectUri: redirectUri() });
    const t = res.body || {};
    if (res.status !== 200 || !t.taxpayer_id) {
      throw fail(t.error_description || "Wafeq did not accept the approval", 400, "WAFEQ_CODE_REJECTED");
    }
    await assertTaxpayerFree(t.taxpayer_id, companyId);
    // confirm with Wafeq itself, and take the Peppol id and legal name from the record that will be on every invoice
    const profile = await readProfile(mode, t.taxpayer_id);
    await remember(companyId, { mode, taxpayerId: t.taxpayer_id, grantId: t.grant_id, profile, via: "oauth", by: adminId });
    await AuditService.log({ req, action: "EINVOICE_WAFEQ_CONNECTED", entity: "EInvoiceSettings", summary: `${profile.profile?.legal_name || t.taxpayer_name || ""} (${mode})` });
    return { connected: true, mode, name: profile.profile?.legal_name || t.taxpayer_name, tin: profile.tin, participantId: profile.participant_id };
  }

  /** Withdraw the grant at Wafeq (best effort) and go back to the built-in sandbox. */
  static async disconnect(req) {
    const { companyId } = getTenant(req);
    const row = await EInvoiceSettings.findOne({ companyId });
    const w = row?.wafeq;
    if (!w?.taxpayerId) throw fail("This business is not connected to Wafeq", 409, "WAFEQ_NOT_CONNECTED");
    let revoked = false;
    if (w.grantId) {
      try {
        const tok = await WafeqClient.orgToken(w.mode || "sandbox");
        if (tok.status === 200 && tok.body?.access_token) {
          const del = await WafeqClient.orgCall(w.mode || "sandbox", tok.body.access_token, { method: "DELETE", path: `/grants/${encodeURIComponent(w.grantId)}` });
          revoked = del.status >= 200 && del.status < 300;
        }
      } catch { revoked = false; }
    }
    row.wafeq.status = "disconnected";
    row.provider = "sandbox";
    row.environment = "sandbox";
    await row.save();
    await AuditService.log({ req, action: "EINVOICE_WAFEQ_DISCONNECTED", entity: "EInvoiceSettings", summary: `${w.name || w.taxpayerId}${revoked ? "" : " (grant not withdrawn at Wafeq)"}` });
    return { connected: false, revokedAtWafeq: revoked };
  }

  /** The developer console: link a taxpayer id directly (sandbox testing, support). Runs inside the organisation's own scope. */
  static async linkDirect(companyId, { mode, taxpayerId, grantId }, by) {
    if (!MODES.includes(mode)) throw fail("Choose test or live", 400, "INVALID_ENVIRONMENT");
    if (!/^txpay_[A-Za-z0-9]+$/.test(String(taxpayerId || ""))) throw fail("A Wafeq taxpayer id looks like txpay_...", 400, "INVALID_TAXPAYER_ID");
    if (grantId && !/^tgr_[A-Za-z0-9]+$/.test(String(grantId))) throw fail("A Wafeq grant id looks like tgr_...", 400, "INVALID_GRANT_ID");
    if (!modeConfig(mode).available) throw fail(`Wafeq ${mode === "live" ? "live" : "test"} access is not installed on this server`, 422, "WAFEQ_NOT_CONFIGURED");
    return runWithTenant({ companyId }, async () => {
      await assertTaxpayerFree(taxpayerId, companyId);
      const profile = await readProfile(mode, taxpayerId);
      await remember(companyId, { mode, taxpayerId, grantId, profile, via: "console", by });
      return { connected: true, mode, name: profile.profile?.legal_name || "", tin: profile.tin, participantId: profile.participant_id };
    });
  }

  static async unlinkDirect(companyId) {
    return runWithTenant({ companyId }, async () => {
      await EInvoiceSettings.updateOne({ companyId }, { $set: { "wafeq.status": "disconnected", provider: "sandbox", environment: "sandbox" } });
      return { connected: false };
    });
  }
}

module.exports = WafeqConnectService;
module.exports.signState = signState;
module.exports.readState = readState;
