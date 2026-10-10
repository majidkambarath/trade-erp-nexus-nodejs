// The platform mailer: one sender for the whole installation, set by the environment. What matters: with nothing configured the
// product still works (and says it did not send), a reset link never reaches a production log, a provider's failure never throws
// into the request that wanted the mail, and the mail itself reads right.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mailer = require("../core/systemMailer");
const { passwordResetMail, securityNoticeMail } = require("../../utils/systemMailTemplates");

const KEYS = ["SYSTEM_MAIL_PROVIDER", "SYSTEM_MAIL_FROM", "SYSTEM_MAIL_FROM_NAME", "SYSTEM_MAIL_API_KEY", "SYSTEM_MAIL_SMTP_HOST", "SYSTEM_MAIL_SMTP_PORT", "SYSTEM_MAIL_SMTP_USER", "SYSTEM_MAIL_SMTP_PASS", "SYSTEM_MAIL_CAPTURE_FILE", "SYSTEM_MAIL_CONSOLE_SHOW", "NODE_ENV", "LOG_SILENT"];

// run `fn` with these variables (others cleared), the console and fetch watched, everything restored afterwards
async function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const logs = [];
  const realInfo = console.info, realError = console.error, realFetch = globalThis.fetch;
  console.info = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  try { return await fn({ logs }); } finally {
    console.info = realInfo; console.error = realError; globalThis.fetch = realFetch;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const message = { to: "nadia@example.com", subject: "Reset your password", text: "open https://app.example/reset-password?token=SECRETTOKEN123", html: "<p>x</p>" };

test("with nothing configured it is the console provider: it succeeds, sends nothing, and says so", async () => {
  await withEnv({}, async ({ logs }) => {
    const r = await mailer.send(message);
    assert.deepEqual(r, { ok: true, provider: "console", messageId: null });
    assert.ok(logs.some((l) => /NOT sent/.test(l)), "it says that no mail went out");
  });
});

test("in production the console provider logs that a mail was skipped and for whom (masked) - never what was in it", async () => {
  await withEnv({ NODE_ENV: "production", SYSTEM_MAIL_CONSOLE_SHOW: "1" }, async ({ logs }) => {
    await mailer.send(message);
    const text = logs.join("\n");
    assert.match(text, /n\*\*\*@example\.com/);
    assert.ok(!text.includes("SECRETTOKEN123"), "the reset link is not in the log");
    assert.ok(!text.includes("nadia@example.com"), "the address is masked");
  });
});

test("away from production it prints the mail only when asked, so a developer can open the link", async () => {
  await withEnv({ NODE_ENV: "development" }, async ({ logs }) => {
    await mailer.send(message);
    assert.ok(logs.join("\n").includes("SECRETTOKEN123"));
  });
  await withEnv({ SYSTEM_MAIL_CONSOLE_SHOW: "1" }, async ({ logs }) => {
    await mailer.send(message);
    assert.ok(logs.join("\n").includes("SECRETTOKEN123"));
  });
  await withEnv({}, async ({ logs }) => {
    await mailer.send(message);
    assert.ok(!logs.join("\n").includes("SECRETTOKEN123"), "not by default: a log is read by many people");
  });
});

test("a capture file records what the console provider would have sent - but never in production", async () => {
  const file = path.join(os.tmpdir(), `system-mail-${process.pid}-${Date.now()}.jsonl`);
  try {
    await withEnv({ SYSTEM_MAIL_CAPTURE_FILE: file, LOG_SILENT: "1" }, async () => {
      await mailer.send(message);
      const [line] = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.deepEqual(JSON.parse(line).to, ["nadia@example.com"]);
      assert.equal(JSON.parse(line).subject, "Reset your password");
    });
    fs.rmSync(file);
    await withEnv({ SYSTEM_MAIL_CAPTURE_FILE: file, NODE_ENV: "production", LOG_SILENT: "1" }, async () => {
      await mailer.send(message);
      assert.equal(fs.existsSync(file), false, "production writes no mail to disk");
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a provider that is not set up fails in words, without throwing", async () => {
  for (const [env, words] of [
    [{ SYSTEM_MAIL_PROVIDER: "resned" }, /resned/],
    [{ SYSTEM_MAIL_PROVIDER: "resend" }, /SYSTEM_MAIL_FROM/],
    [{ SYSTEM_MAIL_PROVIDER: "resend", SYSTEM_MAIL_FROM: "no-reply@example.com" }, /SYSTEM_MAIL_API_KEY/],
    [{ SYSTEM_MAIL_PROVIDER: "smtp", SYSTEM_MAIL_FROM: "no-reply@example.com" }, /SYSTEM_MAIL_SMTP_HOST/],
  ]) {
    await withEnv(env, async () => {
      const r = await mailer.send(message);
      assert.equal(r.ok, false);
      assert.equal(r.code, "MAIL_NOT_CONFIGURED");
      assert.match(r.message, words);
    });
  }
  await withEnv({ SYSTEM_MAIL_PROVIDER: "resend", SYSTEM_MAIL_FROM: "a@example.com", SYSTEM_MAIL_API_KEY: "k" }, async () => {
    globalThis.fetch = async () => { throw new Error("must not be called"); };
    assert.equal((await mailer.send({ ...message, to: [] })).code, "NO_RECIPIENT");
  });
});

test("Resend: one POST to its API with the key as a bearer token, the sender with its display name, and the message as given", async () => {
  await withEnv({ SYSTEM_MAIL_PROVIDER: "resend", SYSTEM_MAIL_FROM: "no-reply@example.com", SYSTEM_MAIL_FROM_NAME: "Zarvia", SYSTEM_MAIL_API_KEY: "re_test_key" }, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "msg_123" }) };
    };
    const r = await mailer.send(message);
    assert.deepEqual(r, { ok: true, provider: "resend", messageId: "msg_123" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.from, "Zarvia <no-reply@example.com>");
    assert.deepEqual(body.to, ["nadia@example.com"]);
    assert.equal(body.subject, "Reset your password");
    assert.equal(body.text, message.text);
  });
});

test("a provider that refuses (a bad key, no network) comes back as ok:false - it never throws, and the key is not in what is returned or logged", async () => {
  await withEnv({ SYSTEM_MAIL_PROVIDER: "resend", SYSTEM_MAIL_FROM: "no-reply@example.com", SYSTEM_MAIL_API_KEY: "re_very_secret_key" }, async ({ logs }) => {
    globalThis.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ message: "API key is invalid" }) });
    const refused = await mailer.send(message);
    assert.equal(refused.ok, false);
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    const down = await mailer.send(message);
    assert.equal(down.ok, false);
    assert.ok(!JSON.stringify([refused, down, logs]).includes("re_very_secret_key"));
  });
});

test("the reset mail carries the link in both parts, says it works once, and escapes a name that is HTML", () => {
  const url = "https://app.example/reset-password?token=abc_DEF-123";
  const mail = passwordResetMail({ name: "<img src=x onerror=alert(1)>", url, minutes: 30 });
  assert.match(mail.subject, /^Reset your .* password$/);
  assert.ok(mail.text.includes(url));
  assert.ok(mail.html.includes(`href="${url}"`));
  assert.ok(!mail.html.includes("<img src=x"), "the name cannot inject markup");
  assert.match(mail.text, /30 minutes/);
  assert.match(mail.text, /did not ask for this/i);
  assert.ok(!/<script|<img|https?:\/\/(?!app\.example)/i.test(mail.html), "no scripts, no images, no tracking pixel, no other host");
});

test("a security notice names what happened and what to do if it was not the person", () => {
  const mail = securityNoticeMail({ name: "Nadia", headline: "Two-factor sign-in was turned off", detail: "Signing in no longer asks for a code." });
  assert.match(mail.subject, /Two-factor sign-in was turned off/);
  assert.match(mail.text, /Hello Nadia/);
  assert.match(mail.text, /If this was not you/);
  assert.match(mail.html, /Signing in no longer asks for a code/);
});
