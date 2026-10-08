// What a mail server's answer means and where this system may connect: pure, so the whole table runs
// with no network and no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifySmtp, checkSmtpTarget, SMTP_MESSAGES } = require("../smtp");

const is = (err, code, retryable) => {
  const c = classifySmtp(err);
  assert.equal(c.code, code, JSON.stringify(err));
  assert.equal(c.retryable, retryable, JSON.stringify(err));
  return c;
};

test("a refused login is not retried, and tells the person what to check", () => {
  const c = is({ code: "EAUTH", responseCode: 535, response: "535 5.7.8 Authentication failed" }, "PROVIDER_AUTH", false);
  assert.match(c.message, /app password/);
  is({ responseCode: 534 }, "PROVIDER_AUTH", false);
});

test("a server that cannot be reached or is slow is retried, and the message names the Render free plan", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNECTION", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN"]) is({ code }, "PROVIDER_UNREACHABLE", true);
  for (const code of ["ETIMEDOUT", "ETIMEOUT", "ECONNTIMEOUT"]) is({ code }, "PROVIDER_TIMEOUT", true);
  assert.match(SMTP_MESSAGES.PROVIDER_UNREACHABLE, /Render/);
  assert.match(SMTP_MESSAGES.PROVIDER_TIMEOUT, /Render/);
});

test("a secure-connection failure points at the port and is not retried", () => {
  const c = is({ code: "ESOCKET", message: "error:0A00010B:SSL routines:ssl3_get_record:wrong version number" }, "PROVIDER_REJECTED", false);
  assert.match(c.message, /587/);
  is({ code: "ETLS" }, "PROVIDER_REJECTED", false);
});

test("the sender and the recipient are told apart", () => {
  is({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, "INVALID_ADDRESS", false);
  is({ responseCode: 553, command: "RCPT TO" }, "INVALID_ADDRESS", false);
  is({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 553, response: "553 5.7.1 Sender address rejected" }, "FROM_NOT_VERIFIED", false);
  is({ responseCode: 550, response: "550 5.7.60 SendAsDenied" }, "FROM_NOT_VERIFIED", false);
});

test("temporary answers are retried, limits are told apart, refusals are not retried", () => {
  is({ responseCode: 421 }, "PROVIDER_UNAVAILABLE", true);
  is({ responseCode: 451, response: "451 4.7.0 Temporary server error" }, "PROVIDER_UNAVAILABLE", true);
  is({ responseCode: 452, response: "452 4.5.3 Too many recipients" }, "PROVIDER_RATE_LIMIT", true);
  is({ responseCode: 550, response: "550 5.4.5 Daily user sending quota exceeded" }, "PROVIDER_QUOTA", false);
  const c = is({ responseCode: 554, response: "554 5.7.1 Message rejected as spam" }, "PROVIDER_REJECTED", false);
  assert.match(c.message, /rejected as spam/, "the server's own reason is shown");
});

test("something unknown is not retried, and the raw detail never carries a password", () => {
  const c = is(new TypeError("Cannot read properties of undefined"), "PROVIDER_REJECTED", false);
  assert.equal(c.message, "The message could not be handed to the mail server.");
  assert.equal(JSON.stringify(classifySmtp({ code: "EAUTH", responseCode: 535, response: "535 bad" }).raw).includes("pass"), false);
});

test("only mail ports, and in production nothing on this machine or the private network", () => {
  assert.equal(checkSmtpTarget("smtp.gmail.com", 587).ok, true);
  assert.equal(checkSmtpTarget("smtp.office365.com", "587").ok, true);
  assert.equal(checkSmtpTarget("mail.yourcompany.ae", 465).ok, true);
  assert.equal(checkSmtpTarget("mail.yourcompany.ae", 2525).ok, true);
  assert.match(checkSmtpTarget("smtp.gmail.com", 8080).reason, /port must be one of/);
  assert.match(checkSmtpTarget("smtp.gmail.com", 22).reason, /port must be one of/);
  for (const bad of ["", "not a host", "smtp.gmail.com/path", "http://x.ae", "a b.ae"]) assert.equal(checkSmtpTarget(bad, 587).ok, false, bad);
  const prod = { production: true };
  for (const local of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "box.local", "db.internal"]) {
    assert.equal(checkSmtpTarget(local, 587, prod).ok, false, `${local} must be refused in production`);
    assert.equal(checkSmtpTarget(local, 587).ok, true, `${local} is fine for local testing`);
  }
  assert.equal(checkSmtpTarget("10.1.2.3", 587, { production: true, allowPrivate: true }).ok, true, "an explicit opt-in allows a private relay");
  assert.equal(checkSmtpTarget("8.8.8.8", 587, prod).ok, true, "a public address is not private");
  assert.equal(checkSmtpTarget("172.32.0.1", 587, prod).ok, true, "172.32 is outside the private 172.16/12 block");
});
