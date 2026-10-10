// Two-factor sign-in for the developer console, against a real strict server: the same rules as a customer's account (a challenge
// between password and code, a code is good once, five failures lock, a recovery code is good once, the secret is never kept in the
// clear), on the console's OWN identity - a customer's challenge or token opens nothing here, and the reverse.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const totp = require("../../utils/totp");
const tokens = require("../../utils/accountTokens");
const secretBox = require("../../utils/secretBox");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const ONE = { name: "Dev One", email: "dev1@zarvia.test", password: "a-long-passphrase-123" };
const TWO = { name: "Dev Two", email: "dev2@zarvia.test", password: "another-long-pass-456" };

let child, PlatformAuth, PlatformUser;
let logs = "";
const S = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, cacheControl: res.headers.get("cache-control") };
}
const plat = (method, url, body, token = S.token) => call(method, `/platform${url}`, { body, token });
const login = (who) => plat("POST", "/login", { email: who.email, password: who.password }, null);
const second = (challengeToken, input) => plat("POST", "/login/2fa", { challengeToken, ...input }, null);
const code = (secret, steps = 0) => totp.totp(secret, { time: Date.now() + steps * 30000 });
const wrong = (secret) => ["000000", "111111", "222222"].find((c) => [-2, -1, 0, 1, 2].every((s) => code(secret, s) !== c));
const stored = (email) => PlatformUser.findOne({ email }).select("+loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.recoveryCodes").lean();
const later = (email) => PlatformUser.updateOne({ email }, { $set: { "twoFactor.lastStep": totp.stepAt(Date.now()) - 3 } });
const forgive = (email) => PlatformUser.updateOne({ email }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", PLATFORM_LOGIN_LIMIT: "200" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  PlatformAuth = require("../platform/platformAuthService");
  PlatformUser = require("../../models/platform/platformUserModel");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  await PlatformAuth.create(ONE);
  await PlatformAuth.create(TWO);
});
test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("without two-factor, signing in to the console is one step, as before", { skip }, async () => {
  const r = await login(ONE);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.body.token);
  assert.equal(r.body.twoFactorRequired, undefined);
  S.token = r.body.token;
  S.two = (await login(TWO)).body.token;
  assert.deepEqual((await plat("GET", "/me")).body.twoFactor, { enabled: false, enabledAt: null });
});

test("setting it up asks for the password, shows the key once, and is switched on by a code the app produces", { skip }, async () => {
  const bad = await plat("POST", "/me/2fa/setup", { password: "not-the-password-1" });
  assert.equal(bad.status, 400, "a 400: a 401 would make the console think the session ended");
  assert.equal(bad.code, "PASSWORD_INCORRECT");
  const setup = await plat("POST", "/me/2fa/setup", { password: ONE.password });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.cacheControl, "no-store");
  S.secret = setup.body.secret;
  assert.match(S.secret, /^[A-Z2-7]{32}$/);
  assert.ok(setup.body.uri.startsWith("otpauth://totp/Zarvia%20Console:dev1%40zarvia.test?"), setup.body.uri);
  const pending = await stored(ONE.email);
  assert.equal(pending.twoFactor.enabled, false);
  assert.ok(!pending.twoFactor.pendingSecretEnc.includes(S.secret), "kept encrypted");

  assert.equal((await plat("POST", "/me/2fa/enable", { code: wrong(S.secret) })).code, "INVALID_TWO_FACTOR_CODE");
  const on = await plat("POST", "/me/2fa/enable", { code: code(S.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.cacheControl, "no-store");
  S.recovery = on.body.recoveryCodes;
  assert.equal(S.recovery.length, 10);
  const row = await stored(ONE.email);
  assert.equal(row.twoFactor.enabled, true);
  assert.equal(secretBox.decrypt(row.twoFactor.secretEnc), S.secret);
  assert.ok(!JSON.stringify(row).includes(S.secret) && S.recovery.every((c) => !JSON.stringify(row).includes(c)), "no secret and no recovery code in the clear");
  assert.equal((await plat("POST", "/me/2fa/enable", { code: code(S.secret, 1) })).code, "TWO_FACTOR_ALREADY_ON");
  const me = await plat("GET", "/me");
  assert.deepEqual(Object.keys(me.body.twoFactor).sort(), ["enabled", "enabledAt"]);
  assert.equal(me.body.twoFactor.enabled, true);
  assert.ok(!JSON.stringify(me.data).match(/secretEnc|pendingSecret|recoveryCodes/));
  assert.equal((await plat("GET", "/me/2fa")).body.recoveryCodesLeft, 10);
  const audit = await plat("GET", "/audit");
  assert.ok(audit.body.rows.some((a) => a.action === "PLATFORM_TWO_FACTOR_ENABLED"), "it is in the console's own audit");
});

test("with it on, the password earns only a challenge, which is not a console token, and a customer's challenge is not accepted", { skip }, async () => {
  const first = await login(ONE);
  assert.equal(first.status, 200);
  assert.equal(first.body.twoFactorRequired, true);
  assert.equal(first.body.token, undefined);
  assert.equal(first.body.user, undefined);
  assert.equal((await plat("GET", "/me", undefined, first.body.challengeToken)).status, 401, "the challenge opens no door");
  assert.equal((await second(S.token, { code: code(S.secret) })).code, "CHALLENGE_INVALID", "a console token is not a challenge");

  const id = String((await stored(ONE.email))._id);
  const customers = tokens.signChallenge({ sub: id });
  assert.equal((await second(customers, { code: code(S.secret) })).code, "CHALLENGE_INVALID", "a customer's challenge opens nothing here");
  const expired = tokens.signChallenge({ sub: id }, { kind: tokens.PLATFORM_CHALLENGE, secret: tokens.platformSecret(), seconds: -5 });
  assert.equal((await second(expired, { code: code(S.secret) })).code, "CHALLENGE_EXPIRED");
  assert.equal((await second(first.body.challengeToken, {})).code, "MISSING_CODE");
  S.challenge = first.body.challengeToken;
});

test("a code completes it once; a replay, a wrong code and a recovery code behave as for a customer", { skip }, async () => {
  await later(ONE.email);
  const typed = code(S.secret);
  const done = await second(S.challenge, { code: typed });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.ok(done.body.token);
  assert.equal(done.body.user.twoFactor.enabled, true);
  assert.equal((await plat("GET", "/me", undefined, done.body.token)).status, 200);
  S.token = done.body.token;

  const replay = await second(S.challenge, { code: typed });
  assert.equal(replay.status, 401);
  assert.equal(replay.code, "TWO_FACTOR_CODE_REUSED");
  assert.equal((await second(S.challenge, { code: wrong(S.secret) })).code, "INVALID_TWO_FACTOR_CODE");

  const used = await second(S.challenge, { recoveryCode: S.recovery[0].toLowerCase().replace("-", " ") });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.equal(used.body.signIn.method, "recovery");
  assert.equal(used.body.signIn.recoveryCodesLeft, 9);
  assert.equal((await second(S.challenge, { recoveryCode: S.recovery[0] })).code, "INVALID_TWO_FACTOR_CODE", "a recovery code is good once");
});

test("five wrong codes lock the account, and then even the right code is refused", { skip }, async () => {
  await forgive(ONE.email);
  await later(ONE.email);
  const first = await login(ONE);
  for (let i = 0; i < 5; i++) assert.equal((await second(first.body.challengeToken, { code: wrong(S.secret) })).status, 401, `wrong code ${i + 1}`);
  const row = await stored(ONE.email);
  assert.ok(row.lockUntil && new Date(row.lockUntil) > new Date());
  const locked = await second(first.body.challengeToken, { code: code(S.secret) });
  assert.equal(locked.status, 423);
  assert.equal(locked.code, "ACCOUNT_LOCKED");
  assert.equal((await login(ONE)).status, 423, "the password step is locked too");
  await forgive(ONE.email);
});

test("changing it needs the password AND a code: new recovery codes, then turning it off", { skip }, async () => {
  await later(ONE.email);
  assert.equal((await plat("POST", "/me/2fa/recovery-codes", { password: ONE.password })).code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await plat("POST", "/me/2fa/recovery-codes", { password: "nope-nope-nope-1", code: code(S.secret) })).code, "PASSWORD_INCORRECT");
  await forgive(ONE.email);
  const fresh = await plat("POST", "/me/2fa/recovery-codes", { password: ONE.password, code: code(S.secret) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.cacheControl, "no-store");
  assert.equal(fresh.body.recoveryCodes.length, 10);
  assert.notDeepEqual(fresh.body.recoveryCodes, S.recovery);

  await later(ONE.email);
  assert.equal((await plat("POST", "/me/2fa/disable", { password: ONE.password })).code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await stored(ONE.email)).twoFactor.enabled, true);
  await forgive(ONE.email);
  const off = await plat("POST", "/me/2fa/disable", { password: ONE.password, code: code(S.secret) });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const row = await stored(ONE.email);
  assert.equal(row.twoFactor.enabled, false);
  assert.ok(!row.twoFactor.secretEnc && !row.twoFactor.recoveryCodes?.length);
  assert.ok((await login(ONE)).body.token, "one step again");
});

test("a colleague clears someone's two-factor (a lost phone) - never their own, and it is in the audit", { skip }, async () => {
  S.token = (await login(ONE)).body.token;
  // dev two turns it on
  const setup = await plat("POST", "/me/2fa/setup", { password: TWO.password }, S.two);
  const on = await plat("POST", "/me/2fa/enable", { code: code(setup.body.secret) }, S.two);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const twoId = String((await stored(TWO.email))._id);
  const oneId = String((await stored(ONE.email))._id);

  assert.equal((await plat("POST", `/users/${twoId}/2fa/reset`, {}, null)).status, 401, "needs a console token");
  assert.equal((await plat("POST", `/users/${oneId}/2fa/reset`, {}, S.token)).code, "CANNOT_CHANGE_SELF");
  assert.equal((await plat("POST", `/users/${oneId}/2fa/reset`, {}, S.two)).code, "TWO_FACTOR_NOT_ON");
  assert.equal((await plat("POST", `/users/${new mongoose.Types.ObjectId()}/2fa/reset`, {}, S.token)).status, 404);
  const done = await plat("POST", `/users/${twoId}/2fa/reset`, {}, S.token);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.body.twoFactor.enabled, false);
  assert.ok(!(await stored(TWO.email)).twoFactor.secretEnc);
  assert.ok((await login(TWO)).body.token, "dev two signs in with just a password again");
  const audit = await plat("GET", "/audit");
  assert.ok(audit.body.rows.some((a) => a.action === "PLATFORM_TWO_FACTOR_RESET" && /dev2@zarvia\.test.*dev1@zarvia\.test/.test(a.summary)));
  assert.ok(!JSON.stringify(audit.data).includes(setup.body.secret), "no secret in the audit");
});

test("nothing secret was written to the log", { skip }, async () => {
  assert.ok(!logs.includes(S.secret));
  for (const c of S.recovery) assert.ok(!logs.includes(c));
});
