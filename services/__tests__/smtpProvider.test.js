// The SMTP provider with the transport replaced: no network, no database, no mailbox. It pins down
// exactly what is handed to nodemailer and what each failure becomes, so a change to either fails here
// and not in a client's mailbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const { PROVIDERS, ProviderError, stableMessageId } = require("../messaging/providers");

const message = (over = {}) => ({
  from: "Harbour Trading <accounts@harbour.ae>", to: ["ali@alnoor.ae"], cc: ["boss@alnoor.ae"], bcc: [], replyTo: "ar@harbour.ae",
  subject: "Tax invoice INV-1", html: "<p>hi</p>", text: "hi", idempotencyKey: "64f0a1b2c3d4",
  attachments: [{ filename: "Tax-invoice_INV-1.pdf", content: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" }],
  ...over,
});
const SMTP = { host: "smtp.harbour.ae", port: 587, user: "accounts@harbour.ae" };

// A fake nodemailer: records how it was built and what it was asked to send.
const fake = (behaviour = async () => ({ messageId: "<m1@harbour.ae>", accepted: ["ali@alnoor.ae"], rejected: [], response: "250 2.0.0 OK" })) => {
  const seen = { closed: 0 };
  const createTransport = (options) => {
    seen.options = options;
    return { sendMail: async (mail) => { seen.mail = mail; return behaviour(mail); }, close: () => { seen.closed += 1; } };
  };
  return { seen, createTransport };
};
const send = (f, msg = message(), extra = {}) => PROVIDERS.smtp.send(msg, { apiKey: "s3cret-pass", smtp: SMTP, createTransport: f.createTransport, ...extra });
const failureOf = async (f, msg) => { try { await send(f, msg); } catch (e) { return e; } throw new Error("expected a failure"); };

test("the connection is built the safe way: login, TLS floor, no files or URLs", async () => {
  const f = fake();
  await send(f);
  const o = f.seen.options;
  assert.equal(o.host, "smtp.harbour.ae");
  assert.equal(o.port, 587);
  assert.equal(o.secure, false, "587 starts plain and must upgrade");
  assert.equal(o.requireTLS, true, "the password is never sent before the upgrade");
  assert.deepEqual(o.auth, { user: "accounts@harbour.ae", pass: "s3cret-pass" });
  assert.equal(o.tls.minVersion, "TLSv1.2");
  assert.equal(o.disableFileAccess, true);
  assert.equal(o.disableUrlAccess, true);
  assert.ok(o.connectionTimeout > 0 && o.greetingTimeout > 0 && o.socketTimeout > 0, "nothing can hang forever");
  assert.equal(f.seen.closed, 1, "the connection is closed");
});

test("port 465 is secure from the first byte; a local test server may skip TLS; a relay with no login sends no auth", async () => {
  const a = fake(); await send(a, message(), { smtp: { ...SMTP, port: 465 } });
  assert.equal(a.seen.options.secure, true);
  assert.equal(a.seen.options.requireTLS, false);
  const b = fake(); await send(b, message(), { smtp: { host: "localhost", port: 25, user: "" } });
  assert.equal(b.seen.options.requireTLS, false);
  assert.equal(b.seen.options.auth, undefined);
});

test("the mail is exactly the message: addresses, bytes, a stable Message-ID, nothing empty", async () => {
  const f = fake();
  const r = await send(f);
  const m = f.seen.mail;
  assert.equal(m.from, "Harbour Trading <accounts@harbour.ae>");
  assert.deepEqual(m.to, ["ali@alnoor.ae"]);
  assert.deepEqual(m.cc, ["boss@alnoor.ae"]);
  assert.equal(m.bcc, undefined, "an empty bcc is not sent");
  assert.equal(m.replyTo, "ar@harbour.ae");
  assert.equal(m.subject, "Tax invoice INV-1");
  assert.equal(m.html, "<p>hi</p>");
  assert.equal(m.text, "hi");
  assert.equal(m.attachments.length, 1);
  assert.ok(Buffer.isBuffer(m.attachments[0].content));
  assert.equal(m.attachments[0].content.toString(), "%PDF-1.4 fake");
  assert.equal(m.attachments[0].filename, "Tax-invoice_INV-1.pdf");
  assert.equal(m.attachments[0].contentType, "application/pdf");
  assert.equal(m.messageId, "<64f0a1b2c3d4@harbour.ae>", "every try of one row carries the same id, so a double delivery can be seen for what it is");
  assert.deepEqual(r, { messageId: "<m1@harbour.ae>", raw: { accepted: ["ali@alnoor.ae"], rejected: [], response: "250 2.0.0 OK" } });
});

test("the Message-ID keeps only safe characters and survives a bare address", () => {
  assert.equal(stableMessageId("a b<c>@d", "x@harbour.ae"), "<abcd@harbour.ae>");
  assert.equal(stableMessageId("k1", "Name <accounts@acme.ae>"), "<k1@acme.ae>");
  assert.equal(stableMessageId("k1", "nonsense"), "<k1@zarvia.local>");
  assert.equal(stableMessageId("", "x@harbour.ae"), undefined);
});

test("a link-only email has no attachment, and the mail is still sent", async () => {
  const f = fake();
  await send(f, message({ attachments: [] }));
  assert.deepEqual(f.seen.mail.attachments, []);
});

test("failures become ProviderErrors with the right retry, plain words, and no password anywhere", async () => {
  const cases = [
    [{ code: "EAUTH", responseCode: 535, response: "535 5.7.8 nope" }, "PROVIDER_AUTH", false],
    [{ code: "ECONNREFUSED" }, "PROVIDER_UNREACHABLE", true],
    [{ code: "ETIMEDOUT" }, "PROVIDER_TIMEOUT", true],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, "INVALID_ADDRESS", false],
    [{ responseCode: 451 }, "PROVIDER_UNAVAILABLE", true],
  ];
  for (const [thrown, code, retryable] of cases) {
    const f = fake(async () => { throw Object.assign(new Error(`boom with pass s3cret-pass ${code}`), thrown); });
    const e = await failureOf(f);
    assert.ok(e instanceof ProviderError, code);
    assert.equal(e.code, code);
    assert.equal(e.retryable, retryable, code);
    assert.equal(e.message.includes("s3cret-pass"), false, "the message a person reads never holds the password");
    assert.equal(f.seen.closed, 1, `${code}: the connection is closed after a failure too`);
  }
});

test("with no mail server set, it refuses at once and says where to fix it", async () => {
  const f = fake();
  const e = await PROVIDERS.smtp.send(message(), { apiKey: "x", smtp: { host: "", port: 587 }, createTransport: f.createTransport }).catch((x) => x);
  assert.equal(e.code, "MESSAGING_NOT_CONFIGURED");
  assert.equal(e.retryable, false);
  assert.match(e.message, /Settings/);
  assert.equal(f.seen.options, undefined, "nothing was dialled");
});
