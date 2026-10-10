// AUTHENTICATION, attacked. Against real, strict servers and a throwaway database, as someone who wants in and is willing to be rude:
//
//   - one kind of token cannot stand in for another (a refresh token is not an access token, a challenge is neither, a console token
//     opens no customer door), and a token signed with the wrong key, the old default key, or no key at all opens nothing
//   - a session that has ended is over EVERYWHERE at once: logout, a password change, an administrator's reset, switching a person off
//   - a stolen refresh cookie is single use: replaying a rotated one ends the whole session
//   - the credential fields are not a query language, and the answers do not say which accounts exist (nor, by timing, which do)
//   - the lock-out is a real guard: parallel guesses do not get past it, a stolen session cannot guess the password through
//     "change password", and a rotating X-Forwarded-For does not buy a fresh allowance
//   - the emailed link points where the configuration says, whatever Host the request claims, and a name is text, not markup
//
// Each rule here was seen failing against the code as it was before the hardening (see "Account security -> Attack tests" in CLAUDE.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const totp = require("../../utils/totp");
const tokens = require("../../utils/accountTokens");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 150);
const PORT_B = PORT + 150; // tiny failure limit, the proxy not trusted
const PORT_C = PORT + 300; // tiny failure limit, ONE proxy hop trusted
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE_B = `http://127.0.0.1:${PORT_B}/api/v1`;
const BASE_C = `http://127.0.0.1:${PORT_C}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const CAPTURE = path.join(os.tmpdir(), `auth-attack-mail-${process.pid}-${Date.now()}.jsonl`);
const PASSWORD = "12312312";
const APP_URL = "https://app.attack.test";
const GRACE = 10; // seconds a rotated refresh token is still honoured (two tabs refreshing together)
const DEV = { name: "Dev Attack", email: "dev@attack.test", password: "a-long-passphrase-123" };

let children = [], M, Org, ctx, PlatformAuth;
let logs = "";
const T = {};

// ---- plumbing ------------------------------------------------------------------------------------------------------------------

async function call(method, url, { body, token, base = BASE, cookie, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h["Content-Type"] = h["Content-Type"] || "application/json"; payload = JSON.stringify(body); }
  const started = Date.now();
  const res = await fetch(`${base}${url}`, { method, headers: h, body: payload });
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  let data = null;
  if (type.includes("json")) { try { data = JSON.parse(text); } catch (_) { data = null; } }
  const set = res.headers.getSetCookie?.() || [];
  const sessionCookie = set.find((c) => c.startsWith("erp_session=")) || null;
  return {
    status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, message: data?.message, text, headers: res.headers, ms: Date.now() - started,
    setCookie: sessionCookie, cookie: sessionCookie ? sessionCookie.split(";")[0] : null,
  };
}
// A request with full control of the Host header (fetch cannot send a forged one on every platform).
function rawRequest({ method = "GET", urlPath, headers = {}, body, port = PORT }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let data = null; try { data = JSON.parse(text); } catch (_) { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, data, code: data?.errorCode || data?.error }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const signIn = (email, password = PASSWORD, opts = {}) => call("POST", "/login", { body: { email, password }, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const person = (email, org = "atk") => as(org, () => M.Admin.findOne({ email }).select("+password +loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.recoveryCodes").lean());
const forgive = (email, org = "atk") => as(org, () => M.Admin.updateOne({ email }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const tokenOf = (cookie) => cookie.replace(/^erp_session=/, "");
const make = (org, name, email, type = "operator", extra = {}) => as(org, () => new M.Admin({ name, email, password: PASSWORD, type, status: "active", isActive: true, ...extra }).save());
const userCount = { n: 0 };
// a fresh account for a test that needs a clean lock-out count and sessions of its own
async function fresh(prefix, type = "operator", extra = {}) {
  const email = `${prefix}${++userCount.n}@attack.test`;
  const admin = await make("atk", `${prefix} person`, email, type, extra);
  return { email, id: String(admin._id) };
}

function start(port, extraEnv = {}) {
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", NODE_ENV: "test",
      SYSTEM_MAIL_PROVIDER: "console", SYSTEM_MAIL_CAPTURE_FILE: CAPTURE, FORGOT_PASSWORD_MIN_MS: "50", PUBLIC_APP_URL: APP_URL,
      FORGOT_PASSWORD_IP_LIMIT: "1000", RESET_PASSWORD_IP_LIMIT: "1000", LOGIN_FAILURE_LIMIT: "100000", REFRESH_REUSE_GRACE_SECONDS: String(GRACE),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  children.push(child);
}
async function waitUp(base) {
  const deadline = Date.now() + 120000;
  for (;;) {
    try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).ready !== false) return; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await sleep(400);
  }
}
const mails = () => (fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const mailsTo = (address) => mails().filter((m) => m.to.includes(address));
async function nextMailTo(address, already) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = mailsTo(address);
    if (found.length > already) return found[found.length - 1];
    if (Date.now() > deadline) throw new Error(`no mail arrived for ${address}`);
    await sleep(100);
  }
}
const codeNow = (secret, steps = 0) => totp.totp(secret, { time: Date.now() + steps * 30000 });
const settleInStep = async () => { const into = Date.now() % 30000; if (into > 18000) await sleep(30000 - into + 1500); };
const aLaterStep = (email, org = "atk") => as(org, () => M.Admin.updateOne({ email }, { $set: { "twoFactor.lastStep": totp.stepAt(Date.now()) - 3 } }));
// sign a person in and switch their two-factor on; returns { secret, recoveryCodes, token }
async function withTwoFactor(email) {
  const first = await signIn(email);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const token = first.body.tokens.accessToken;
  const setup = await call("POST", "/auth/2fa/setup", { token, body: { password: PASSWORD } });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  await settleInStep();
  const on = await call("POST", "/auth/2fa/enable", { token, body: { code: codeNow(setup.body.secret) } });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  return { secret: setup.body.secret, recoveryCodes: on.body.recoveryCodes, token };
}
const signedWithoutKey = (claims) => `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
const claimsOf = (token) => jwt.decode(token);

test.before(async () => {
  if (skip) return;
  fs.rmSync(CAPTURE, { force: true });
  start(PORT);
  start(PORT_B, { LOGIN_FAILURE_LIMIT: "5", REFRESH_FAILURE_LIMIT: "5", TRUST_PROXY_HOPS: "0" });
  start(PORT_C, { LOGIN_FAILURE_LIMIT: "5", TRUST_PROXY_HOPS: "1" });
  await mongoose.connect(process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`));
  M = {
    Admin: require("../../models/core/adminModel"),
    Activity: require("../../models/modules/financial/activityLogModel"),
    Session: require("../../models/core/authSessionModel"),
    PasswordReset: require("../../models/core/passwordResetModel"),
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  PlatformAuth = require("../platform/platformAuthService");
  await mongoose.connection.syncIndexes();
  await waitUp(BASE);
  await waitUp(BASE_B);
  await waitUp(BASE_C);
});
test.after(async () => {
  if (skip) return;
  children.forEach((c) => c.kill());
  fs.rmSync(CAPTURE, { force: true });
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// =====================================================================================================================
// the scene
// =====================================================================================================================

test("two organisations, a few people, and a developer-console account", { skip }, async () => {
  for (const [code, name] of [["atk", "Attack Trading"], ["atk2", "Other Trading"]]) {
    assert.equal((await Org.create({ legalName: name, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  }
  await make("atk", "Owen Owner", "owner@attack.test", "super_admin");
  await make("atk", "Sam Admin", "sam@attack.test", "admin");
  await make("atk", "Omar Operator", "omar@attack.test", "operator");
  await make("atk", "Will Viewer", "will@attack.test", "viewer");
  await make("atk2", "Zoe Other", "zoe@other.test", "super_admin");
  await PlatformAuth.create(DEV);
  for (const [who, email] of [["owner", "owner@attack.test"], ["sam", "sam@attack.test"], ["omar", "omar@attack.test"], ["zoe", "zoe@other.test"]]) {
    const r = await signIn(email);
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.data)}`);
    T[who] = r.body.tokens.accessToken;
    T[`${who}Cookie`] = r.cookie;
  }
  const dev = await call("POST", "/platform/login", { body: { email: DEV.email, password: DEV.password } });
  assert.equal(dev.status, 200, JSON.stringify(dev.data));
  T.platform = dev.body.token;
});

// =====================================================================================================================
// one kind of token is not another
// =====================================================================================================================

test("a REFRESH token is not an access token: the 30-day cookie opens no API door", { skip }, async () => {
  const u = await fresh("rt");
  const login = await signIn(u.email);
  const refresh = tokenOf(login.cookie);
  assert.equal(claimsOf(refresh).type, "refresh");
  const r = await call("GET", "/organisation/status", { token: refresh });
  assert.equal(r.status, 401, `a refresh token opened the API (${r.status}): ${r.text.slice(0, 120)}`);
  assert.equal(r.code, "INVALID_TOKEN_TYPE");
  // ...on every kind of route, not only that one
  for (const url of ["/profile/me", "/currencies", "/customers/customers", "/transactions/transactions", "/auth/2fa"]) {
    assert.equal((await call("GET", url, { token: refresh })).status, 401, url);
  }
  // the access token it sits beside still works, and is marked as one
  assert.equal(claimsOf(login.body.tokens.accessToken).use, "access");
  assert.equal((await call("GET", "/organisation/status", { token: login.body.tokens.accessToken })).status, 200);
});

test("an ACCESS token is not a session cookie, and the refresh route takes the cookie and nothing else", { skip }, async () => {
  const u = await fresh("at");
  const login = await signIn(u.email);
  const access = login.body.tokens.accessToken;
  assert.equal((await call("POST", "/refresh-token", { cookie: `erp_session=${access}`, body: {} })).status, 401, "an access token in the cookie");
  // a valid refresh token anywhere but the cookie is ignored
  const refresh = tokenOf(login.cookie);
  assert.equal((await call("POST", "/refresh-token", { body: { refreshToken: refresh, token: refresh } })).status, 401, "in the body");
  assert.equal((await call("POST", "/refresh-token", { token: refresh, body: {} })).status, 401, "as a bearer token");
  assert.equal((await call("POST", "/refresh-token", { headers: { "x-refresh-token": refresh }, body: {} })).status, 401, "in a header");
  assert.equal((await call("POST", "/refresh-token", { cookie: "erp_session=not.a.jwt", body: {} })).status, 401);
  assert.equal((await call("POST", "/refresh-token", { cookie: "erp_session=", body: {} })).status, 401);
});

test("tokens that were never ours: wrong key, the old default key, no key, tampered, wrong audience", { skip }, async () => {
  const u = await fresh("fg");
  const real = (await signIn(u.email)).body.tokens.accessToken;
  const claims = { id: u.id, email: u.email, type: "super_admin", name: "x", companyId: "atk", branchId: "main" };
  const opts = { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-admin" };
  const forged = {
    defaultKey: jwt.sign(claims, "your-secret-key", opts),
    wrongKey: jwt.sign(claims, "some-other-key-entirely-0123456789", opts),
    none: signedWithoutKey({ ...claims, iss: "ERP-system", aud: "ERP-admin", exp: Math.floor(Date.now() / 1000) + 3600 }),
    otherAudience: jwt.sign(claims, process.env.JWT_SECRET, { ...opts, audience: "ERP-platform" }),
    otherIssuer: jwt.sign(claims, process.env.JWT_SECRET, { ...opts, issuer: "somebody" }),
    expired: jwt.sign(claims, process.env.JWT_SECRET, { ...opts, expiresIn: -10 }),
    tampered: real.split(".").map((part, i) => (i === 1 ? Buffer.from(JSON.stringify({ ...claimsOf(real), type: "super_admin", permissions: ["backup_restore"] })).toString("base64url") : part)).join("."),
    truncated: real.slice(0, -4),
    garbage: "not-a-token",
    dotsOnly: "..",
  };
  for (const [name, token] of Object.entries(forged)) {
    const r = await call("GET", "/organisation/status", { token });
    assert.equal(r.status, 401, `${name} opened the API`);
    assert.ok(!/jwt|secret|signature|stack|at Object/i.test(r.text.replace(/"message":"Invalid token"/, "")), `${name}: the refusal says how it was judged: ${r.text.slice(0, 200)}`);
  }
  assert.equal((await call("GET", "/organisation/status", { token: real })).status, 200, "and the real one still works");
  // other header shapes
  assert.equal((await call("GET", "/organisation/status", { headers: { Authorization: `Basic ${real}` } })).status, 401);
  assert.equal((await call("GET", "/organisation/status", { headers: { Authorization: `bearer ${real}` } })).status, 401, "the scheme is exactly Bearer");
  assert.equal((await call("GET", "/organisation/status", { headers: { Authorization: "Bearer " } })).status, 401);
});

test("the developer console and the customer app never take each other's tokens", { skip }, async () => {
  assert.equal((await call("GET", "/platform/me", { token: T.platform })).status, 200, "the console token opens the console");
  for (const url of ["/organisation/status", "/profile/me", "/currencies", "/access/users"]) {
    assert.equal((await call("GET", url, { token: T.platform })).status, 401, `a console token opened ${url}`);
  }
  for (const url of ["/platform/me", "/platform/organisations", "/platform/users", "/platform/audit"]) {
    const r = await call("GET", url, { token: T.owner });
    assert.equal(r.status, 401, `the owner of an organisation opened the console at ${url}`);
  }
  // each side's challenge belongs to its own door
  const owner = await person("owner@attack.test");
  const consoleChallenge = tokens.signChallenge({ sub: String(owner._id), cid: "atk" }, { kind: tokens.PLATFORM_CHALLENGE, secret: tokens.platformSecret() });
  const customerChallenge = tokens.signChallenge({ sub: String(owner._id), cid: "atk" });
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: consoleChallenge, code: "123456" } })).code, "CHALLENGE_INVALID");
  assert.equal((await call("POST", "/platform/login/2fa", { body: { challengeToken: customerChallenge, code: "123456" } })).status, 401);
  // and neither is a bearer token
  assert.equal((await call("GET", "/organisation/status", { token: customerChallenge })).status, 401);
  assert.equal((await call("GET", "/platform/me", { token: customerChallenge })).status, 401);
  assert.equal((await call("GET", "/platform/me", { token: T.owner })).status, 401);
});

test("an access token is not a challenge, and a challenge is not a session cookie", { skip }, async () => {
  const challenge = tokens.signChallenge({ sub: T.ownerId || "x", cid: "atk" });
  assert.equal((await call("POST", "/refresh-token", { cookie: `erp_session=${challenge}`, body: {} })).status, 401);
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: T.owner, code: "123456" } })).code, "CHALLENGE_INVALID");
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: tokenOf(T.ownerCookie), code: "123456" } })).code, "CHALLENGE_INVALID", "a refresh token as a challenge");
});

// =====================================================================================================================
// a session that has ended is over everywhere
// =====================================================================================================================

test("signing out ends the session at once: the access token that was still unexpired, and the cookie", { skip }, async () => {
  const u = await fresh("lo");
  const login = await signIn(u.email);
  const access = login.body.tokens.accessToken;
  assert.equal((await call("GET", "/organisation/status", { token: access })).status, 200);
  const out = await call("POST", "/logout", { cookie: login.cookie, body: {} });
  assert.equal(out.status, 200);
  const after = await call("GET", "/organisation/status", { token: access });
  assert.equal(after.status, 401, "the access token still opened the API after sign-out");
  assert.equal(after.code, "SESSION_REVOKED");
  const refresh = await call("POST", "/refresh-token", { cookie: login.cookie, body: {} });
  assert.equal(refresh.status, 401, "the refresh cookie still worked after sign-out");
  assert.equal(refresh.code, "SESSION_REVOKED");
  // signing out with a dead or made-up cookie is quiet, and ends nothing else
  const other = await signIn(u.email);
  assert.equal((await call("POST", "/logout", { cookie: "erp_session=garbage", body: {} })).status, 200);
  assert.equal((await call("GET", "/organisation/status", { token: other.body.tokens.accessToken })).status, 200, "somebody else's sign-out does not end this one");
});

test("changing the password ends every OTHER sign-in at once and keeps this one", { skip }, async () => {
  const u = await fresh("cp");
  const here = await signIn(u.email);
  const thief = await signIn(u.email);
  const bad = await call("PUT", "/profile/change-password", { token: here.body.tokens.accessToken, body: { currentPassword: PASSWORD, newPassword: "a-new-password-1", confirmPassword: "a-new-password-1" } });
  assert.equal(bad.status, 200, JSON.stringify(bad.data));
  assert.equal((await call("GET", "/organisation/status", { token: thief.body.tokens.accessToken })).status, 401, "the other sign-in's access token survived a password change");
  assert.equal((await call("POST", "/refresh-token", { cookie: thief.cookie, body: {} })).status, 401, "and its cookie");
  assert.equal((await call("GET", "/organisation/status", { token: here.body.tokens.accessToken })).status, 200, "the sign-in that changed it carries on");
  assert.equal((await call("POST", "/refresh-token", { cookie: here.cookie, body: {} })).status, 200);
  assert.equal((await signIn(u.email, "a-new-password-1")).status, 200);
});

test("a password set by an administrator ends the person's sign-ins; switching them off does too", { skip }, async () => {
  const u = await fresh("ar", "viewer");
  const theirs = await signIn(u.email);
  const reset = await call("PUT", `/${u.id}`, { token: T.owner, body: { password: "set-by-admin-123" } });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await call("GET", "/organisation/status", { token: theirs.body.tokens.accessToken })).status, 401, "an administrator's reset left the old sign-in open");
  assert.equal((await call("POST", "/refresh-token", { cookie: theirs.cookie, body: {} })).status, 401);

  const v = await fresh("off", "viewer");
  const signed = await signIn(v.email);
  const off = await call("PATCH", `/${v.id}/status`, { token: T.owner, body: { status: "inactive" } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await call("GET", "/organisation/status", { token: signed.body.tokens.accessToken })).status, 401, "switched off, and still in");
  assert.equal((await call("POST", "/refresh-token", { cookie: signed.cookie, body: {} })).status, 401);
  assert.equal((await signIn(v.email)).status, 401, "and cannot sign in again");
});

test("a reset by email, and an administrator's two-factor reset, end the old access token at once", { skip }, async () => {
  const u = await fresh("em");
  const old = await signIn(u.email);
  await sleep(1100); // tokens are stamped in whole seconds
  const before = mailsTo(u.email).length;
  assert.equal((await call("POST", "/auth/forgot-password", { body: { email: u.email } })).status, 200);
  const mail = await nextMailTo(u.email, before);
  const link = (mail.text.match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
  assert.ok(link);
  assert.equal((await call("POST", "/auth/reset-password", { body: { token: link, password: "brand-new-password-1" } })).status, 200);
  const r = await call("GET", "/organisation/status", { token: old.body.tokens.accessToken });
  assert.equal(r.status, 401);
  assert.equal(r.code, "SESSION_REVOKED");
  assert.equal((await call("POST", "/refresh-token", { cookie: old.cookie, body: {} })).status, 401);
});

// =====================================================================================================================
// the refresh cookie is single use
// =====================================================================================================================

test("each refresh hands out a NEW cookie; the access token it returns works and says it is one", { skip }, async () => {
  const u = await fresh("rot");
  const login = await signIn(u.email);
  assert.match(login.setCookie, /HttpOnly/i);
  assert.match(login.setCookie, /Path=\/api\/v1/i);
  assert.match(login.setCookie, /SameSite=Lax/i, "outside production the cookie is Lax");
  assert.doesNotMatch(login.setCookie, /;\s*Secure/i, "and not Secure over plain http in development");
  const r1 = await call("POST", "/refresh-token", { cookie: login.cookie, body: {} });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.ok(r1.cookie, "a refresh sets a replacement cookie");
  assert.notEqual(r1.cookie, login.cookie, "and it is a different token");
  assert.match(r1.setCookie, /HttpOnly/i);
  assert.equal(r1.body.refreshToken, undefined, "the refresh token is never in the body");
  assert.ok(!JSON.stringify(r1.data).includes(tokenOf(r1.cookie)));
  assert.equal(claimsOf(r1.body.accessToken).use, "access");
  assert.equal((await call("GET", "/organisation/status", { token: r1.body.accessToken })).status, 200);
  // the replacement works, and rotates again
  const r2 = await call("POST", "/refresh-token", { cookie: r1.cookie, body: {} });
  assert.equal(r2.status, 200);
  assert.notEqual(r2.cookie, r1.cookie);
  T.rotLast = { cookie: r2.cookie, email: u.email, id: u.id, access: r2.body.accessToken };
});

test("two tabs refreshing together are fine; a stolen cookie replayed later ends the session for both", { skip }, async () => {
  const u = await fresh("reuse");
  const login = await signIn(u.email);
  const original = login.cookie;
  const first = await call("POST", "/refresh-token", { cookie: original, body: {} }); // the owner's tab
  assert.equal(first.status, 200);
  // within the grace window the OLD cookie still answers (the second tab had not yet picked up the new one), but only once more,
  // and it does not rotate again
  const second = await call("POST", "/refresh-token", { cookie: original, body: {} });
  assert.equal(second.status, 200, `a second tab was refused inside the grace window: ${second.text.slice(0, 160)}`);
  assert.equal(second.cookie, null, "inside the grace window the old token earns an access token, not a new cookie");
  assert.equal((await call("GET", "/organisation/status", { token: second.body.accessToken })).status, 200);
  // the thief replays it later (the clock is moved on in the session row rather than waited for: the database is far away)
  await as("atk", () => M.Session.updateOne({ adminId: u.id }, { $set: { rotatedAt: new Date(Date.now() - (GRACE + 30) * 1000) } }));
  const replay = await call("POST", "/refresh-token", { cookie: original, body: {} });
  assert.equal(replay.status, 401, "a rotated refresh token worked after the grace window");
  assert.equal(replay.code, "SESSION_REVOKED");
  // ...and the whole session is dead, the rightful owner's newer cookie and access token included
  assert.equal((await call("POST", "/refresh-token", { cookie: first.cookie, body: {} })).status, 401, "the owner's newer cookie survived a detected theft");
  assert.equal((await call("GET", "/organisation/status", { token: first.body.accessToken })).status, 401, "so did the access token");
  const row = (await as("atk", () => M.Session.find({ adminId: u.id }).lean()))[0];
  assert.ok(row.revokedAt, "the session row is revoked");
  const audit = await as("atk", () => M.Activity.find({ action: "SESSION_REFRESH_REUSE_DETECTED" }).lean());
  assert.ok(audit.some((a) => String(a.summary).includes(u.email)), "and it is in the organisation's trail");
  // the person signs in again as normal
  assert.equal((await signIn(u.email)).status, 200);
});

test("an old cookie from before rotation existed (no token id on its session) is accepted once and replaced", { skip }, async () => {
  const u = await fresh("legacy");
  const login = await signIn(u.email);
  // the session as an older version wrote it: no rotation fields at all
  await as("atk", () => M.Session.updateOne({ adminId: u.id }, { $unset: { refreshJti: 1, prevRefreshJti: 1, rotatedAt: 1 } }));
  const legacyCookie = `erp_session=${jwt.sign({ id: u.id, sid: claimsOf(tokenOf(login.cookie)).sid, type: "refresh" }, process.env.JWT_SECRET, { expiresIn: "1d", issuer: "ERP-system", audience: "ERP-admin" })}`;
  const r = await call("POST", "/refresh-token", { cookie: legacyCookie, body: {} });
  assert.equal(r.status, 200, `a session from before the deploy was signed out: ${r.text.slice(0, 200)}`);
  assert.ok(r.cookie && r.cookie !== legacyCookie, "it is replaced by a rotating one");
  assert.equal((await call("POST", "/refresh-token", { cookie: r.cookie, body: {} })).status, 200);
});

// =====================================================================================================================
// the credential fields are not a query language
// =====================================================================================================================

test("operators, arrays, nulls, huge strings and control characters in every public credential field: refused, never a 500, never a sign-in", { skip }, async () => {
  const nasty = [
    { $ne: null }, { $gt: "" }, { $regex: ".*" }, { $exists: true }, { $in: ["owner@attack.test"] }, { $where: "1==1" },
    ["owner@attack.test"], [{ $ne: null }], null, true, 0, 12345, {}, [], "x".repeat(100000), "owner@attack.test\u0000", "\u0000", "owner@attack.test\r\nBcc: evil@x.test",
    { "toString": "x" }, { "__proto__": { admin: true } }, { constructor: { prototype: { x: 1 } } },
  ];
  const seen = [];
  for (const bad of nasty) {
    for (const body of [{ email: bad, password: PASSWORD }, { email: "owner@attack.test", password: bad }, { email: bad, password: bad }]) {
      const r = await call("POST", "/login", { body });
      seen.push(r.status);
      assert.ok(r.status >= 400 && r.status < 500, `login ${JSON.stringify(body).slice(0, 90)} -> ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(!r.body?.tokens, "signed in");
    }
  }
  // the same bodies at the other public doors
  for (const bad of nasty) {
    for (const [url, body] of [
      ["/auth/forgot-password", { email: bad }],
      ["/auth/reset-password", { token: bad, password: "a-brand-new-password-1" }],
      ["/auth/reset-password", { token: "x".repeat(43), password: bad }],
      ["/auth/login/2fa", { challengeToken: bad, code: bad }],
      ["/auth/login/2fa", { challengeToken: tokens.signChallenge({ sub: String(new mongoose.Types.ObjectId()), cid: "atk" }), code: bad, recoveryCode: bad }],
      ["/platform/login", { email: bad, password: bad }],
      ["/platform/login", { email: DEV.email, password: bad }],
    ]) {
      const r = await call("POST", url, { body });
      assert.ok(r.status < 500, `${url} ${JSON.stringify(body).slice(0, 90)} -> ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(![200].includes(r.status) || url === "/auth/forgot-password", `${url} said yes to ${JSON.stringify(body).slice(0, 80)}`);
    }
  }
  // form-encoded nested keys (qs style) reach the same code and must not become operators either
  const form = await call("POST", "/login", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, raw: "email[$ne]=x&password[$ne]=x" });
  assert.ok(form.status >= 400 && form.status < 500 && !form.body?.tokens, `form-encoded operators: ${form.status} ${form.text.slice(0, 100)}`);
  // and the signed-in doors (a throwaway person: the wrong passwords among these count toward a lock)
  const victim = await fresh("nasty");
  const victimToken = (await signIn(victim.email)).body.tokens.accessToken;
  for (const bad of nasty.slice(0, 12)) {
    for (const [url, body] of [
      ["/auth/2fa/setup", { password: bad }],
      ["/auth/2fa/enable", { code: bad }],
      ["/auth/2fa/disable", { password: bad, code: bad }],
    ]) {
      const r = await call("POST", url, { token: victimToken, body });
      assert.ok(r.status >= 400 && r.status < 500, `${url} ${JSON.stringify(body).slice(0, 90)} -> ${r.status}`);
    }
    const r = await call("PUT", "/profile/change-password", { token: victimToken, body: { currentPassword: bad, newPassword: bad, confirmPassword: bad } });
    assert.ok(r.status >= 400 && r.status < 500, `change-password ${JSON.stringify(bad).slice(0, 60)} -> ${r.status}`);
  }
  assert.equal((await call("GET", "/health")).status, 200, "and the server is still up");
  assert.equal((await signIn("omar@attack.test")).status, 200, "and Omar can still sign in: none of that locked or damaged him");
});

test("a malformed or oversized body is an ordinary client error, not a server fault", { skip }, async () => {
  const broken = await call("POST", "/login", { raw: "{\"email\": ", headers: { "Content-Type": "application/json" } });
  assert.equal(broken.status, 400, broken.text.slice(0, 200));
  assert.equal(broken.code, "INVALID_JSON");
  assert.ok(!/SyntaxError|at JSON|node_modules|stack/i.test(broken.text), "no parser internals in the answer");
  const big = await call("POST", "/login", { raw: JSON.stringify({ email: "a@b.co", password: "x".repeat(3 * 1024 * 1024) }), headers: { "Content-Type": "application/json" } });
  assert.equal(big.status, 413, `3 MB to the sign-in door was read (${big.status})`);
});

test("email case, spacing and look-alike tricks reach the same account or none, never another", { skip }, async () => {
  assert.equal((await signIn("OMAR@ATTACK.TEST")).status, 200, "case does not matter");
  assert.equal((await signIn("  omar@attack.test  ")).status, 200, "nor stray spaces around it");
  for (const trick of ["omar@attack.test.", "omar@attack.test ", "omar＠attack.test", "ömar@attack.test", "omar@attack.test​", "omar@attack.test%00", "omar+x@attack.test", "omar@attack.test,evil@x.test"]) {
    const r = await signIn(trick);
    if (r.status === 200) assert.equal(r.body.admin.email, "omar@attack.test", `${JSON.stringify(trick)} signed in as somebody else`);
  }
});

// =====================================================================================================================
// the answers do not say who has an account
// =====================================================================================================================

test("an unknown address, a wrong password, a switched-off person and a suspended one all get the same refusal", { skip }, async () => {
  const off = await fresh("gone");
  await as("atk", () => M.Admin.updateOne({ email: off.email }, { $set: { isActive: false, status: "inactive" } }));
  const susp = await fresh("susp");
  await as("atk", () => M.Admin.updateOne({ email: susp.email }, { $set: { status: "suspended" } })); // still isActive: true
  const shapes = {
    unknown: await signIn("nobody-at-all@attack.test", PASSWORD),
    wrong: await signIn("omar@attack.test", "not-the-password-0"),
    switchedOff: await signIn(off.email, PASSWORD),
    suspendedRightPassword: await signIn(susp.email, PASSWORD),
  };
  for (const [name, r] of Object.entries(shapes)) {
    assert.equal(r.status, 401, `${name}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.code, "INVALID_CREDENTIALS", name);
  }
  const bodies = new Set(Object.values(shapes).map((r) => JSON.stringify({ ...r.data, details: undefined })));
  assert.equal(bodies.size, 1, `the refusals differ: ${[...bodies].join(" | ")}`);
  assert.equal(shapes.suspendedRightPassword.body?.tokens, undefined, "a suspended person was handed tokens");
  // the forgot-password answer is the same for all of them too (the account-security suite pins the timing)
  const answers = new Set();
  for (const email of ["omar@attack.test", "nobody-at-all@attack.test", off.email, susp.email]) answers.add(JSON.stringify((await call("POST", "/auth/forgot-password", { body: { email } })).data));
  assert.equal(answers.size, 1);
});

test("how long a refusal takes does not say whether the account exists", { skip }, async () => {
  const u = await fresh("tm");
  const known = [], unknown = [];
  for (let i = 0; i < 7; i += 1) {
    unknown.push((await signIn(`ghost-${i}-${Date.now()}@attack.test`, `wrong-${i}-password`)).ms);
    known.push((await signIn(u.email, `wrong-${i}-password`)).ms);
    await forgive(u.email);
  }
  const k = median(known), n = median(unknown);
  assert.ok(Math.abs(k - n) <= Math.max(120, 0.3 * Math.max(k, n)), `an unknown address answers in ${n} ms, a known one in ${k} ms (medians): the difference tells them apart`);
});

// =====================================================================================================================
// the lock-out is a real guard
// =====================================================================================================================

test("five wrong passwords lock the account; the right one is then refused too, and a parallel burst gets no extra guesses", { skip }, async () => {
  const u = await fresh("lk");
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => signIn(u.email, `guess-${i}-wrong`)));
  const compared = burst.filter((r) => r.status === 401).length;
  const locked = burst.filter((r) => r.status === 423).length;
  assert.ok(compared <= 5, `${compared} of 40 parallel guesses were actually weighed against the password (the limit is 5)`);
  assert.equal(compared + locked, 40, JSON.stringify(burst.map((r) => r.status)));
  const right = await signIn(u.email, PASSWORD);
  assert.equal(right.status, 423, "the right password got in while locked");
  assert.equal(right.code, "ACCOUNT_LOCKED");
  const row = await person(u.email);
  assert.ok(row.lockUntil && row.lockUntil > new Date(), "the lock is recorded");
  assert.ok(row.lockUntil < new Date(Date.now() + 16 * 60 * 1000), "for about fifteen minutes");
});

test("the right password in the middle of a parallel burst cannot win once the limit is spent", { skip }, async () => {
  // 3 rounds of: 5 wrong guesses in flight together with the right password and 14 more wrong ones. Whatever order the server meets them in,
  // at most five requests may be weighed, so the right one gets in only if it is among the first five - never "after" the lock.
  for (let round = 0; round < 3; round += 1) {
    const u = await fresh("race");
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => signIn(u.email, i === 12 ? PASSWORD : `nope-${i}`)));
    const weighed = attempts.filter((r) => r.status === 401 || r.status === 200).length;
    assert.ok(weighed <= 5, `round ${round}: ${weighed} requests were weighed`);
  }
});

test("a stolen session cannot guess the password through 'change password': wrong guesses count toward the lock", { skip }, async () => {
  const u = await fresh("stolen");
  const login = await signIn(u.email);
  const token = login.body.tokens.accessToken;
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await call("PUT", "/profile/change-password", { token, body: { currentPassword: `guess-${i}-wrong`, newPassword: "a-new-password-1", confirmPassword: "a-new-password-1" } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400], "wrong guesses are refused as 400 (a 401 would sign the person out)");
  assert.deepEqual(statuses.slice(5), [423, 423], `after five, the lock: ${statuses}`);
  const right = await call("PUT", "/profile/change-password", { token, body: { currentPassword: PASSWORD, newPassword: "a-new-password-1", confirmPassword: "a-new-password-1" } });
  assert.equal(right.status, 423, "the right current password was accepted while locked");
  assert.equal((await signIn(u.email, PASSWORD)).status, 423, "and the sign-in door is shut too");
});

test("the signed-in doors that ask for the password again stop at the same lock", { skip }, async () => {
  const u = await fresh("pw2");
  const token = (await signIn(u.email)).body.tokens.accessToken;
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await call("POST", "/auth/2fa/setup", { token, body: { password: `wrong-${i}-guess` } })).status);
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.deepEqual(codes.slice(5), [423, 423]);
});

// =====================================================================================================================
// the address a request comes from
// =====================================================================================================================

test("a rotating X-Forwarded-For buys no fresh allowance when the proxy is not trusted", { skip }, async () => {
  let refused = null;
  for (let i = 0; i < 14 && !refused; i += 1) {
    const r = await signIn(`nobody-${i}@attack.test`, "wrong-password-1", { base: BASE_B, headers: { "X-Forwarded-For": `203.0.113.${i + 1}` } });
    if (r.status === 429) refused = { at: i, r };
  }
  assert.ok(refused, "fourteen failed sign-ins from one machine, each claiming a different address, were all answered: the throttle trusts the header");
  assert.ok(refused.at <= 7, `refused only at attempt ${refused.at + 1}`);
  assert.equal(refused.r.code, "TOO_MANY_ATTEMPTS");
  assert.ok(Number(refused.r.headers.get("retry-after")) > 0);
  // the second-step door shares the bucket
  const second = await call("POST", "/auth/login/2fa", { base: BASE_B, body: { challengeToken: "x", code: "123456" }, headers: { "X-Forwarded-For": "198.51.100.200" } });
  assert.equal(second.status, 429, "the second sign-in step shares the first one's allowance");
});

test("behind ONE trusted proxy the address is what that proxy saw, not what the client claims", { skip }, async () => {
  // a proxy appends the address it saw to whatever the client sent: "<client-claim>, <real>". The real one is the last.
  let refused = null;
  for (let i = 0; i < 14 && !refused; i += 1) {
    const r = await signIn(`nobody-c${i}@attack.test`, "wrong-password-1", { base: BASE_C, headers: { "X-Forwarded-For": `10.${i}.${i}.${i}, 198.51.100.9` } });
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, "a different left-most claim on each request dodged the throttle");
  // another real address behind the same proxy has its own allowance
  const other = await signIn("nobody-d@attack.test", "wrong-password-1", { base: BASE_C, headers: { "X-Forwarded-For": "10.9.9.9, 198.51.100.77" } });
  assert.equal(other.status, 401, "a different real address was swept up with it");
  // the health check tells a person which address the server sees, so a deployment can be checked from outside
  const health = await call("GET", "/health", { base: BASE_C, headers: { "X-Forwarded-For": "1.2.3.4, 198.51.100.55" } });
  assert.equal(health.data.yourAddress, "198.51.100.55");
  assert.equal((await call("GET", "/health", { base: BASE_B, headers: { "X-Forwarded-For": "1.2.3.4" } })).data.yourAddress, "127.0.0.1", "with no trusted proxy the header is ignored");
});

test("failed refreshes are slowed per address as well", { skip }, async () => {
  let refused = null;
  for (let i = 0; i < 14 && !refused; i += 1) {
    const r = await call("POST", "/refresh-token", { base: BASE_B, cookie: "erp_session=garbage", body: {}, headers: { "X-Forwarded-For": `203.0.113.${i + 50}` } });
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, "an endless stream of bad cookies was answered every time");
  assert.equal(refused.code, "TOO_MANY_ATTEMPTS");
});

// =====================================================================================================================
// two-factor and the emailed link, as an attacker
// =====================================================================================================================

test("a challenge belongs to the person whose password earned it: another person's code, and a challenge older than a reset, are refused", { skip }, async () => {
  const a = await fresh("tfa");
  const b = await fresh("tfb");
  const A = await withTwoFactor(a.email);
  const B = await withTwoFactor(b.email);
  await aLaterStep(a.email); await aLaterStep(b.email);
  const challengeA = (await signIn(a.email)).body.challengeToken;
  assert.ok(challengeA, "a challenge");
  // B's valid code on A's challenge is just a wrong code for A
  await settleInStep();
  const swapped = await call("POST", "/auth/login/2fa", { body: { challengeToken: challengeA, code: codeNow(B.secret) } });
  assert.equal(swapped.status, 401, "another person's code completed the sign-in");
  assert.equal(swapped.code, "INVALID_TWO_FACTOR_CODE");
  // the challenge for A but naming another organisation is no challenge at all
  const wrongOrg = tokens.signChallenge({ sub: a.id, cid: "atk2" });
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: wrongOrg, code: codeNow(A.secret) } })).code, "CHALLENGE_INVALID");
  // an expired one
  const expired = tokens.signChallenge({ sub: a.id, cid: "atk" }, { seconds: -5 });
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: expired, code: codeNow(A.secret) } })).code, "CHALLENGE_EXPIRED");
  // a password reset after the challenge was handed out cancels it (the person ended every sign-in on purpose)
  await sleep(1100);
  await as("atk", () => M.Admin.updateOne({ email: a.email }, { $set: { sessionsRevokedAt: new Date() } }));
  const stale = await call("POST", "/auth/login/2fa", { body: { challengeToken: challengeA, code: codeNow(A.secret) } });
  assert.equal(stale.status, 401, "a challenge older than a reset still opened a session");
  // the same code, on a fresh challenge, signs in as normal
  await forgive(a.email);
  const fresh2 = (await signIn(a.email)).body.challengeToken;
  const done = await call("POST", "/auth/login/2fa", { body: { challengeToken: fresh2, code: codeNow(A.secret) } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  // the code just spent cannot be used again, on any challenge
  const again = (await signIn(a.email)).body.challengeToken;
  assert.equal((await call("POST", "/auth/login/2fa", { body: { challengeToken: again, code: codeNow(A.secret) } })).code, "TWO_FACTOR_CODE_REUSED");
});

test("guessing the code is counted: five wrong and even the right one is turned away; parallel guesses get no extra", { skip }, async () => {
  const u = await fresh("tfg");
  const U = await withTwoFactor(u.email);
  await aLaterStep(u.email);
  const challenge = (await signIn(u.email)).body.challengeToken;
  const good = new Set([-2, -1, 0, 1, 2].map((s) => codeNow(U.secret, s)));
  const wrongCodes = Array.from({ length: 30 }, (_, i) => String(100000 + i * 7919).slice(0, 6)).filter((c) => !good.has(c)).slice(0, 25);
  const burst = await Promise.all(wrongCodes.map((code) => call("POST", "/auth/login/2fa", { body: { challengeToken: challenge, code } })));
  const weighed = burst.filter((r) => r.status === 401).length;
  assert.ok(weighed <= 5, `${weighed} parallel wrong codes were weighed (the limit is 5)`);
  const right = await call("POST", "/auth/login/2fa", { body: { challengeToken: challenge, code: codeNow(U.secret) } });
  assert.equal(right.status, 423, "the right code was accepted after the limit");
});

test("odd values where a code belongs are wrong codes, never a fault", { skip }, async () => {
  const u = await fresh("tfn");
  const U = await withTwoFactor(u.email);
  await aLaterStep(u.email);
  const challenge = (await signIn(u.email)).body.challengeToken;
  for (const body of [{ code: { toString: "x" } }, { code: [123456] }, { code: { $gt: "" } }, { recoveryCode: { toString: "x" } }]) {
    const r = await call("POST", "/auth/login/2fa", { body: { challengeToken: challenge, ...body } });
    assert.equal(r.status, 401, `${JSON.stringify(body)} -> ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.code, "INVALID_TWO_FACTOR_CODE");
  }
  assert.ok(U.secret);
});

test("a recovery code works once, however it is written, and a made-up one counts as a failed guess", { skip }, async () => {
  const u = await fresh("rc");
  const U = await withTwoFactor(u.email);
  const code = U.recoveryCodes[0];
  const one = await call("POST", "/auth/login/2fa", { body: { challengeToken: (await signIn(u.email)).body.challengeToken, recoveryCode: code.toLowerCase().replace("-", " ") } });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  const twice = await call("POST", "/auth/login/2fa", { body: { challengeToken: (await signIn(u.email)).body.challengeToken, recoveryCode: code } });
  assert.equal(twice.status, 401, "a recovery code worked twice");
  const row = await person(u.email);
  assert.ok(row.loginAttempts >= 1, "and the failed use was counted");
});

test("the emailed link points at the configured address whatever Host, Origin or X-Forwarded-Host the request claims", { skip }, async () => {
  for (const headers of [
    { Host: "evil.example" },
    { "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
    { Origin: "https://evil.example", Referer: "https://evil.example/x" },
    { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Host": "evil.example", Forwarded: "host=evil.example;proto=http" },
    { Host: "evil.example", "X-Forwarded-Host": "evil.example", Origin: "https://evil.example" },
  ]) {
    const u = await fresh("host");
    const before = mailsTo(u.email).length;
    const r = await rawRequest({ method: "POST", urlPath: "/api/v1/auth/forgot-password", body: { email: u.email }, headers });
    if (headers.Origin) {
      // a browser origin that is not ours is refused outright (CORS), before the route is reached: no mail at all
      assert.equal(r.status, 403, r.text);
      assert.equal(r.code, "CORS_ORIGIN_NOT_ALLOWED");
      await sleep(300);
      assert.equal(mailsTo(u.email).length, before, "a mail went out for a request from a foreign origin");
      continue;
    }
    assert.equal(r.status, 200, r.text);
    const mail = await nextMailTo(u.email, before);
    const link = (mail.text.match(/https?:\/\/\S+reset-password\?token=[A-Za-z0-9_-]+/) || [])[0];
    assert.ok(link, `a link in ${mail.text}`);
    assert.ok(link.startsWith(`${APP_URL}/reset-password?token=`), `the link points at ${link.split("/reset")[0]} (headers ${JSON.stringify(headers)})`);
    assert.ok(!/evil\.example/i.test(mail.html + mail.text + JSON.stringify(mail.subject)), "the forged host is nowhere in the mail");
  }
});

test("a name is text, not markup: nothing a person called themselves reaches a mail as HTML", { skip }, async () => {
  const hostile = `<img src=x onerror=alert(1)>"'&`;
  const u = await fresh("xss", "operator", { name: hostile });
  const before = mailsTo(u.email).length;
  await call("POST", "/auth/forgot-password", { body: { email: u.email } });
  const mail = await nextMailTo(u.email, before);
  assert.ok(!mail.html.includes("<img"), `the name is in the HTML as markup: ${mail.html.slice(0, 400)}`);
  assert.ok(mail.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "it is there, escaped");
  assert.ok(!/href="javascript:/i.test(mail.html));
  assert.ok(!/[\r\n]\s*(bcc|cc|to):/i.test(mail.subject), "and the subject is a single line");
});

test("a link made for one account opens no other, and the token is in no log", { skip }, async () => {
  const a = await fresh("la"), b = await fresh("lb");
  const before = mailsTo(a.email).length;
  await call("POST", "/auth/forgot-password", { body: { email: a.email } });
  const token = (( await nextMailTo(a.email, before)).text.match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
  assert.ok(token);
  assert.equal((await call("POST", "/auth/reset-password", { body: { token, password: "brand-new-password-9" } })).status, 200);
  assert.equal((await signIn(a.email, "brand-new-password-9")).status, 200, "A has the new password");
  assert.equal((await signIn(b.email, "brand-new-password-9")).status, 401, "B does not");
  assert.equal((await signIn(b.email, PASSWORD)).status, 200, "B keeps hers");
  assert.ok(!logs.includes(token), "the reset token was written to a log");
});

test("duplicate-key errors repeat no values, and signing up an address that exists elsewhere says only that it is taken", { skip }, async () => {
  const r = await call("POST", "/", { token: T.owner, body: { name: "Twin Zoe", email: "zoe@other.test", password: "twin-password-12", type: "viewer" } });
  assert.ok(r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 200)}`);
  assert.ok(!/atk2|Other Trading/i.test(r.text), "the other organisation is named");
  assert.ok(!r.text.includes("zoe@other.test"), "the conflicting value is echoed back");
  const same = await call("POST", "/", { token: T.owner, body: { name: "Twin Omar", email: "omar@attack.test", password: "twin-password-12", type: "viewer" } });
  assert.equal(same.status, r.status, "an address in my own organisation and one in another read differently");
  assert.equal(same.message, r.message);
});

test("what an unexpected failure says: nothing about how it happened", { skip }, async () => {
  // a token naming an account id that is not even an id
  const weird = jwt.sign({ id: { $ne: null }, email: "x@y.zz" }, process.env.JWT_SECRET, { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-admin" });
  const r = await call("GET", "/organisation/status", { token: weird });
  assert.ok(r.status === 401 || r.status === 400, `${r.status}`);
  assert.ok(!/Cast to|ObjectId|mongoose|at \w+\.|node_modules|CastError/i.test(r.text), `internal text in the answer: ${r.text.slice(0, 300)}`);
  const weird2 = jwt.sign({ id: "not-an-object-id", email: "x@y.zz" }, process.env.JWT_SECRET, { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-admin" });
  const r2 = await call("GET", "/organisation/status", { token: weird2 });
  assert.ok(!/Cast to|ObjectId|mongoose|CastError/i.test(r2.text), `internal text in the answer: ${r2.text.slice(0, 300)}`);
  assert.equal(r2.status, 401);
});

test("a person's own profile update changes a name and nothing else about who they are", { skip }, async () => {
  const u = await fresh("prof", "operator", { branchId: "main" });
  const token = (await signIn(u.email)).body.tokens.accessToken;
  const r = await call("PUT", "/profile/me", { token, body: { name: "New Name", email: "attacker@evil.test", branchId: "elsewhere", mustChangePassword: true, passwordChangedAt: "2000-01-01", status: "inactive", isActive: false, profileImage: { url: "x", publicId: "someone-elses-asset" } } });
  assert.ok(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  const row = await person(u.email);
  assert.equal(row.name, "New Name");
  assert.equal(row.email, u.email, "a stolen session changed the sign-in address (and so could reset the password to its own mailbox)");
  assert.equal(row.branchId, "main");
  assert.ok(!row.mustChangePassword);
  assert.notEqual(row.profileImage?.publicId, "someone-elses-asset");
});
