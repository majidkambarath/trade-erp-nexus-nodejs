// The sending setup: which provider, whose address the mail comes from, the encrypted key. Shaped like
// the e-invoice settings: the key is write-only (the client learns only that one is stored), a
// non-empty key replaces it and an omitted one keeps it, and switching sending on is refused until the
// setup could actually work.
const { MessagingSettings } = require("../../models/modules/messagingModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { encrypt, decrypt } = require("../../utils/secretBox");
const { PROVIDERS, formatFrom } = require("./providers");
const { companyFor } = require("./documentSource");
const { ProviderError } = require("../../utils/providerError");
const { checkSmtpTarget } = require("../../utils/smtp");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
// A mailbox provider will not let a company send AS gmail.com, and mail forged that way is spam-foldered.
const CONSUMER = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

const domainOf = (email) => String(email || "").split("@")[1] || "";
const onDomain = (email, domain) => {
  const d = domainOf(email).toLowerCase();
  return Boolean(domain) && (d === domain || d.endsWith(`.${domain}`));
};

class SettingsService {
  static async load(companyId, { withSecrets = false } = {}) {
    let q = MessagingSettings.findOne({ companyId });
    if (withSecrets) q = q.select("+apiKeyEnc +smtpPassEnc");
    return (await q) || new MessagingSettings({ companyId });
  }

  static publicSettings(s) {
    return {
      enabled: s.enabled, provider: s.provider,
      fromName: s.fromName || "", fromEmail: s.fromEmail || "", replyTo: s.replyTo || "", verifiedDomain: s.verifiedDomain || "",
      bccSelf: s.bccSelf, signature: s.signature || "", defaultNote: s.defaultNote || "", attachPdf: s.attachPdf,
      shareEnabled: s.shareEnabled, shareLinkDays: s.shareLinkDays, statementShareDays: s.statementShareDays,
      retryMax: s.retryMax, dailyLimit: s.dailyLimit,
      // Honest about reach: the console provider records and sends nothing.
      connected: s.provider !== "console",
      hasApiKey: Boolean(s.apiKeyEnc), // write-only: never the key itself
      smtpHost: s.smtpHost || "", smtpPort: s.smtpPort || 587, smtpUser: s.smtpUser || "",
      hasSmtpPassword: Boolean(s.smtpPassEnc), // write-only like the key
      lastAuthFailureAt: s.lastAuthFailureAt || null,
    };
  }

  static async get(req) {
    const { companyId } = getTenant(req);
    const s = await MessagingSettings.findOne({ companyId }).select("+apiKeyEnc +smtpPassEnc");
    return this.publicSettings(s || new MessagingSettings({ companyId }));
  }

  // What stands between this setup and a send that works. `blocking` ones stop sending being switched
  // on; the others are advice.
  static async readiness(req, settings) {
    const { companyId } = getTenant(req);
    const s = settings || (await this.load(companyId, { withSecrets: true }));
    const { company } = await companyFor(req);
    const resend = s.provider === "resend";
    const smtp = s.provider === "smtp";
    const live = resend || smtp;
    const checks = [
      ...(smtp
        ? [
            { key: "server", label: "The mail server name and port are set", ok: Boolean(s.smtpHost) && Boolean(s.smtpPort), blocking: true },
            { key: "login", label: "The mailbox username and password are saved", ok: Boolean(s.smtpUser) && Boolean(s.smtpPassEnc), blocking: true },
          ]
        : [{ key: "key", label: "An email service key is saved", ok: !resend || Boolean(s.apiKeyEnc), blocking: resend }]),
      { key: "from", label: "A sender address is set", ok: Boolean(s.fromEmail), blocking: live },
      ...(smtp
        ? [{ key: "sender-login", label: "The sender address is the mailbox you log in with (most mail servers insist on it)", ok: !s.smtpUser || !s.smtpUser.includes("@") || String(s.fromEmail || "").toLowerCase() === s.smtpUser.toLowerCase(), blocking: false }]
        : [{ key: "domain", label: "The sender domain is the one verified at the email service", ok: !resend || (Boolean(s.verifiedDomain) && onDomain(s.fromEmail, s.verifiedDomain)), blocking: resend }]),
      { key: "company", label: "Your company name is set (Settings, Company)", ok: Boolean(company.companyName), blocking: false },
      { key: "trn", label: "Your TRN is set, because a tax invoice must show it", ok: Boolean(company.vatNumber), blocking: false },
    ];
    return { checks, ready: checks.filter((c) => c.blocking).every((c) => c.ok), provider: s.provider };
  }

  static async update(data, req) {
    const { companyId } = getTenant(req);
    const s = await this.load(companyId, { withSecrets: true });

    if (data.provider !== undefined) {
      if (!PROVIDERS[data.provider]) throw new AppError("Unknown email provider", 422, "PROVIDER_NOT_AVAILABLE");
      s.provider = data.provider;
    }
    for (const k of ["fromName", "signature", "defaultNote"]) if (data[k] !== undefined) s[k] = String(data[k]).trim();
    for (const k of ["fromEmail", "replyTo"]) {
      if (data[k] === undefined) continue;
      const v = String(data[k]).trim().toLowerCase();
      if (v && !EMAIL.test(v)) throw new AppError("That email address does not look right", 400, "INVALID_EMAIL", { field: k });
      s[k] = v;
    }
    if (data.verifiedDomain !== undefined) {
      const d = String(data.verifiedDomain).trim().toLowerCase().replace(/^@/, "");
      if (d && !DOMAIN.test(d)) throw new AppError("That does not look like a domain, for example theircompany.ae", 400, "INVALID_DOMAIN");
      if (CONSUMER.has(d)) throw new AppError(`Mail cannot be sent as ${d}. Use the company's own domain.`, 422, "FROM_DOMAIN_NOT_ALLOWED");
      s.verifiedDomain = d;
    }
    // The verified domain only matters when the provider verifies one (Resend), or when this very request
    // sets the sender or the domain. An SMTP mailbox sends as itself, and switching provider alone must not
    // trip over a domain left behind from an earlier setup.
    const domainMatters = s.provider === "resend" || (s.provider !== "smtp" && (data.fromEmail !== undefined || data.verifiedDomain !== undefined));
    if (domainMatters && s.fromEmail && s.verifiedDomain && !onDomain(s.fromEmail, s.verifiedDomain)) {
      throw new AppError(`${s.fromEmail} is not on the verified domain ${s.verifiedDomain}`, 422, "FROM_DOMAIN_MISMATCH");
    }
    for (const k of ["bccSelf", "attachPdf", "shareEnabled"]) if (data[k] !== undefined) s[k] = Boolean(data[k]);
    for (const [k, lo, hi] of [["shareLinkDays", 1, 365], ["statementShareDays", 1, 365], ["retryMax", 0, 10], ["dailyLimit", 1, 5000]]) {
      if (data[k] === undefined) continue;
      const n = Number(data[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError(`${k} must be a whole number from ${lo} to ${hi}`, 400, "INVALID_NUMBER", { field: k });
      s[k] = n;
    }
    if (data.apiKey) s.apiKeyEnc = encrypt(String(data.apiKey).trim()); // non-empty replaces; omitted keeps

    // The mailbox's own mail server. The server dials whatever is typed here, so the target is checked.
    if (data.smtpHost !== undefined) s.smtpHost = String(data.smtpHost).trim().toLowerCase();
    if (data.smtpPort !== undefined) {
      const n = Number(data.smtpPort);
      if (!Number.isInteger(n)) throw new AppError("The port must be a whole number, for example 587", 400, "INVALID_NUMBER", { field: "smtpPort" });
      s.smtpPort = n;
    }
    if (data.smtpUser !== undefined) {
      const u = String(data.smtpUser).trim();
      if (u.length > 200 || /[ \t\r\n]/.test(u)) throw new AppError("The username cannot contain spaces", 400, "INVALID_USERNAME", { field: "smtpUser" });
      s.smtpUser = u;
    }
    if (data.smtpPassword) s.smtpPassEnc = encrypt(String(data.smtpPassword).trim());
    if (s.smtpHost) {
      const t = checkSmtpTarget(s.smtpHost, s.smtpPort || 587, { production: process.env.NODE_ENV === "production", allowPrivate: process.env.SMTP_ALLOW_PRIVATE_HOSTS === "true" });
      if (!t.ok) throw new AppError(t.reason, 422, "SMTP_TARGET_NOT_ALLOWED");
    }

    if (data.enabled !== undefined) {
      if (data.enabled) {
        const bad = (await this.readiness(req, s)).checks.filter((c) => c.blocking && !c.ok);
        if (bad.length) throw new AppError(`Not ready to switch on: ${bad.map((c) => c.label).join("; ")}`, 422, "MESSAGING_NOT_READY", { missing: bad.map((c) => c.key) });
      }
      s.enabled = Boolean(data.enabled);
    }
    await s.save();
    return this.publicSettings(s);
  }

  // The key as the provider needs it. A key that cannot be decrypted (JWT_SECRET was rotated and
  // SECRET_BOX_KEY was never set) is a setup problem a person can fix by entering it again.
  static keyOf(s) {
    if (s.provider !== "resend" && s.provider !== "smtp") return null;
    const enc = s.provider === "smtp" ? s.smtpPassEnc : s.apiKeyEnc;
    if (s.provider === "smtp" && !enc) return null; // a mail server that asks for no login
    try {
      return decrypt(enc);
    } catch (_) {
      throw new AppError("The stored email key can no longer be read. Enter it again in Settings, under Sending.", 422, "SECRET_UNREADABLE");
    }
  }

  // What a provider needs besides the secret: for SMTP, where the mail server is.
  static optionsOf(s) {
    return s.provider === "smtp" ? { smtp: { host: s.smtpHost, port: s.smtpPort || 587, user: s.smtpUser } } : {};
  }

  static fromLine(s) {
    return formatFrom(s.fromName, s.fromEmail);
  }

  // A real message through the real provider, so "does it work" is answered before a customer is involved.
  static async test({ to }, req) {
    const { companyId } = getTenant(req);
    const addr = String(to || "").trim().toLowerCase();
    if (!EMAIL.test(addr)) throw new AppError("Enter the address to send the test to", 400, "INVALID_EMAIL");
    const s = await this.load(companyId, { withSecrets: true });
    const bad = (await this.readiness(req, s)).checks.filter((c) => c.blocking && !c.ok);
    if (bad.length) throw new AppError(`Finish the setup first: ${bad.map((c) => c.label).join("; ")}`, 422, "MESSAGING_NOT_CONFIGURED", { missing: bad.map((c) => c.key) });
    const apiKey = this.keyOf(s);
    const from = this.fromLine(s) || "Zarvia <test@example.com>";
    try {
      const r = await PROVIDERS[s.provider].send(
        { from, to: [addr], replyTo: s.replyTo || undefined, subject: "Test message from Zarvia", text: "This is a test. Your email setup works.", html: "<p>This is a test. Your email setup works.</p>", idempotencyKey: `test-${Date.now()}-${Math.random().toString(36).slice(2)}` },
        { apiKey, ...this.optionsOf(s) }
      );
      return { messageId: r.messageId, provider: s.provider, to: addr };
    } catch (err) {
      if (err instanceof ProviderError && err.code === "PROVIDER_AUTH") await MessagingSettings.updateOne({ companyId }, { $set: { lastAuthFailureAt: new Date() } });
      throw err;
    }
  }
}

module.exports = SettingsService;
