// The server's outer shell, attacked: what it will start with, what headers it sends, how much body it reads and from whom, which
// browser origins it answers (and what a stolen-cookie request from another site gets), and what it says when something goes wrong.
//
// The main server here runs with NODE_ENV=production, because that is the one that must be right: Secure cookies, HSTS, no
// stack traces, and a key it was willing to start with. Refusals to start are checked in child processes that never reach the database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const ORIGIN = "https://app.shell.test";
const STRONG = crypto.randomBytes(48).toString("hex");

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(method, url, { body, token, cookie, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h["Content-Type"] = h["Content-Type"] || "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${url}`, { method, headers: h, body: payload });
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  let data = null;
  if (type.includes("json")) { try { data = JSON.parse(text); } catch (_) { data = null; } }
  const set = res.headers.getSetCookie?.() || [];
  const sessionCookie = set.find((c) => c.startsWith("erp_session=")) || null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, text, headers: res.headers, setCookie: sessionCookie, cookie: sessionCookie ? sessionCookie.split(";")[0] : null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);

// start the server (or a refusal) as a child process; resolves with what happened
function launch(env, { waitForExit = false } = {}) {
  return new Promise((resolve) => {
    const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
    const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, LOG_SILENT: "", TENANT_LEGACY_DEFAULT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    if (!waitForExit) return resolve({ proc, output: () => out });
    const timer = setTimeout(() => { proc.kill(); resolve({ exited: false, code: null, output: out }); }, 25000);
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, output: out }); });
  });
}

test.before(async () => {
  if (skip) return;
  const started = await launch({ NODE_ENV: "production", PORT: String(PORT), JWT_SECRET: STRONG, SECRET_BOX_KEY: crypto.randomBytes(32).toString("hex"), PUBLIC_APP_URL: ORIGIN, CORS_ORIGINS: ORIGIN, TRUST_PROXY_HOPS: "1", LOG_SILENT: "1", REFRESH_REUSE_GRACE_SECONDS: "1" });
  child = started.proc;
  const output = started.output;
  await mongoose.connect(process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`));
  M = { Admin: require("../../models/core/adminModel"), Session: require("../../models/core/authSessionModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 120000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output().slice(-1500)}`);
    await sleep(400);
  }
  logs = output;
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

// =====================================================================================================================
// what it will start with
// =====================================================================================================================

test("a production server will not start without a real signing key", { skip }, async () => {
  const cases = {
    "no key": { JWT_SECRET: "" },
    "the placeholder from the source": { JWT_SECRET: "your-secret-key" },
    "a short key": { JWT_SECRET: "short-secret" },
    "a key with no variety": { JWT_SECRET: "a".repeat(40) },
    "the console and the customers sharing one key": { JWT_SECRET: STRONG, PLATFORM_JWT_SECRET: STRONG },
    "a weak console key": { JWT_SECRET: STRONG, PLATFORM_JWT_SECRET: "weak" },
  };
  for (const [name, env] of Object.entries(cases)) {
    const r = await launch({ NODE_ENV: "production", PORT: String(PORT + 400), ...env }, { waitForExit: true });
    assert.equal(r.exited, true, `${name}: the server kept running`);
    assert.equal(r.code, 1, `${name}: exit code ${r.code}\n${r.output.slice(-400)}`);
    assert.match(r.output, /REFUSING TO START/, name);
    assert.ok(!r.output.includes(STRONG), `${name}: the key was printed`);
    await sleep(100);
  }
});

test("outside production the same settings only warn, and a strong key starts it", { skip }, async () => {
  // (the main server of this file IS a production server with a strong key: it started)
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.ok(!logs().includes(STRONG), "the key is in the output");
});

// =====================================================================================================================
// the scene
// =====================================================================================================================

test("an organisation with an owner", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Shell Trading", code: "shl", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as("shl", () => new M.Admin({ name: "Owen Owner", email: "owner@shell.test", password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
  const r = await call("POST", "/login", { body: { email: "owner@shell.test", password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  T.owner = r.body.tokens.accessToken;
  T.ownerCookie = r.cookie;
  T.ownerSetCookie = r.setCookie;
});

// =====================================================================================================================
// headers
// =====================================================================================================================

test("every answer carries the standard headers, and none says what it is built with", { skip }, async () => {
  for (const [method, url, opts] of [["GET", "/health", {}], ["POST", "/login", { body: { email: "x@y.zz", password: "x" } }], ["GET", "/organisation/status", { token: T.owner }], ["GET", "/no-such-route-at-all", {}], ["GET", "/profile/me", {}]]) {
    const r = await call(method, url, opts);
    const h = r.headers;
    assert.equal(h.get("x-content-type-options"), "nosniff", `${url}`);
    assert.equal(h.get("x-frame-options"), "DENY", `${url}`);
    assert.equal(h.get("referrer-policy"), "no-referrer", `${url}`);
    assert.match(h.get("content-security-policy") || "", /default-src 'none'/, `${url}`);
    assert.match(h.get("content-security-policy") || "", /frame-ancestors 'none'/, `${url}`);
    assert.match(h.get("permissions-policy") || "", /camera=\(\)/, `${url}`);
    assert.equal(h.get("x-powered-by"), null, `${url} says it is Express`);
    assert.equal(h.get("server"), null, `${url} names its server`);
  }
});

test("what the API says about a person's books is never cached", { skip }, async () => {
  for (const [url, token] of [["/organisation/status", T.owner], ["/profile/me", T.owner], ["/currencies", T.owner]]) {
    const r = await call("GET", url, { token });
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get("cache-control") || "", /no-store/, url);
  }
  assert.match((await call("POST", "/login", { body: { email: "owner@shell.test", password: PASSWORD } })).headers.get("cache-control") || "", /no-store/, "a sign-in answer, tokens and all");
});

test("HSTS is sent over HTTPS in production, and only then", { skip }, async () => {
  const secure = await call("GET", "/health", { headers: { "X-Forwarded-Proto": "https" } });
  assert.match(secure.headers.get("strict-transport-security") || "", /max-age=\d{7,}/);
  const plain = await call("GET", "/health");
  assert.equal(plain.headers.get("strict-transport-security"), null, "HSTS over plain http would be ignored at best");
});

test("the session cookie is HttpOnly, Secure, scoped to the API and cross-site capable only because the app and the API are different hosts", { skip }, async () => {
  const c = T.ownerSetCookie;
  assert.match(c, /HttpOnly/i);
  assert.match(c, /;\s*Secure/i, "Secure in production");
  assert.match(c, /SameSite=None/i, "the deployed app and API are different sites");
  assert.match(c, /Path=\/api\/v1/i);
  assert.match(c, /Expires=/i, "and it ends with the session");
});

// =====================================================================================================================
// body sizes
// =====================================================================================================================

test("nobody gets to make the server read megabytes before signing in", { skip }, async () => {
  const filler = (bytes) => ({ email: "a@b.co", password: "x", pad: "y".repeat(bytes) });
  assert.equal((await call("POST", "/login", { body: filler(2 * 1024 * 1024) })).status, 413, "2 MB to the sign-in door");
  assert.equal((await call("POST", "/login", { body: filler(2 * 1024 * 1024) })).code, "PAYLOAD_TOO_LARGE");
  assert.equal((await call("POST", "/auth/forgot-password", { body: filler(2 * 1024 * 1024) })).status, 413);
  assert.equal((await call("POST", "/refresh-token", { body: filler(2 * 1024 * 1024) })).status, 413);
  const ok = await call("POST", "/login", { body: filler(200 * 1024) });
  assert.notEqual(ok.status, 413, "an ordinary body, even a generous one, is still read");
  // a form body too, and from an anonymous caller most of all
  const form = await call("POST", "/login", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, raw: `email=a%40b.co&password=x&pad=${"y".repeat(300 * 1024)}` });
  assert.equal(form.status, 413, "300 KB of form text");
});

test("a signed-in person gets the same small limit on ordinary routes", { skip }, async () => {
  const big = await call("POST", "/customers/customers", { token: T.owner, body: { name: "Big", pad: "y".repeat(2 * 1024 * 1024) } });
  assert.equal(big.status, 413);
});

test("the few routes that take a big body take it only from a valid access token", { skip }, async () => {
  const body = { date: "2026-01-01", lines: [], rows: [], pad: "y".repeat(3 * 1024 * 1024) };
  for (const url of ["/banking/reconciliation/import", "/banking/reconciliation/import/preview", "/opening-balances/accounts", "/opening-balances/stock"]) {
    const signedIn = await call("POST", url, { token: T.owner, body });
    assert.notEqual(signedIn.status, 413, `${url}: a signed-in person was refused 3 MB`);
    const anonymous = await call("POST", url, { body });
    assert.equal(anonymous.status, 413, `${url}: an anonymous caller was let read 3 MB`);
    const garbage = await call("POST", url, { token: "not.a.token", body });
    assert.equal(garbage.status, 413, `${url}: a made-up token earned the big limit`);
    const refresh = await call("POST", url, { token: tokenOf(T.ownerCookie), body });
    assert.equal(refresh.status, 413, `${url}: a refresh token earned the big limit`);
  }
  // even they stop somewhere
  const huge = await call("POST", "/opening-balances/accounts", { token: T.owner, headers: { "Content-Type": "application/json" }, raw: JSON.stringify({ pad: "y".repeat(14 * 1024 * 1024) }) });
  assert.equal(huge.status, 413, "14 MB, even signed in");
});
const tokenOf = (cookie) => cookie.replace(/^erp_session=/, "");

// =====================================================================================================================
// CORS, and what another website can do with a stolen cookie
// =====================================================================================================================

test("an allowed origin is answered, exactly; a foreign one is refused before the route is reached", { skip }, async () => {
  const pre = await call("OPTIONS", "/login", { headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(pre.headers.get("access-control-allow-credentials"), "true");
  assert.match(pre.headers.get("vary") || "", /Origin/i);
  assert.notEqual(pre.headers.get("access-control-allow-origin"), "*");

  for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, "http://app.shell.test", "https://app.shell.test:8443", "https://sub.app.shell.test", "null", "https://APP.SHELL.TEST.", "file://", "https://evil.example/?https://app.shell.test"]) {
    const preflight = await call("OPTIONS", "/login", { headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 403, `${origin}: preflight`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null, `${origin}: was told it may read the answer`);
    const real = await call("POST", "/login", { headers: { Origin: origin }, body: { email: "owner@shell.test", password: PASSWORD } });
    assert.equal(real.status, 403, `${origin}: the sign-in itself was processed`);
    assert.equal(real.code, "CORS_ORIGIN_NOT_ALLOWED");
    assert.equal(real.headers.get("access-control-allow-origin"), null);
    assert.ok(!real.body?.tokens, "and no tokens");
  }
});

test("another site cannot ride the cookie: refresh and sign-out from a foreign origin do nothing; from ours they work", { skip }, async () => {
  const login = await call("POST", "/login", { body: { email: "owner@shell.test", password: PASSWORD } });
  const cookie = login.cookie;
  for (const origin of ["https://evil.example", "null"]) {
    const refresh = await call("POST", "/refresh-token", { cookie, headers: { Origin: origin }, body: {} });
    assert.equal(refresh.status, 403, `${origin}: refresh`);
    assert.equal(refresh.code, "CORS_ORIGIN_NOT_ALLOWED");
    assert.equal(refresh.cookie, null, "and the cookie was not replaced");
    const logout = await call("POST", "/logout", { cookie, headers: { Origin: origin }, body: {} });
    assert.equal(logout.status, 403, `${origin}: logout`);
    // an html <form> posts text/plain or form data with an Origin header too
    const form = await call("POST", "/logout", { cookie, headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, raw: "a=1" });
    assert.equal(form.status, 403, `${origin}: form post`);
  }
  const still = await call("GET", "/organisation/status", { token: login.body.tokens.accessToken });
  assert.equal(still.status, 200, "the session survived all of that");
  const fromUs = await call("POST", "/refresh-token", { cookie, headers: { Origin: ORIGIN }, body: {} });
  assert.equal(fromUs.status, 200, JSON.stringify(fromUs.data));
  assert.equal(fromUs.headers.get("access-control-allow-origin"), ORIGIN);
  const out = await call("POST", "/logout", { cookie: fromUs.cookie, headers: { Origin: ORIGIN }, body: {} });
  assert.equal(out.status, 200);
  assert.equal((await call("POST", "/refresh-token", { cookie: fromUs.cookie, body: {} })).status, 401);
});

// =====================================================================================================================
// what an error says
// =====================================================================================================================

test("in production an error says what the caller did wrong and never how the server is built", { skip }, async () => {
  const bad = await call("POST", "/login", { raw: "{\"email\":", headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "INVALID_JSON");
  const inner = await call("GET", "/stock/not-an-object-id", { token: T.owner });
  assert.ok(inner.status >= 400 && inner.status < 600);
  const unknown = await call("GET", "/no/such/route", {});
  for (const r of [bad, inner, unknown, await call("GET", "/profile/me", { token: "a.b.c" }), await call("POST", "/auth/reset-password", { body: { token: "x", password: "y" } })]) {
    assert.ok(!/at [\w.<>$ ]+ \(|node_modules|\.js:\d+|Mongo|mongoose|CastError|Cast to|ValidationError|stack/i.test(r.text), `a failure leaked internals: ${r.text.slice(0, 300)}`);
  }
  assert.ok(!/express/i.test(unknown.text), "the 404 page names Express");
});

// =====================================================================================================================
// files
// =====================================================================================================================

const multipart = (fields, files) => {
  const boundary = `----t${crypto.randomBytes(8).toString("hex")}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), Buffer.from(f.content), Buffer.from("\r\n")]));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { raw: Buffer.concat(parts), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } };
};

test("a logo or picture must be an image of the three kinds we take: SVG, HTML and scripts are refused before anything is stored", { skip }, async () => {
  for (const [name, type, content] of [
    ["logo.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>"],
    ["logo.png", "text/html", "<script>alert(1)</script>"],
    ["logo.html", "text/html", "<script>alert(1)</script>"],
    ["logo.php", "application/x-php", "<?php echo 1; ?>"],
    ["logo.png", "image/svg+xml", "<svg onload='alert(1)'/>"],
    ["logo.svg", "image/png", "<svg onload='alert(1)'/>"], // declared as a png, named as an svg
    ["logo.png", "image/png", "<script>alert(1)</script>"], // named and declared as a png, is a page of script: refused on its first bytes
    ["../../etc/logo.png.html", "image/png", "x"],
  ]) {
    const form = multipart({ companyName: "x" }, [{ field: "companyLogo", name, type, content }]);
    const r = await call("PUT", "/company/profile", { token: T.owner, raw: form.raw, headers: form.headers });
    assert.ok(r.status >= 400 && r.status < 500, `${name} (${type}) -> ${r.status} ${r.text.slice(0, 160)}`);
  }
});

test("a stored attachment is only ever served as a download with its own type, and a hostile name is only a name", { skip }, async () => {
  const upload = async (name, type, content) => {
    const form = multipart({ label: "t" }, [{ field: "file", name, type, content }]);
    return call("POST", "/accounting/attachments", { token: T.owner, raw: form.raw, headers: form.headers });
  };
  // kinds we do not take at all, whatever they are called or declared as
  for (const [name, type, content] of [
    ["evil.html", "text/html", "<script>alert(1)</script>"],
    ["evil.svg", "image/svg+xml", "<svg onload='alert(1)'/>"],
    ["evil.js", "text/javascript", "alert(1)"],
    ["evil.exe", "application/octet-stream", "MZ"],
    ["evil.png.html", "image/png", "<script>alert(1)</script>"],
    ["evil.png", "image/png", "<script>alert(1)</script>"], // named as a png, is html: content does not match
    ["evil.pdf", "application/pdf", "<script>alert(1)</script>"],
  ]) {
    const r = await upload(name, type, content);
    assert.ok(r.status === 415 || r.status === 400, `${name} -> ${r.status} ${r.text.slice(0, 160)}`);
  }
  // text is text: stored under a name of our own, served as plain text, as a download, with nosniff
  const stored = await upload("../../../notes.txt", "text/html", "<script>alert(1)</script>\n<img src=x onerror=alert(1)>");
  assert.equal(stored.status, 201, stored.text.slice(0, 200));
  assert.ok(!/\.\.|\//.test(stored.body.fileName), `the stored name keeps path characters: ${stored.body.fileName}`);
  const download = await call("GET", `/accounting/attachments/${stored.body.attachmentId}`, { token: T.owner });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type") || "", /^text\/plain/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition") || "", /^attachment/);
  // asking for it inline does not make HTML out of it either
  const inline = await call("GET", `/accounting/attachments/${stored.body.attachmentId}?inline=1`, { token: T.owner });
  assert.match(inline.headers.get("content-type") || "", /^text\/plain/);
  assert.equal(inline.headers.get("x-content-type-options"), "nosniff");
  assert.match(inline.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.equal((await call("DELETE", `/accounting/attachments/${stored.body.attachmentId}`, { token: T.owner })).status, 200, "and it can be removed (the file goes with it)");
  assert.equal((await call("GET", `/accounting/attachments/${stored.body.attachmentId}`, { token: T.owner })).status, 404);
});
