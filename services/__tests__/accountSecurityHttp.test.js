// Account security against a real, strict server and a throwaway database: forgetting a password, and two-factor sign-in.
//
// The rules under test are the ones that fail quietly if they are wrong:
//   - "forgot my password" answers the same, in about the same time, for an account and for no account, and mails only the first
//   - a reset link works once, for thirty minutes, only the newest works, and using it ends every sign-in the person holds
//   - a second factor cannot be skipped, replayed, guessed without limit, or kept in the clear; a stolen session cannot bind one
//   - the organisation's rule "everyone needs two-factor" leaves a person able to do exactly one thing: set it up
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const totp = require("../../utils/totp");
const tokens = require("../../utils/accountTokens");
const secretBox = require("../../utils/secretBox");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 200);
const PORT2 = PORT + 200; // a second server on the same database, with tiny limits, for the throttles
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const CAPTURE = path.join(os.tmpdir(), `account-security-mail-${process.pid}-${Date.now()}.jsonl`);
const PASSWORD = "12312312";
// How long "forgot my password" always takes on the server under test. Deliberately SHORTER than the work behind a real request (a
// handful of round trips to the database), so an answer that waited for that work would show as slower than one that did not.
const FLOOR_MS = 120;

let children = [], M, Org, ctx;
let logs = "";
const T = {}; // access tokens by name
const seen = { secrets: [], recovery: [], resetTokens: [] }; // every secret the test was shown, to prove none of them is stored or written down

async function call(method, url, { body, token, base = BASE, cookie } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  const started = Date.now();
  const res = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  const set = res.headers.getSetCookie?.() || [];
  return {
    status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, message: data?.message,
    retryAfter: res.headers.get("retry-after"), cacheControl: res.headers.get("cache-control"), ms: Date.now() - started,
    cookie: set.map((c) => c.split(";")[0]).find((c) => c.startsWith("erp_session=")) || null,
  };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const signIn = (email, password = PASSWORD, base = BASE) => call("POST", "/login", { body: { email, password }, base });
const second = (challengeToken, input, base = BASE) => call("POST", "/auth/login/2fa", { body: { challengeToken, ...input }, base });
const person = (email) => as("sec", () => M.Admin.findOne({ email }).select("+password +loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.recoveryCodes").lean());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function start(port, extraEnv = {}) {
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0",
      SYSTEM_MAIL_PROVIDER: "console", SYSTEM_MAIL_CAPTURE_FILE: CAPTURE, FORGOT_PASSWORD_MIN_MS: String(FLOOR_MS),
      FORGOT_PASSWORD_IP_LIMIT: "100", RESET_PASSWORD_IP_LIMIT: "100", LOGIN_FAILURE_LIMIT: "1000", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  children.push(child);
}
async function waitUp(base) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).ready !== false) return; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await sleep(400);
  }
}

// ---- the mail that would have gone out (the console provider writes it to a file, away from production)
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
const linkTokenIn = (mail) => {
  const token = (mail.text.match(/\/reset-password\?token=([A-Za-z0-9_-]{43})/) || [])[1];
  assert.ok(token, `the mail carries a reset link:\n${mail.text}`);
  seen.resetTokens.push(token);
  return token;
};
// Ask for a reset link and return the token from the mail that follows.
async function resetLinkFor(email) {
  const before = mailsTo(email).length;
  const r = await call("POST", "/auth/forgot-password", { body: { email } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return linkTokenIn(await nextMailTo(email, before));
}
const reset = (token, password, base = BASE) => call("POST", "/auth/reset-password", { body: { token, password }, base });

// ---- authenticator codes
const codeNow = (secret, steps = 0) => totp.totp(secret, { time: Date.now() + steps * 30000 });
// the failures counted against a person so far, forgiven: a test that counts them starts from nothing
const forgive = (email) => as("sec", () => M.Admin.updateOne({ email }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }));
// a code that is none of the ones the window would take now
const wrongCodeFor = (secret) => {
  const good = new Set([-2, -1, 0, 1, 2].map((s) => codeNow(secret, s)));
  return ["000000", "111111", "222222"].find((c) => !good.has(c));
};
// Waits (if need be) until the clock is early in a 30-second step, so a test that spends a code and uses it again a moment later
// is not split across two steps.
const settleInStep = async () => {
  const into = Date.now() % 30000;
  if (into > 18000) await sleep(30000 - into + 1500);
};
// "thirty seconds went by": the last accepted step falls behind, so the next code is a fresh one rather than a replay. Replay
// itself is tested with no such help.
const aLaterStep = (email) => as("sec", () => M.Admin.updateOne({ email }, { $set: { "twoFactor.lastStep": totp.stepAt(Date.now()) - 3 } }));

// Sign in, set two-factor up and switch it on, as the person. Returns what was shown once.
async function enrol(who, email, password = PASSWORD) {
  const setup = await api(who, "POST", "/auth/2fa/setup", { password });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  seen.secrets.push(setup.body.secret);
  const on = await api(who, "POST", "/auth/2fa/enable", { code: codeNow(setup.body.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  seen.recovery.push(...on.body.recoveryCodes);
  return { secret: setup.body.secret, recoveryCodes: on.body.recoveryCodes };
}
// Complete a two-factor sign-in with a fresh code and store the access token under `who`.
async function signInWithCode(who, email, secret, password = PASSWORD) {
  await aLaterStep(email);
  const first = await signIn(email, password);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const done = await second(first.body.challengeToken, { code: codeNow(secret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  T[who] = done.body.tokens.accessToken;
  return done;
}

test.before(async () => {
  if (skip) return;
  fs.rmSync(CAPTURE, { force: true });
  start(PORT);
  await mongoose.connect(process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`));
  M = {
    Admin: require("../../models/core/adminModel"),
    Activity: require("../../models/modules/financial/activityLogModel"),
    PasswordReset: require("../../models/core/passwordResetModel"),
    Session: require("../../models/core/authSessionModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  await waitUp(BASE);
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

test("an organisation with an owner, an administrator, a manager, an operator and a viewer", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Sec Trading", code: "sec", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  const make = (name, email, type, extra = {}) => as("sec", () => new M.Admin({ name, email, password: PASSWORD, type, status: "active", isActive: true, ...extra }).save());
  await make("Owen Owner", "owner@sec.test", "super_admin");
  await make("Sam Admin", "sam@sec.test", "admin");
  await make("Nadia Manager", "nadia@sec.test", "manager");
  await make("Omar Operator", "omar@sec.test", "operator");
  await make("Ines Inactive", "ines@sec.test", "operator");
  await make("Oli Off", "oli@sec.test", "operator", { isActive: false, status: "inactive" });
  await make("Tina Manager", "tina@sec.test", "manager");
  await make("Ravi Operator", "ravi@sec.test", "operator");
  await make("Will Viewer", "will@sec.test", "viewer");
  await make("Zed Temp", "zed@sec.test", "viewer", { mustChangePassword: true });
  for (const [who, email] of [["owner", "owner@sec.test"], ["sam", "sam@sec.test"], ["ravi", "ravi@sec.test"], ["will", "will@sec.test"]]) {
    const r = await signIn(email);
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.data)}`);
    T[who] = r.body.tokens.accessToken;
  }
});

// =====================================================================================================================
// forgot / reset password
// =====================================================================================================================

test("'forgot my password' gives the same answer for an account and for no account, and takes about as long", { skip }, async () => {
  // nadia holds a session and is locked out, so the reset below has something to undo
  const old = await signIn("nadia@sec.test");
  T.nadiaOld = old.body.tokens.accessToken;
  T.nadiaOldCookie = old.cookie;
  assert.ok(old.cookie, "she holds a session cookie");
  await as("sec", () => M.Admin.updateOne({ email: "nadia@sec.test" }, { $set: { mustChangePassword: true } }));
  for (let i = 0; i < 5; i++) await signIn("nadia@sec.test", "wrong-password-x");
  assert.equal((await signIn("nadia@sec.test")).status, 423, "she is locked");
  await sleep(1100); // so her old token was issued in an earlier second than the reset below

  const known = await call("POST", "/auth/forgot-password", { body: { email: "nadia@sec.test" } });
  const unknown = await call("POST", "/auth/forgot-password", { body: { email: "nobody-at-all@sec.test" } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.data, unknown.data, "the same body, word for word");
  // the same time, whatever the work behind it: both answer after the fixed delay, and the work (looking the account up, writing the
  // link, starting the mail - well over the delay on a slow database) shows in neither
  assert.ok(known.ms >= FLOOR_MS - 20 && unknown.ms >= FLOOR_MS - 20, `neither answers faster than the delay (${known.ms} ms, ${unknown.ms} ms)`);
  assert.ok(Math.abs(known.ms - unknown.ms) < 90, `and they take about as long as each other (${known.ms} ms, ${unknown.ms} ms)`);
  // anything else a script might try gets the same answer too
  for (const body of [{}, { email: "" }, { email: "not an email" }, { email: 42 }, { email: ["nadia@sec.test"] }, { email: "x".repeat(400) + "@sec.test" }]) {
    const r = await call("POST", "/auth/forgot-password", { body });
    assert.equal(r.status, 200, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(r.data, known.data);
  }
  const mail = await nextMailTo("nadia@sec.test", 0);
  await sleep(800);
  assert.equal(mails().length, 1, "one mail in all, and it is for the person who has an account");
  assert.equal(mail.subject, "Reset your Zarvia password");
  T.nadiaLink = linkTokenIn(mail);
  assert.match(mail.text, /30 minutes/);
});

test("the link's token is stored only as a hash, and lives thirty minutes", { skip }, async () => {
  const id = sha256(T.nadiaLink);
  const rows = await as("sec", () => M.PasswordReset.find({}).lean());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._id, id, "the row is found by the token's hash");
  assert.ok(!JSON.stringify(rows).includes(T.nadiaLink), "the token itself is nowhere in the collection");
  assert.equal(rows[0].usedAt, null);
  const minutes = (new Date(rows[0].expiresAt).getTime() - Date.now()) / 60000;
  assert.ok(minutes > 29 && minutes <= 30.1, `expires in about thirty minutes (${minutes.toFixed(2)})`);
  assert.equal((await person("nadia@sec.test"))._id.toString(), rows[0].adminId.toString());
});

test("a link that is wrong, or a password that is not acceptable, changes nothing and does not spend the link", { skip }, async () => {
  const bad = (token, password, code) => reset(token, password).then((r) => { assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.code, code, `${token?.slice?.(0, 8)}: ${r.code}`); return r; });
  await bad("short", "a-brand-new-password-1", "RESET_TOKEN_INVALID");
  await bad("", "a-brand-new-password-1", "RESET_TOKEN_INVALID");
  await bad(crypto.randomBytes(32).toString("base64url"), "a-brand-new-password-1", "RESET_TOKEN_INVALID");
  await bad(undefined, "a-brand-new-password-1", "RESET_TOKEN_INVALID");
  await bad(T.nadiaLink, "short", "WEAK_PASSWORD");
  await bad(T.nadiaLink, "", "WEAK_PASSWORD");
  await bad(T.nadiaLink, "x".repeat(300), "WEAK_PASSWORD");
  await bad(T.nadiaLink, PASSWORD, "PASSWORD_UNCHANGED"); // her current password
  const row = (await as("sec", () => M.PasswordReset.find({}).lean()))[0];
  assert.equal(row.usedAt, null, "none of that used the link");
  assert.equal((await signIn("nadia@sec.test", PASSWORD)).status, 423, "and she is still locked: nothing changed");
});

test("using the link: the password is replaced, the flag and the lock are cleared, and every sign-in the person held is over", { skip }, async () => {
  const NEW = "a-brand-new-password-1";
  const done = await reset(T.nadiaLink, NEW);
  assert.equal(done.status, 200, JSON.stringify(done.data));

  const after = await person("nadia@sec.test");
  assert.equal(after.mustChangePassword, false, "the temporary-password flag is cleared");
  assert.ok(!after.lockUntil && !after.loginAttempts, "and so is the lock");
  assert.ok(after.passwordChangedAt && after.sessionsRevokedAt);
  assert.equal((await signIn("nadia@sec.test", PASSWORD)).status, 401, "the old password is gone");
  const fresh = await signIn("nadia@sec.test", NEW);
  assert.equal(fresh.status, 200, "the new one signs in at once (the lock is gone)");
  T.nadia = fresh.body.tokens.accessToken;
  assert.notEqual((await api("nadia", "GET", "/organisation/status")).status, 401, "a sign-in made after the reset is not touched by it");

  // every sign-in held before it is finished: the access token at once, and the refresh cookie
  const stale = await call("GET", "/organisation/status", { token: T.nadiaOld });
  assert.equal(stale.status, 401);
  assert.equal(stale.code, "SESSION_REVOKED");
  const refresh = await call("POST", "/refresh-token", { cookie: T.nadiaOldCookie, body: {} });
  assert.equal(refresh.status, 401);
  assert.equal(refresh.code, "SESSION_REVOKED");
  const sessions = await as("sec", () => M.Session.find({ adminId: after._id }).lean());
  assert.ok(sessions.some((s) => s.revokedAt), "the old session row is revoked");
  assert.ok(sessions.filter((s) => !s.revokedAt).length >= 1, "the sign-in just made is not");
});

test("a link works once", { skip }, async () => {
  const again = await reset(T.nadiaLink, "yet-another-password-2");
  assert.equal(again.status, 400);
  assert.equal(again.code, "RESET_TOKEN_INVALID");
  assert.equal((await signIn("nadia@sec.test", "a-brand-new-password-1")).status, 200, "the password from the first use stands");
  assert.equal((await signIn("nadia@sec.test", "yet-another-password-2")).status, 401);
});

test("two requests racing for one link: exactly one wins", { skip }, async () => {
  const token = await resetLinkFor("omar@sec.test");
  const results = await Promise.all([reset(token, "race-password-one-1"), reset(token, "race-password-two-2"), reset(token, "race-password-three-3")]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.code === "RESET_TOKEN_INVALID").length, 2);
});

test("a link that has expired is refused, with the same words as any other dead link", { skip }, async () => {
  const token = await resetLinkFor("nadia@sec.test");
  await as("sec", () => M.PasswordReset.updateOne({ _id: sha256(token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } }));
  const late = await reset(token, "too-late-password-1");
  assert.equal(late.status, 400);
  assert.equal(late.code, "RESET_TOKEN_INVALID");
  assert.equal(late.message, (await reset("short", "too-late-password-1")).message, "an expired link and a made-up one read the same");
});

test("a newer request replaces the older link: only the newest mail works", { skip }, async () => {
  const first = await resetLinkFor("sam@sec.test");
  const second = await resetLinkFor("sam@sec.test");
  assert.notEqual(first, second);
  assert.equal((await reset(first, "sams-new-password-1")).code, "RESET_TOKEN_INVALID", "the first link is dead");
  assert.equal((await reset(second, "sams-new-password-1")).status, 200, "the second works");
});

test("an account asks for only so many links an hour: the rest are answered the same and nothing is sent", { skip }, async () => {
  const email = "will@sec.test";
  for (let i = 0; i < 3; i++) await resetLinkFor(email);
  const before = mailsTo(email).length;
  const id = (await person(email))._id;
  const rowsBefore = (await as("sec", () => M.PasswordReset.find({ adminId: id }).lean())).length;
  const fourth = await call("POST", "/auth/forgot-password", { body: { email } });
  assert.equal(fourth.status, 200, "still the same answer");
  assert.equal(fourth.message, (await call("POST", "/auth/forgot-password", { body: { email: "nobody-at-all@sec.test" } })).message);
  await sleep(800);
  assert.equal(mailsTo(email).length, before, "no fourth mail");
  assert.equal((await as("sec", () => M.PasswordReset.find({ adminId: id }).lean())).length, rowsBefore, "and no fourth link");
});

test("a switched-off account, or one switched off after it asked, gets no usable link; a suspended organisation gets none at all", { skip }, async () => {
  // never active: no mail, no row, the usual answer
  const off = await call("POST", "/auth/forgot-password", { body: { email: "oli@sec.test" } });
  assert.equal(off.status, 200);
  await sleep(600);
  assert.equal(mailsTo("oli@sec.test").length, 0);
  assert.equal(await as("sec", async () => M.PasswordReset.countDocuments({ adminId: (await person("oli@sec.test"))._id })), 0);

  // switched off AFTER the link was sent: the link is dead
  const token = await resetLinkFor("ines@sec.test");
  await as("sec", () => M.Admin.updateOne({ email: "ines@sec.test" }, { $set: { isActive: false, status: "inactive" } }));
  assert.equal((await reset(token, "ines-new-password-1")).code, "RESET_TOKEN_INVALID");
  await as("sec", () => M.Admin.updateOne({ email: "ines@sec.test" }, { $set: { isActive: true, status: "active" } }));

  // a suspended organisation: no mail for anyone in it
  const Organisation = require("../../models/core/organisationModel");
  const was = (await Organisation.findOne({ code: "sec" }).lean()).status;
  await Organisation.updateOne({ code: "sec" }, { $set: { status: "suspended" } });
  try {
    const before = mails().length;
    for (const email of ["tina@sec.test", "ravi@sec.test"]) assert.equal((await call("POST", "/auth/forgot-password", { body: { email } })).status, 200, "the same answer");
    await sleep(800);
    assert.equal(mails().length, before, "nothing was sent to anyone in a suspended organisation");
    assert.equal(await as("sec", async () => M.PasswordReset.countDocuments({ adminId: (await person("tina@sec.test"))._id })), 0, "and no link was made");
  } finally {
    await Organisation.updateOne({ code: "sec" }, { $set: { status: was } });
  }
});

test("the reset is in the organisation's trail without any secret, and the person is told by mail that it happened", { skip }, async () => {
  const rows = await as("sec", () => M.Activity.find({ action: "PASSWORD_RESET" }).lean());
  assert.ok(rows.length >= 3, "nadia, omar and sam each reset once");
  assert.ok(rows.every((r) => /^[^@\s]+@sec\.test$/.test(r.username)), "each names the person");
  const trail = JSON.stringify(await as("sec", () => M.Activity.find({}).lean()));
  for (const token of seen.resetTokens) assert.ok(!trail.includes(token), "no reset token in the trail");
  for (const password of ["a-brand-new-password-1", "yet-another-password-2", "race-password-one-1", "sams-new-password-1"]) assert.ok(!trail.includes(password), "no password in the trail");
  const notice = mailsTo("nadia@sec.test").find((m) => /password was changed/i.test(m.subject));
  assert.ok(notice, "a notice that the password was changed");
  assert.ok(!seen.resetTokens.some((t) => notice.text.includes(t)), "and it does not repeat the link");
});

// =====================================================================================================================
// two-factor: enrolling
// =====================================================================================================================

test("setting two-factor up needs the password again, and a stolen session cannot bind someone else's app", { skip }, async () => {
  const a = await signIn("tina@sec.test");
  const b = await signIn("tina@sec.test");
  T.tina = a.body.tokens.accessToken;
  T.tinaOtherCookie = b.cookie;
  T.tinaOther = b.body.tokens.accessToken;
  T.tinaCookie = a.cookie;

  assert.equal((await api("tina", "POST", "/auth/2fa/setup", {})).code, "PASSWORD_INCORRECT");
  const wrong = await api("tina", "POST", "/auth/2fa/setup", { password: "not-her-password" });
  assert.equal(wrong.status, 400, "a 400, not a 401: a 401 would sign the browser out");
  assert.equal(wrong.code, "PASSWORD_INCORRECT");
  assert.ok(!(await person("tina@sec.test")).twoFactor?.pendingSecretEnc, "nothing was started");
  assert.equal((await person("tina@sec.test")).loginAttempts, 2, "and a wrong password here counts toward the lock, like at sign-in");

  const setup = await api("tina", "POST", "/auth/2fa/setup", { password: PASSWORD });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.cacheControl, "no-store");
  seen.secrets.push(setup.body.secret);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.equal(setup.body.formattedSecret, totp.formatSecret(setup.body.secret));
  assert.ok(setup.body.uri.startsWith("otpauth://totp/Zarvia:tina%40sec.test?"), setup.body.uri);
  assert.equal(new URL(setup.body.uri).searchParams.get("secret"), setup.body.secret);
  T.tinaSecret = setup.body.secret;

  const row = await person("tina@sec.test");
  assert.equal(row.twoFactor.enabled, false, "not on until a code proves it");
  assert.ok(row.twoFactor.pendingSecretEnc && !row.twoFactor.pendingSecretEnc.includes(setup.body.secret), "the pending secret is stored encrypted");
  assert.equal(secretBox.decrypt(row.twoFactor.pendingSecretEnc), setup.body.secret);
  assert.equal((await signIn("tina@sec.test")).body.twoFactorRequired, undefined, "so signing in is unchanged for now");
});

test("switching it on needs a code the app produces; the codes shown once are kept only as hashes; other sign-ins end", { skip }, async () => {
  const wrong = await api("tina", "POST", "/auth/2fa/enable", { code: wrongCodeFor(T.tinaSecret) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await api("tina", "POST", "/auth/2fa/enable", {})).code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await person("tina@sec.test")).twoFactor.enabled, false);

  await settleInStep();
  const typed = codeNow(T.tinaSecret);
  const on = await api("tina", "POST", "/auth/2fa/enable", { code: typed });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.cacheControl, "no-store");
  T.tinaRecovery = on.body.recoveryCodes;
  seen.recovery.push(...on.body.recoveryCodes);
  assert.equal(on.body.recoveryCodes.length, 10);
  for (const c of on.body.recoveryCodes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(new Set(on.body.recoveryCodes).size, 10);

  const row = await person("tina@sec.test");
  assert.equal(row.twoFactor.enabled, true);
  assert.ok(row.twoFactor.enabledAt);
  assert.ok(!row.twoFactor.pendingSecretEnc, "the pending secret is gone");
  assert.equal(secretBox.decrypt(row.twoFactor.secretEnc), T.tinaSecret, "the secret is recoverable by the server, with its key");
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes(T.tinaSecret), "and it is not in the row in the clear");
  for (const c of on.body.recoveryCodes) assert.ok(!stored.includes(c) && !stored.includes(c.replace("-", "")), "no recovery code is in the row");
  assert.equal(row.twoFactor.recoveryCodes.length, 10);
  assert.ok(row.twoFactor.recoveryCodes.every((c) => /^[0-9a-f]{64}$/.test(c.hash) && c.usedAt === null));
  assert.equal(row.loginAttempts || 0, 0, "a good code clears the failures");

  // the sign-in made on another device before there was a second factor is over; the one that turned it on carries on
  assert.equal((await call("POST", "/refresh-token", { cookie: T.tinaOtherCookie, body: {} })).code, "SESSION_REVOKED");
  assert.equal((await call("POST", "/refresh-token", { cookie: T.tinaCookie, body: {} })).status, 200);
  assert.equal((await api("tina", "POST", "/auth/2fa/enable", { code: codeNow(T.tinaSecret, 1) })).code, "TWO_FACTOR_ALREADY_ON");
  assert.equal((await api("tina", "POST", "/auth/2fa/setup", { password: PASSWORD })).code, "TWO_FACTOR_ALREADY_ON");
  assert.ok(mailsTo("tina@sec.test").some((m) => /turned on/i.test(m.subject)), "and she is told by mail");

  // the code typed to switch it on is spent: signing in with it a moment later is a replay (no help from aLaterStep here)
  const challenge = (await signIn("tina@sec.test")).body.challengeToken;
  const replay = await second(challenge, { code: typed });
  assert.equal(replay.status, 401);
  assert.equal(replay.code, "TWO_FACTOR_CODE_REUSED");
  assert.equal((await person("tina@sec.test")).twoFactor.lastStep, totp.stepAt(Date.now()), "the step is remembered");
});

test("the screen's status read: on, since when, how many recovery codes are left, and whether the organisation requires it", { skip }, async () => {
  const s = await api("tina", "GET", "/auth/2fa");
  assert.equal(s.status, 200);
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.recoveryCodesLeft, 10);
  assert.equal(s.body.required, false);
  assert.ok(s.body.enabledAt);
  assert.deepEqual(Object.keys(s.body).sort(), ["enabled", "enabledAt", "recoveryCodesLeft", "required"], "nothing secret rides on it");
  const status = await api("tina", "GET", "/organisation/status");
  assert.equal(status.body.me.twoFactorEnabled, true);
  assert.equal(status.body.me.twoFactorRequired, false);
  assert.equal(status.body.policy.security.requireTwoFactor, false);
  const mine = await api("tina", "GET", "/profile/me");
  assert.equal(mine.body.twoFactor.enabled, true);
  assert.ok(!JSON.stringify(mine.data).match(/secretEnc|pendingSecret|recoveryCodes|hash/), "the profile shows on or off, never a secret");
});

// =====================================================================================================================
// two-factor: signing in
// =====================================================================================================================

test("with two-factor on, the right password opens nothing: it earns a short-lived challenge, no tokens and no cookie", { skip }, async () => {
  const first = await signIn("tina@sec.test");
  assert.equal(first.status, 200);
  assert.equal(first.body.twoFactorRequired, true);
  assert.ok(first.body.challengeToken);
  assert.equal(first.body.expiresIn, 300);
  assert.equal(first.body.tokens, undefined);
  assert.equal(first.body.admin, undefined);
  assert.equal(first.cookie, null, "no session cookie yet");
  T.challenge = first.body.challengeToken;

  // the challenge is not an access token...
  const asAccess = await call("GET", "/organisation/status", { token: T.challenge });
  assert.equal(asAccess.status, 401);
  assert.equal((await call("GET", "/customers/customers", { token: T.challenge })).status, 401);
  // ...and an access token is not a challenge
  const wrongWay = await second(T.tina, { code: codeNow(T.tinaSecret) });
  assert.equal(wrongWay.status, 401);
  assert.equal(wrongWay.code, "CHALLENGE_INVALID");
  // a wrong password gets no challenge
  const bad = await signIn("tina@sec.test", "not-her-password");
  assert.equal(bad.status, 401);
  assert.equal(bad.body, undefined);
});

test("the challenge must be a real, unexpired one for this purpose", { skip }, async () => {
  const id = String((await person("tina@sec.test"))._id);
  const expired = tokens.signChallenge({ sub: id, cid: "sec" }, { seconds: -5 });
  assert.equal((await second(expired, { code: codeNow(T.tinaSecret) })).code, "CHALLENGE_EXPIRED");
  const forged = tokens.signChallenge({ sub: id, cid: "sec" }, { secret: "not the server's secret" });
  assert.equal((await second(forged, { code: codeNow(T.tinaSecret) })).code, "CHALLENGE_INVALID");
  const platform = tokens.signChallenge({ sub: id, cid: "sec" }, { kind: tokens.PLATFORM_CHALLENGE, secret: tokens.platformSecret() });
  assert.equal((await second(platform, { code: codeNow(T.tinaSecret) })).code, "CHALLENGE_INVALID", "the developer console's challenge opens nothing here");
  const elsewhere = tokens.signChallenge({ sub: id, cid: "another-organisation" });
  assert.equal((await second(elsewhere, { code: codeNow(T.tinaSecret) })).code, "CHALLENGE_INVALID", "a challenge names its organisation, and the account must belong to it");
  const nobody = tokens.signChallenge({ sub: String(new mongoose.Types.ObjectId()), cid: "sec" });
  assert.equal((await second(nobody, { code: "123456" })).code, "CHALLENGE_INVALID");
  for (const junk of ["", "abc", undefined]) assert.equal((await second(junk, { code: "123456" })).status, 401);
  // someone whose two-factor is NOT on cannot be walked through the second step
  const ravi = tokens.signChallenge({ sub: String((await person("ravi@sec.test"))._id), cid: "sec" });
  assert.equal((await second(ravi, { code: "123456" })).code, "CHALLENGE_INVALID");
  assert.equal((await second(T.challenge, {})).code, "MISSING_CODE");
});

test("a code from the app completes the sign-in; the same code cannot be used twice", { skip }, async () => {
  await aLaterStep("tina@sec.test");
  const startedAt = Date.now();
  const code = codeNow(T.tinaSecret);
  const done = await second(T.challenge, { code });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.ok(done.body.tokens.accessToken);
  assert.ok(done.cookie, "now there is a session cookie");
  assert.equal(done.body.admin.email, "tina@sec.test");
  assert.deepEqual(done.body.admin.twoFactor, { enabled: true, enabledAt: done.body.admin.twoFactor.enabledAt });
  assert.ok(!JSON.stringify(done.data).match(/secretEnc|pendingSecret|recoveryCodes/));
  T.tinaThree = done.body.tokens.accessToken;
  assert.equal((await call("GET", "/organisation/status", { token: T.tinaThree })).status, 200);

  const again = await second(T.challenge, { code });
  assert.equal(again.status, 401, "the code that just worked will not work again");
  assert.equal(again.code, "TWO_FACTOR_CODE_REUSED");
  assert.ok((await person("tina@sec.test")).twoFactor.lastStep >= totp.stepAt(startedAt), "the step is remembered");
});

test("two requests racing with the same fresh code: exactly one signs in", { skip }, async () => {
  await aLaterStep("tina@sec.test");
  const first = await signIn("tina@sec.test");
  const code = codeNow(T.tinaSecret);
  const results = await Promise.all([second(first.body.challengeToken, { code }), second(first.body.challengeToken, { code }), second(first.body.challengeToken, { code })]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.code])));
});

test("a wrong code is refused in words, and a missing one asks for it", { skip }, async () => {
  await forgive("tina@sec.test");
  await aLaterStep("tina@sec.test");
  const first = await signIn("tina@sec.test");
  const wrong = await second(first.body.challengeToken, { code: wrongCodeFor(T.tinaSecret) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.code, "INVALID_TWO_FACTOR_CODE");
  assert.match(wrong.message, /not right/);
  for (const code of ["12345", "abcdef"]) assert.equal((await second(first.body.challengeToken, { code })).status, 401, String(code));
  assert.equal((await second(first.body.challengeToken, { recoveryCode: "zzzzz-zzzzz" })).code, "INVALID_TWO_FACTOR_CODE");
  // the right one still works after those
  assert.equal((await second(first.body.challengeToken, { code: codeNow(T.tinaSecret) })).status, 200);
});

test("a recovery code signs in once, however it is typed, and says how many are left", { skip }, async () => {
  await forgive("tina@sec.test");
  const [one, two] = T.tinaRecovery;
  const first = await signIn("tina@sec.test");
  const typed = ` ${one.toLowerCase().replace("-", " ")} `;
  const used = await second(first.body.challengeToken, { recoveryCode: typed });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.equal(used.body.signIn.method, "recovery");
  assert.equal(used.body.signIn.recoveryCodesLeft, 9);
  assert.ok(used.cookie);

  const again = await signIn("tina@sec.test");
  const reuse = await second(again.body.challengeToken, { recoveryCode: one });
  assert.equal(reuse.status, 401, "a code is good once");
  assert.equal(reuse.code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await second(again.body.challengeToken, { recoveryCode: two })).status, 200, "another one works");
  assert.equal((await api("tina", "GET", "/auth/2fa")).body.recoveryCodesLeft, 8);

  const trail = await as("sec", () => M.Activity.find({ action: "TWO_FACTOR_RECOVERY_CODE_USED" }).lean());
  assert.equal(trail.length, 2, "each use is in the trail");
  assert.ok(mailsTo("tina@sec.test").some((m) => /recovery code was used/i.test(m.subject)), "and she is told");
});

test("wrong codes count toward the same lock as wrong passwords: five, and even the right code is turned away", { skip }, async () => {
  await forgive("tina@sec.test");
  await aLaterStep("tina@sec.test");
  const first = await signIn("tina@sec.test");
  const right = codeNow(T.tinaSecret);
  const wrongCode = wrongCodeFor(T.tinaSecret);
  for (let i = 1; i <= 5; i++) {
    const r = await second(first.body.challengeToken, { code: wrongCode });
    assert.equal(r.status, 401, `wrong code ${i}`);
  }
  const row = await person("tina@sec.test");
  assert.ok(row.lockUntil && new Date(row.lockUntil) > new Date(), "five wrong codes lock the account");
  const minutes = (new Date(row.lockUntil).getTime() - Date.now()) / 60000;
  assert.ok(minutes > 10 && minutes <= 15.1, `for about 15 minutes (${minutes.toFixed(1)})`);
  const locked = await second(first.body.challengeToken, { code: right });
  assert.equal(locked.status, 423);
  assert.equal(locked.code, "ACCOUNT_LOCKED");
  assert.equal((await signIn("tina@sec.test")).status, 423, "the password step is locked too");
  await as("sec", () => M.Admin.updateOne({ email: "tina@sec.test" }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }));
});

test("a password that was right but a code never typed leaves the failure count alone, so the count cannot be reset by a thief", { skip }, async () => {
  await as("sec", () => M.Admin.updateOne({ email: "tina@sec.test" }, { $set: { loginAttempts: 3 } }));
  const first = await signIn("tina@sec.test");
  assert.equal(first.body.twoFactorRequired, true);
  assert.equal((await person("tina@sec.test")).loginAttempts, 3, "the right password did not clear the count");
  await aLaterStep("tina@sec.test");
  const good = await second(first.body.challengeToken, { code: codeNow(T.tinaSecret) });
  assert.equal(good.status, 200);
  assert.ok(!(await person("tina@sec.test")).loginAttempts, "a good code clears it");
});

// =====================================================================================================================
// two-factor: managing it
// =====================================================================================================================

test("new recovery codes need the password AND a code, and replace every old one", { skip }, async () => {
  await signInWithCode("tina", "tina@sec.test", T.tinaSecret);
  assert.equal((await api("tina", "POST", "/auth/2fa/recovery-codes", { password: "nope", code: codeNow(T.tinaSecret) })).code, "PASSWORD_INCORRECT");
  assert.equal((await api("tina", "POST", "/auth/2fa/recovery-codes", { password: PASSWORD })).code, "INVALID_TWO_FACTOR_CODE", "a password alone is not enough");
  assert.equal((await api("tina", "POST", "/auth/2fa/recovery-codes", { password: PASSWORD, code: "000000" })).status, 400);
  await aLaterStep("tina@sec.test");
  const fresh = await api("tina", "POST", "/auth/2fa/recovery-codes", { password: PASSWORD, code: codeNow(T.tinaSecret) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.cacheControl, "no-store");
  assert.equal(fresh.body.recoveryCodes.length, 10);
  seen.recovery.push(...fresh.body.recoveryCodes);
  const old = T.tinaRecovery[5];
  const challenge = (await signIn("tina@sec.test")).body.challengeToken;
  assert.equal((await second(challenge, { recoveryCode: old })).status, 401, "an old code no longer works");
  assert.equal((await second(challenge, { recoveryCode: fresh.body.recoveryCodes[0] })).status, 200, "a new one does");
  T.tinaRecovery = fresh.body.recoveryCodes;
  assert.equal((await api("tina", "GET", "/auth/2fa")).body.recoveryCodesLeft, 9);
});

test("the older profile and account routes cannot switch two-factor off, or end anyone's sign-ins: those have their own routes", { skip }, async () => {
  const before = await person("tina@sec.test");
  assert.equal(before.twoFactor.enabled, true);
  // her own profile update, with the account's security fields in the body
  const own = await api("tina", "PUT", "/profile/me", { name: "Tina Own", twoFactor: { enabled: false }, "twoFactor.enabled": false, sessionsRevokedAt: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  // an administrator using the older account route
  const older = await api("owner", "PUT", `/${before._id}`, { name: "Tina Older", twoFactor: { enabled: false } });
  assert.equal(older.status, 200, JSON.stringify(older.data));
  const after = await person("tina@sec.test");
  assert.equal(after.name, "Tina Older", "the updates themselves went through");
  assert.equal(after.twoFactor.enabled, true, "and two-factor is still on");
  assert.ok(after.twoFactor.secretEnc && after.twoFactor.recoveryCodes?.length === 10);
  assert.ok(!after.sessionsRevokedAt, "nobody's sign-ins were ended by a body");
  assert.equal((await api("tina", "GET", "/organisation/status")).status, 200, "her token still works");
});

test("turning it off needs the password and a code - and is refused while the organisation requires it", { skip }, async () => {
  await aLaterStep("tina@sec.test");
  assert.equal((await api("tina", "POST", "/auth/2fa/disable", { password: "nope", code: codeNow(T.tinaSecret) })).code, "PASSWORD_INCORRECT");
  assert.equal((await api("tina", "POST", "/auth/2fa/disable", { password: PASSWORD })).code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await api("tina", "POST", "/auth/2fa/disable", { password: PASSWORD, code: "000000" })).code, "INVALID_TWO_FACTOR_CODE");
  assert.equal((await person("tina@sec.test")).twoFactor.enabled, true, "none of those turned it off");
  await as("sec", () => M.Admin.updateOne({ email: "tina@sec.test" }, { $set: { loginAttempts: 0 } }));

  const off = await api("tina", "POST", "/auth/2fa/disable", { password: PASSWORD, code: codeNow(T.tinaSecret) });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const row = await person("tina@sec.test");
  assert.equal(row.twoFactor.enabled, false);
  assert.ok(!row.twoFactor.secretEnc && !row.twoFactor.recoveryCodes?.length && !row.twoFactor.pendingSecretEnc, "everything is forgotten");
  const plain = await signIn("tina@sec.test");
  assert.equal(plain.body.twoFactorRequired, undefined, "signing in is one step again");
  assert.ok(plain.body.tokens.accessToken);
  assert.equal((await api("tina", "POST", "/auth/2fa/disable", { password: PASSWORD, code: "123456" })).code, "TWO_FACTOR_NOT_ON");
  assert.ok(mailsTo("tina@sec.test").some((m) => /turned off/i.test(m.subject)), "and she is told");
});

test("an administrator resets someone else's two-factor: only with the permission, only below their own rank, never their own, and it ends that person's sign-ins", { skip }, async () => {
  T.sam = (await signIn("sam@sec.test", "sams-new-password-1")).body.tokens.accessToken; // (his password was reset above, which ended his old sign-in)
  T.tina = (await signIn("tina@sec.test")).body.tokens.accessToken;
  const enrolled = await enrol("tina", "tina@sec.test");
  T.tinaSecret = enrolled.secret;
  await signInWithCode("tina", "tina@sec.test", T.tinaSecret);
  const tina = await person("tina@sec.test");
  const url = `/access/users/${tina._id}/2fa/reset`;

  const operator = await api("ravi", "POST", url, {});
  assert.equal(operator.status, 403);
  assert.equal(operator.code, "PERMISSION_DENIED", "an operator holds no users.manage");
  assert.equal((await person("tina@sec.test")).twoFactor.enabled, true);

  const owner = await person("owner@sec.test");
  const upward = await api("sam", "POST", `/access/users/${owner._id}/2fa/reset`, {});
  assert.equal(upward.status, 403, "an administrator is not above the owner");
  const selfReset = await api("sam", "POST", `/access/users/${(await person("sam@sec.test"))._id}/2fa/reset`, {});
  assert.equal(selfReset.status, 403);
  assert.equal(selfReset.code, "CANNOT_CHANGE_SELF");
  assert.equal((await api("sam", "POST", `/access/users/${(await person("omar@sec.test"))._id}/2fa/reset`, {})).code, "TWO_FACTOR_NOT_ON");
  assert.equal((await api("sam", "POST", `/access/users/${new mongoose.Types.ObjectId()}/2fa/reset`, {})).status, 404);

  const done = await api("sam", "POST", url, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.body.twoFactorEnabled, false);
  const after = await person("tina@sec.test");
  assert.equal(after.twoFactor.enabled, false);
  assert.ok(!after.twoFactor.secretEnc && !after.twoFactor.recoveryCodes?.length);
  assert.ok(after.sessionsRevokedAt);
  await sleep(1100);
  const old = await call("GET", "/organisation/status", { token: T.tina });
  assert.equal(old.status, 401, "the token she held is over");
  assert.equal(old.code, "SESSION_REVOKED");
  assert.equal((await signIn("tina@sec.test")).body.tokens !== undefined, true, "she signs in with just a password again");

  const trail = await as("sec", () => M.Activity.find({ action: "TWO_FACTOR_RESET_BY_ADMIN" }).lean());
  assert.equal(trail.length, 1);
  assert.match(trail[0].summary, /tina@sec\.test.*sam@sec\.test/);
  assert.equal(trail[0].username, "sam@sec.test");
});

test("the people list says who has two-factor on - and nothing about how", { skip }, async () => {
  await enrol("ravi", "ravi@sec.test").then((r) => { T.raviSecret = r.secret; });
  const list = await api("owner", "GET", "/access/users");
  assert.equal(list.status, 200);
  const by = Object.fromEntries(list.body.map((u) => [u.email, u.twoFactorEnabled]));
  assert.equal(by["ravi@sec.test"], true);
  assert.equal(by["tina@sec.test"], false);
  assert.ok(Object.values(by).every((v) => typeof v === "boolean"));
  assert.ok(!JSON.stringify(list.data).match(/secretEnc|pendingSecret|recoveryCodes|lastStep/));
});

// =====================================================================================================================
// the organisation's rule
// =====================================================================================================================

test("the rule needs settings.manage, and cannot be switched on by someone who has not set two-factor up themselves", { skip }, async () => {
  assert.equal((await api("will", "PUT", "/auth/security-policy", { requireTwoFactor: true })).code, "PERMISSION_DENIED", "a viewer cannot");
  assert.equal((await api("sam", "PUT", "/auth/security-policy", { requireTwoFactor: "yes" })).code, "SECURITY_POLICY_INVALID");
  const early = await api("owner", "PUT", "/auth/security-policy", { requireTwoFactor: true });
  assert.equal(early.status, 409);
  assert.equal(early.code, "TWO_FACTOR_NEEDED_FIRST");
  assert.equal((await api("owner", "GET", "/organisation/status")).body.policy.security.requireTwoFactor, false);
});

test("once required: a person without two-factor can read who they are and set it up, and nothing else - on the token they already hold", { skip }, async () => {
  const owner = await enrol("owner", "owner@sec.test");
  T.ownerSecret = owner.secret;
  await signInWithCode("owner", "owner@sec.test", owner.secret);
  const on = await api("owner", "PUT", "/auth/security-policy", { requireTwoFactor: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.deepEqual(on.body, { requireTwoFactor: true });
  assert.equal((await as("sec", () => M.Settings.findOne({}).lean())).security.requireTwoFactor, true);

  // will holds a token from before the rule, and has no two-factor
  for (const [method, url] of [["GET", "/customers/customers"], ["GET", "/transactions/transactions"], ["POST", "/customers"], ["GET", "/access/roles"], ["PUT", "/profile/me"], ["PUT", "/profile/change-password"], ["GET", "/company/profile"], ["POST", "/auth/2fa/disable"], ["POST", "/auth/2fa/recovery-codes"], ["GET", "/auth/2fa"], ["PUT", "/auth/security-policy"]]) {
    const refused = await api("will", method, url, method === "GET" ? undefined : {});
    assert.equal(refused.status, 403, `${method} ${url}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.code, "TWO_FACTOR_ENROLMENT_REQUIRED", `${method} ${url}`);
  }
  const status = await api("will", "GET", "/organisation/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.me.twoFactorRequired, true);
  assert.equal(status.body.me.twoFactorEnabled, false);
  assert.equal(status.body.policy.security.requireTwoFactor, true);
  assert.equal((await api("will", "GET", "/profile/me")).status, 200);

  const willEnrol = await enrol("will", "will@sec.test");
  assert.equal((await api("will", "GET", "/organisation/status")).body.me.twoFactorRequired, false);
  assert.notEqual((await api("will", "GET", "/customers/customers")).code, "TWO_FACTOR_ENROLMENT_REQUIRED", "the same token now opens everything its role allows");
  T.willSecret = willEnrol.secret;
});

test("signing in under the rule works, and a fresh account lands in the enrolment gate after choosing a password", { skip }, async () => {
  // zed's password was chosen by someone else AND there is no two-factor: the password comes first
  const zed = await signIn("zed@sec.test");
  assert.equal(zed.status, 200);
  T.zed = zed.body.tokens.accessToken;
  const first = await api("zed", "GET", "/customers/customers");
  assert.equal(first.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await api("zed", "POST", "/auth/2fa/setup", { password: PASSWORD })).code, "PASSWORD_CHANGE_REQUIRED", "he cannot start two-factor until the password is his own");
  assert.equal((await api("zed", "PUT", "/profile/change-password", { currentPassword: PASSWORD, newPassword: "zeds-own-password-1", confirmPassword: "zeds-own-password-1" })).status, 200);
  assert.equal((await api("zed", "GET", "/customers/customers")).code, "TWO_FACTOR_ENROLMENT_REQUIRED", "then the second gate");
});

test("while the rule is on, nobody can turn their own two-factor off", { skip }, async () => {
  await aLaterStep("owner@sec.test");
  const refused = await api("owner", "POST", "/auth/2fa/disable", { password: PASSWORD, code: codeNow(T.ownerSecret) });
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "TWO_FACTOR_REQUIRED_BY_POLICY");
  assert.equal((await person("owner@sec.test")).twoFactor.enabled, true);
  assert.equal((await api("owner", "GET", "/auth/2fa")).body.required, true);
});

test("an administrator's reset drops that person back into the gate; switching the rule off lifts it", { skip }, async () => {
  const will = await person("will@sec.test");
  assert.equal((await api("owner", "POST", `/access/users/${will._id}/2fa/reset`, {})).status, 200);
  const back = await signIn("will@sec.test");
  T.will = back.body.tokens.accessToken;
  assert.equal(back.body.twoFactorRequired, undefined, "no longer has it");
  assert.equal((await api("will", "GET", "/customers/customers")).code, "TWO_FACTOR_ENROLMENT_REQUIRED");

  const off = await api("owner", "PUT", "/auth/security-policy", { requireTwoFactor: false });
  assert.equal(off.status, 200);
  assert.notEqual((await api("will", "GET", "/customers/customers")).code, "TWO_FACTOR_ENROLMENT_REQUIRED", "the same token is open again");
  const trail = await as("sec", () => M.Activity.find({ action: "SECURITY_POLICY_CHANGED" }).lean());
  assert.equal(trail.length, 2);
});

// =====================================================================================================================
// the limits on a second server, and what is never kept
// =====================================================================================================================

test("an address that keeps asking for resets, or keeps failing the second step, is slowed", { skip }, async () => {
  start(PORT2, { FORGOT_PASSWORD_IP_LIMIT: "3", RESET_PASSWORD_IP_LIMIT: "3", LOGIN_FAILURE_LIMIT: "4", LOGIN_FAILURE_WINDOW_MS: "600000", FORGOT_PASSWORD_MIN_MS: "0" });
  await waitUp(BASE2);

  // forgot password: counted for every request, whoever it names, so the limit says nothing about accounts
  const ask = (email) => call("POST", "/auth/forgot-password", { body: { email }, base: BASE2 });
  for (const email of ["one@sec.test", "two@sec.test", "nobody@sec.test"]) assert.equal((await ask(email)).status, 200);
  const slowed = await ask("tina@sec.test");
  assert.equal(slowed.status, 429);
  assert.equal(slowed.code, "TOO_MANY_REQUESTS");
  for (let i = 0; i < 3; i++) assert.equal((await reset("short", "whatever-password-1", BASE2)).status, 400);
  assert.equal((await reset("short", "whatever-password-1", BASE2)).status, 429, "the reset endpoint has its own limit");

  // wrong passwords and wrong codes share ONE bucket per address
  await aLaterStep("owner@sec.test");
  const challenge = (await signIn("owner@sec.test", PASSWORD, BASE2)).body.challengeToken;
  assert.ok(challenge);
  assert.equal((await signIn("owner@sec.test", "wrong-one-1", BASE2)).status, 401);
  assert.equal((await signIn("owner@sec.test", "wrong-two-2", BASE2)).status, 401);
  assert.equal((await second(challenge, { code: "000001" }, BASE2)).status, 401);
  assert.equal((await second(challenge, { code: "000002" }, BASE2)).status, 401);
  const blocked = await second(challenge, { code: codeNow(T.ownerSecret) }, BASE2);
  assert.equal(blocked.status, 429, "four failures between the two doors, and the right code is turned away too");
  assert.equal(blocked.code, "TOO_MANY_ATTEMPTS");
  assert.ok(Number(blocked.retryAfter) > 0);
  assert.equal((await signIn("owner@sec.test", PASSWORD, BASE2)).status, 429, "the password door is shut as well");
  assert.equal((await signIn("owner@sec.test", PASSWORD)).status, 200, "the other server counts for itself");
});

test("no secret was kept anywhere it should not be: not the trail, not the database, not the logs", { skip }, async () => {
  assert.ok(seen.secrets.length >= 3 && seen.recovery.length >= 30 && seen.resetTokens.length >= 5, "the test did see secrets to look for");
  const trail = JSON.stringify(await as("sec", () => M.Activity.find({}).lean()));
  const everyAdmin = JSON.stringify(await as("sec", () => M.Admin.find({}).select("+password +twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.recoveryCodes").lean()));
  const resets = JSON.stringify(await as("sec", () => M.PasswordReset.find({}).lean()));
  for (const secret of seen.secrets) for (const [where, text] of [["trail", trail], ["accounts", everyAdmin], ["resets", resets], ["logs", logs]]) assert.ok(!text.includes(secret), `a setup key is in the ${where}`);
  for (const code of seen.recovery) for (const [where, text] of [["trail", trail], ["accounts", everyAdmin], ["logs", logs]]) assert.ok(!text.includes(code), `a recovery code is in the ${where}`);
  for (const token of seen.resetTokens) for (const [where, text] of [["trail", trail], ["accounts", everyAdmin], ["resets", resets], ["logs", logs]]) assert.ok(!text.includes(token), `a reset token is in the ${where}`);
});
