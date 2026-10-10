// The mail the PLATFORM sends about a person's own account: a password-reset link, a notice that two-factor was switched off.
//
// Not the messaging pipeline (services/messaging/*): that sends a customer's documents, per organisation, with the
// organisation's own provider and keys, a send history and retries. This is one sender for the whole installation, set by the
// environment, with no history and no retry: a reset mail that did not arrive is asked for again.
//
//   SYSTEM_MAIL_PROVIDER  console (default) | resend | smtp
//   SYSTEM_MAIL_FROM      the address mail comes from (a domain the provider has verified); SYSTEM_MAIL_FROM_NAME its display name
//   SYSTEM_MAIL_API_KEY   the Resend key
//   SYSTEM_MAIL_SMTP_HOST / _PORT / _USER / _PASS   a mailbox's own server
//
// "console" needs nothing and sends nothing, so the whole product works with no account. It says THAT a mail would have gone,
// to whom (masked), and never what is in it in production: a reset link is a password, and a log is read by many people. Away
// from production it prints the text too, so a developer can open the link; the capture file (tests only) records it.
//
// send() never throws and returns { ok, provider, ... }: whoever asks for a mail must not fail, or answer differently, because
// the mail could not be sent.
const fs = require("fs");
const crypto = require("crypto");
const { PROVIDERS, formatFrom } = require("../messaging/providers");

const KNOWN = ["console", "resend", "smtp"];
const production = () => process.env.NODE_ENV === "production";

function configuration(env = process.env) {
  const provider = String(env.SYSTEM_MAIL_PROVIDER || "console").trim().toLowerCase();
  return {
    provider,
    from: String(env.SYSTEM_MAIL_FROM || "").trim(),
    fromName: String(env.SYSTEM_MAIL_FROM_NAME || "Zarvia").trim(),
    replyTo: String(env.SYSTEM_MAIL_REPLY_TO || "").trim() || undefined,
    apiKey: env.SYSTEM_MAIL_API_KEY || "",
    smtp: { host: String(env.SYSTEM_MAIL_SMTP_HOST || "").trim(), port: Number(env.SYSTEM_MAIL_SMTP_PORT) || 587, user: String(env.SYSTEM_MAIL_SMTP_USER || "").trim() },
    smtpPass: env.SYSTEM_MAIL_SMTP_PASS || "",
  };
}

// What is missing for the provider chosen, in words; null when it can send.
function problemWith(c) {
  if (!KNOWN.includes(c.provider)) return `SYSTEM_MAIL_PROVIDER is "${c.provider}"; use console, resend or smtp`;
  if (c.provider === "console") return null;
  if (!c.from) return "SYSTEM_MAIL_FROM is not set";
  if (c.provider === "resend" && !c.apiKey) return "SYSTEM_MAIL_API_KEY is not set";
  if (c.provider === "smtp" && !c.smtp.host) return "SYSTEM_MAIL_SMTP_HOST is not set";
  return null;
}

// a***@example.com: enough to see where a mail went, not a list of addresses in a log
const mask = (address) => String(address || "").replace(/^(.).*(@.*)$/, "$1***$2");

function recordInConsole(message) {
  const file = process.env.SYSTEM_MAIL_CAPTURE_FILE;
  // Tests read what would have been sent from a file. Never in production: it would write reset links to disk.
  if (file && !production()) {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), to: message.to, subject: message.subject, text: message.text, html: message.html })}\n`);
    } catch (_) { /* a capture that cannot be written must not fail the request */ }
  }
  if (process.env.LOG_SILENT || process.env.NODE_ENV === "test") return;
  // The body (a reset link is a password) is printed only when asked for, and never in production.
  const showBody = !production() && (process.env.SYSTEM_MAIL_CONSOLE_SHOW === "1" || process.env.NODE_ENV === "development");
  if (showBody) console.info(`[system-mail] console provider: to ${message.to.join(", ")}\n  subject: ${message.subject}\n${String(message.text || "").split("\n").map((l) => `  ${l}`).join("\n")}`);
  else console.info(`[system-mail] console provider: "${message.subject}" for ${message.to.map(mask).join(", ")} was NOT sent (SYSTEM_MAIL_PROVIDER is console; set SYSTEM_MAIL_CONSOLE_SHOW=1 to print it here away from production)`);
}

/** Send { to, subject, text, html }. Resolves { ok: true, provider, messageId } or { ok: false, provider, code, message }; never throws. */
async function send({ to, subject, text, html }) {
  const c = configuration();
  try {
    const problem = problemWith(c);
    if (problem) {
      console.error(`[system-mail] not sent: ${problem}`);
      return { ok: false, provider: c.provider, code: "MAIL_NOT_CONFIGURED", message: problem };
    }
    const recipients = [].concat(to).filter(Boolean);
    if (!recipients.length) return { ok: false, provider: c.provider, code: "NO_RECIPIENT", message: "There is nobody to send this to" };
    const message = {
      from: c.provider === "console" ? "no-reply@localhost" : formatFrom(c.fromName, c.from),
      to: recipients, cc: [], bcc: [], replyTo: c.replyTo, subject, html, text, attachments: [],
      idempotencyKey: crypto.randomUUID(),
    };
    if (c.provider === "console") {
      recordInConsole(message);
      return { ok: true, provider: "console", messageId: null };
    }
    const result = c.provider === "resend"
      ? await PROVIDERS.resend.send(message, { apiKey: c.apiKey })
      : await PROVIDERS.smtp.send(message, { apiKey: c.smtpPass, smtp: c.smtp });
    return { ok: true, provider: c.provider, messageId: result?.messageId || null };
  } catch (error) {
    // The provider's words are about the provider ("the key was refused"), never about the person; they go to the log, not the caller.
    console.error(`[system-mail] ${c.provider} could not send "${subject}": ${error?.message || error}`);
    return { ok: false, provider: c.provider, code: error?.code || "MAIL_FAILED", message: String(error?.message || error) };
  }
}

module.exports = { send, configuration, problemWith, mask };
