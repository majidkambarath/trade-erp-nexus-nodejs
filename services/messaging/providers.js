// Email providers: how a message leaves the system. Each exposes one method,
//
//   send(message, { apiKey, timeoutMs, fetch }) -> { messageId, raw }
//
// where message = { from, to[], cc[], bcc[], replyTo, subject, html, text, attachments[], idempotencyKey }
// and throws ProviderError({ retryable, code }) on failure. A temporary fault is retryable; a refusal
// (bad key, unverified sender, refused address) is not and waits for a person.
//
// "console" needs no account. It records the send and posts nothing, and is driven by the first
// recipient so every path of the pipeline can be exercised, the way the e-invoice sandbox is driven by
// the buyer name. "resend" talks to api.resend.com with fetch, and fetch is looked up at call time so a
// test can replace it and assert the exact request without a network. "smtp" hands the message to a
// mailbox's own mail server with nodemailer: for a client that already has a mailbox and no wish to
// verify a domain at a sending service.
const { ProviderError } = require("../../utils/providerError");
const { classify, MESSAGES } = require("../../utils/mailErrors");
const { classifySmtp, SMTP_MESSAGES, SSL_PORT, isLoopbackHost } = require("../../utils/smtp");

const failure = (code, retryable, extra = {}) => new ProviderError(MESSAGES[code], { retryable, code, ...extra });

// "Name <address>", with anything that could break out of the display name taken out.
const formatFrom = (name, email) => {
  const clean = String(name || "").replace(/[<>"\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
};

const onceFailed = new Set(); // for "netfailonce": fail the first attempt of a message, accept the next

const consoleProvider = {
  async send(message) {
    const first = String(message.to?.[0] || "").toLowerCase();
    const local = first.split("@")[0];
    if (local === "netfail") throw failure("PROVIDER_UNREACHABLE", true);
    if (local === "netfailonce" && !onceFailed.has(message.idempotencyKey)) {
      onceFailed.add(message.idempotencyKey);
      throw failure("PROVIDER_UNREACHABLE", true);
    }
    if (local === "ratelimit") throw failure("PROVIDER_RATE_LIMIT", true, { retryAfterMs: 1000 });
    if (local === "badaddr") throw failure("INVALID_ADDRESS", false, { status: 422 });
    if (local === "authfail") throw failure("PROVIDER_AUTH", false, { status: 401 });
    if (!process.env.LOG_SILENT && process.env.NODE_ENV !== "test") {
      console.info(`[messaging] console provider: would send "${message.subject}" to ${message.to.join(", ")}`);
    }
    return { messageId: `console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, raw: { provider: "console" } };
  },
};

const RESEND_URL = "https://api.resend.com/emails";

const resendProvider = {
  async send(message, { apiKey, timeoutMs = 15000, fetch: fetchImpl } = {}) {
    const doFetch = fetchImpl || globalThis.fetch;
    const body = {
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.cc?.length) body.cc = message.cc;
    if (message.bcc?.length) body.bcc = message.bcc;
    if (message.replyTo) body.reply_to = message.replyTo;
    if (message.attachments?.length) {
      body.attachments = message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") }));
    }

    let res;
    try {
      res = await doFetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": String(message.idempotencyKey),
          "User-Agent": "zarvia-erp/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw failure(timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE", true, { raw: { error: String(err?.message || err) } });
    }

    let json = null;
    try {
      json = await res.json();
    } catch (_) { /* an empty or non-JSON body: the status still says what happened */ }

    if (res.ok) return { messageId: json?.id || null, raw: json ? { id: json.id } : null };
    const c = classify(res.status, json, { retryAfter: res.headers?.get?.("retry-after") });
    throw new ProviderError(c.message, { retryable: c.retryable, status: res.status, raw: json, code: c.code, retryAfterMs: c.retryAfterMs });
  },
};

// SMTP has no idempotency key, so a message that times out after the server took it can arrive twice.
// A Message-ID that is the same for every try of one row gives the receiving mailbox the chance to see
// the second copy for what it is. Only characters that are safe in an id are kept.
const stableMessageId = (key, from) => {
  const id = String(key || "").replace(/[^A-Za-z0-9._-]/g, "");
  const host = (String(from || "").match(/@([A-Za-z0-9.-]+)>?\s*$/) || [])[1] || "zarvia.local";
  return id ? `<${id}@${host}>` : undefined;
};

const smtpProvider = {
  // apiKey is the mailbox password; smtp is { host, port, user }. createTransport is injectable for tests.
  async send(message, { apiKey, smtp, timeoutMs = 20000, createTransport } = {}) {
    if (!smtp?.host) throw new ProviderError(SMTP_MESSAGES.NOT_SET, { retryable: false, code: "MESSAGING_NOT_CONFIGURED" });
    const port = Number(smtp.port) || 587;
    const make = createTransport || require("nodemailer").createTransport;
    const transport = make({
      host: smtp.host,
      port,
      secure: port === SSL_PORT, // 465 is secure from the first byte; the others must upgrade before the password is sent
      requireTLS: port !== SSL_PORT && !isLoopbackHost(smtp.host),
      auth: smtp.user ? { user: smtp.user, pass: apiKey || "" } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs * 2,
      tls: { minVersion: "TLSv1.2" },
      disableFileAccess: true, // an attachment can only be the bytes we hand over, never a path or a URL
      disableUrlAccess: true,
    });
    try {
      const info = await transport.sendMail({
        from: message.from, to: message.to, cc: message.cc?.length ? message.cc : undefined, bcc: message.bcc?.length ? message.bcc : undefined,
        replyTo: message.replyTo, subject: message.subject, html: message.html, text: message.text,
        attachments: (message.attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType || "application/pdf" })),
        messageId: stableMessageId(message.idempotencyKey, message.from),
      });
      return { messageId: info.messageId || null, raw: { accepted: info.accepted || [], rejected: info.rejected || [], response: String(info.response || "").slice(0, 200) } };
    } catch (err) {
      const c = classifySmtp(err);
      throw new ProviderError(c.message, { retryable: c.retryable, code: c.code, raw: c.raw });
    } finally {
      try { transport.close?.(); } catch (_) { /* already closed */ }
    }
  },
};

const PROVIDERS = { console: consoleProvider, resend: resendProvider, smtp: smtpProvider };

module.exports = { PROVIDERS, ProviderError, formatFrom, RESEND_URL, stableMessageId };
