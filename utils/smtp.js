// Sending through a mailbox's own SMTP server (nodemailer), as plain rules with no network in them so
// the whole table is tested without one.
//
// Two things live here: what a failure from the mail server means (and whether trying again can help),
// and where this system is allowed to connect. The second matters because an admin types the server
// name and port, and the server then dials it: without a limit that is a way to probe the network the
// server runs in.
const net = require("net");

const SMTP_PORTS = [25, 465, 587, 2525];
const SSL_PORT = 465; // secure from the first byte; every other port starts plain and upgrades (STARTTLS)

const RENDER_HINT = "If this system is hosted on Render's free plan, it cannot reach mail servers at all: use Resend instead, or move to a paid plan.";

// What a person is told. Plain words, no protocol jargon.
const SMTP_MESSAGES = {
  PROVIDER_AUTH: "The mail server refused the username or password. Check them in Settings, under Sending. Gmail and Microsoft 365 need an app password, not the normal one.",
  PROVIDER_UNREACHABLE: `We could not reach the mail server. Check the server name and port. ${RENDER_HINT} It will try again shortly.`,
  PROVIDER_TIMEOUT: `The mail server took too long to answer. ${RENDER_HINT} It will try again shortly.`,
  TLS: "The secure connection to the mail server failed. The port is probably wrong: use 587 for most servers, and 465 only if your provider says so.",
  INVALID_ADDRESS: "The mail server refused one of the addresses. Check them and try again.",
  FROM_NOT_VERIFIED: "The mail server does not allow this sender address. Most servers accept only the mailbox you log in with, or an alias of it.",
  PROVIDER_QUOTA: "The mailbox has reached its sending limit for now. The message was not sent; try again later.",
  PROVIDER_RATE_LIMIT: "The mail server is slowing us down. It will try again shortly.",
  PROVIDER_UNAVAILABLE: "The mail server asked us to try again later. It will try again shortly.",
  PROVIDER_REJECTED: "The mail server refused this message.",
  NOT_SET: "The mail server is not set up. Open Settings, under Sending.",
};

const UNREACHABLE = new Set(["ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EDNS", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ECONNRESET", "ECONNABORTED", "EPIPE", "EAI_AGAIN", "ESOCKET"]);
const TIMEOUT = new Set(["ETIMEDOUT", "ETIMEOUT", "ECONNTIMEOUT", "EGREETING"]);
const TLS_TEXT = /wrong version number|ssl routines|tls|certificate|handshake|unsupported protocol/i;
const LIMIT_TEXT = /daily|quota|limit|too many|exceed/i;
const SENDER_TEXT = /sender|from address|send as|sendas|not owned|not authori[sz]ed|not allowed to send|does not own/i;

// err is what nodemailer throws: { code, responseCode, command, response, message }.
function classifySmtp(err) {
  const code = String(err?.code || "").toUpperCase();
  const rc = Number(err?.responseCode) || 0;
  const command = String(err?.command || "").toUpperCase();
  const text = `${err?.response || ""} ${err?.message || ""}`;
  const out = (c, retryable, message = SMTP_MESSAGES[c], extra = {}) => ({
    code: c, retryable, message,
    raw: { code: err?.code || null, responseCode: rc || null, command: err?.command || null, response: String(err?.response || err?.message || "").slice(0, 300) },
    ...extra,
  });
  const detail = (base) => { const d = String(err?.response || "").replace(/\s+/g, " ").trim().slice(0, 160); return d ? `${base} (${d})` : base; };

  if (code === "EAUTH" || rc === 535 || rc === 534 || rc === 530 || rc === 454) return out("PROVIDER_AUTH", false);
  if (code === "ETLS" || (code === "ESOCKET" && TLS_TEXT.test(text)) || (code === "ECONNECTION" && TLS_TEXT.test(text))) return out("PROVIDER_REJECTED", false, SMTP_MESSAGES.TLS);
  if (TIMEOUT.has(code)) return out("PROVIDER_TIMEOUT", true);
  if (UNREACHABLE.has(code)) return out("PROVIDER_UNREACHABLE", true);
  // nodemailer names the command the server refused: MAIL FROM is the sender, RCPT TO a recipient.
  if (command.startsWith("MAIL") && rc >= 500) return out("FROM_NOT_VERIFIED", false);
  if (code === "EENVELOPE" || ([550, 551, 553, 501].includes(rc) && command.startsWith("RCPT"))) return out("INVALID_ADDRESS", false);
  if (rc >= 500 && (command.startsWith("MAIL") || SENDER_TEXT.test(text))) return out("FROM_NOT_VERIFIED", false);
  if (rc >= 500 && LIMIT_TEXT.test(text)) return out("PROVIDER_QUOTA", false);
  if (rc >= 400 && rc < 500) return LIMIT_TEXT.test(text) ? out("PROVIDER_RATE_LIMIT", true) : out("PROVIDER_UNAVAILABLE", true);
  if (rc >= 500) return out("PROVIDER_REJECTED", false, detail(SMTP_MESSAGES.PROVIDER_REJECTED));
  // Not something the mail server said and not a network fault we know: a fault of ours or an odd one.
  // Trying again would repeat it, so a person looks.
  return out("PROVIDER_REJECTED", false, "The message could not be handed to the mail server.");
}

const LOOPBACK = new Set(["localhost", "ip6-localhost"]);
const privateIPv4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Where we may connect. { ok: true } or { ok: false, reason }. Nothing that is not a mail port, and in
// production nothing that points at this machine or the private network (a host NAME that resolves to
// one is not caught here: this is a guard against a mistake, not a boundary). Outside production a
// local test mail server is fine.
function checkSmtpTarget(host, port, { production = false, allowPrivate = false } = {}) {
  const h = String(host || "").trim().toLowerCase();
  if (!h || !(net.isIP(h) || HOSTNAME.test(h))) return { ok: false, reason: "That does not look like a mail server name, for example smtp.yourcompany.ae" };
  if (!SMTP_PORTS.includes(Number(port))) return { ok: false, reason: `The port must be one of ${SMTP_PORTS.join(", ")}. Most servers use 587.` };
  const local = LOOPBACK.has(h) || h.endsWith(".local") || h.endsWith(".internal") || (net.isIPv4(h) && privateIPv4(h)) || (net.isIPv6(h) && (h === "::1" || /^(fc|fd|fe80)/.test(h)));
  if (local && production && !allowPrivate) return { ok: false, reason: "A mail server on this machine or the private network cannot be used." };
  return { ok: true };
}

const isLoopbackHost = (host) => LOOPBACK.has(String(host || "").toLowerCase()) || ["127.0.0.1", "::1"].includes(String(host || ""));

module.exports = { SMTP_PORTS, SSL_PORT, SMTP_MESSAGES, classifySmtp, checkSmtpTarget, isLoopbackHost };
