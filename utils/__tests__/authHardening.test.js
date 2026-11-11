// The pure rules behind the authentication hardening (the HTTP behaviour is in services/__tests__/authAttackHttp.test.js and
// securityHeadersHttp.test.js): what a production server insists on, how many proxies it trusts, what the two kinds of token say, and
// that nobody has put a debug print of a request or a document back into the code that handles them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { weakness, configProblems, assertProductionConfig, jwtSecret, MIN_SECRET_LENGTH } = require("../productionConfig");
const { trustProxyHops } = require("../trustProxy");
const { EventEmitter } = require("events");
const { loginThrottle, sharedClientAddress } = require("../../middleware/loginThrottle");

const STRONG = "k3Jd9sL0pQx7VbN2mZc8TyH5wRf1GaE6uIo4PtYq3XnMvB0cDjSl9AkWe7UhZr2F";

test("a signing key is judged on being set, not a placeholder, long enough and varied", () => {
  assert.equal(weakness(STRONG), null);
  assert.match(weakness(""), /not set/);
  assert.match(weakness(undefined), /not set/);
  assert.match(weakness("your-secret-key"), /placeholder/);
  assert.match(weakness("Secret"), /placeholder/, "case does not rescue a placeholder");
  assert.match(weakness("x".repeat(MIN_SECRET_LENGTH - 1)), /shorter/);
  assert.match(weakness("a".repeat(64)), /variety/);
  assert.equal(weakness("ab".repeat(2) + "cdefghij".repeat(4)), null);
});

test("production insists on a real key; any other environment only warns or says nothing", () => {
  const prod = (extra = {}) => configProblems({ NODE_ENV: "production", MONGO_URI: "mongodb+srv://x", JWT_SECRET: STRONG, SECRET_BOX_KEY: "a".repeat(64), PUBLIC_APP_URL: "https://app.example", PLATFORM_JWT_SECRET: `${STRONG}-platform`, SYSTEM_MAIL_PROVIDER: "resend", ...extra });
  assert.deepEqual(prod(), { fatal: [], warnings: [] });
  assert.equal(prod({ JWT_SECRET: "" }).fatal.length, 1);
  assert.match(prod({ JWT_SECRET: "your-secret-key" }).fatal[0], /JWT_SECRET/);
  assert.match(prod({ JWT_SECRET: "short" }).fatal[0], /shorter/);
  assert.match(prod({ PLATFORM_JWT_SECRET: STRONG }).fatal[0], /must differ/);
  assert.match(prod({ PLATFORM_JWT_SECRET: "tiny" }).fatal[0], /PLATFORM_JWT_SECRET/);
  assert.match(prod({ MONGO_URI: "" }).fatal[0], /MONGO_URI/);
  // things worth knowing but not worth refusing to start for
  const warned = prod({ SECRET_BOX_KEY: undefined, PUBLIC_APP_URL: undefined, PLATFORM_JWT_SECRET: undefined });
  assert.equal(warned.fatal.length, 0);
  assert.equal(warned.warnings.length, 3);
  // mail that goes nowhere: "forgot my password" answers the person normally and sends nothing, so the only way
  // back in is an administrator. Worth saying loudly, not worth refusing to start for.
  for (const provider of [undefined, "console"]) {
    const quiet = prod({ SYSTEM_MAIL_PROVIDER: provider });
    assert.equal(quiet.fatal.length, 0, `provider ${provider}`);
    assert.equal(quiet.warnings.length, 1, `provider ${provider}`);
    assert.match(quiet.warnings[0], /SYSTEM_MAIL_PROVIDER/);
  }
  for (const provider of ["resend", "smtp"]) assert.deepEqual(prod({ SYSTEM_MAIL_PROVIDER: provider }), { fatal: [], warnings: [] });
  // development and tests: no opinion
  assert.deepEqual(configProblems({ NODE_ENV: "development", JWT_SECRET: "x" }), { fatal: [], warnings: [] });
  assert.deepEqual(configProblems({}), { fatal: [], warnings: [] });
});

test("the check exits with 1 on a fatal problem, prints it, and never prints the key", () => {
  const lines = [];
  let code = null;
  const log = { warn: (m) => lines.push(`W ${m}`), error: (m) => lines.push(`E ${m}`) };
  assertProductionConfig({ NODE_ENV: "production", MONGO_URI: "x", JWT_SECRET: "your-secret-key" }, { exit: (c) => { code = c; }, log });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => /REFUSING TO START/.test(l)));
  assert.ok(!lines.join("\n").includes("your-secret-key"), "the key is not printed");
  code = null;
  assertProductionConfig({ NODE_ENV: "production", MONGO_URI: "x", JWT_SECRET: STRONG }, { exit: (c) => { code = c; }, log });
  assert.equal(code, null);
});

test("the signing key has no fallback in production", () => {
  assert.equal(jwtSecret({ JWT_SECRET: STRONG }), STRONG);
  assert.throws(() => jwtSecret({ NODE_ENV: "production" }), /JWT_SECRET is not set/);
  assert.equal(jwtSecret({ NODE_ENV: "test" }), "your-secret-key", "only away from production, so a developer's laptop works");
});

test("how many proxies are trusted: none by default, two on Render, whatever the operator says, nothing silly", () => {
  assert.equal(trustProxyHops({}), 0);
  assert.equal(trustProxyHops({ RENDER: "true" }), 2);
  assert.equal(trustProxyHops({ RENDER: "true", TRUST_PROXY_HOPS: "1" }), 1);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: "0" }), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: " 3 " }), 3);
  for (const bad of ["-1", "11", "1.5", "all", "true", "NaN"]) assert.throws(() => trustProxyHops({ TRUST_PROXY_HOPS: bad }), /TRUST_PROXY_HOPS/, bad);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: "" }), 0, "empty means unset");
});

// Counting proxy hops alone landed on a CLOUDFLARE address on the live service - a different one per request - so every
// per-address limit shared one rotating allowance and every stored address was Cloudflare's. The visitor's address comes
// from Cloudflare's own header instead; this pins the two rules that make that safe.
test("the visitor's address comes from CF-Connecting-IP, and only where Cloudflare is in front of us", () => {
  const { cloudflareClientIp, trustCloudflareHeader } = require("../../middleware/clientAddress");
  const req = (value) => ({ headers: value === undefined ? {} : { "cf-connecting-ip": value } });

  // one address, taken as given
  assert.equal(cloudflareClientIp(req("203.0.113.9")), "203.0.113.9");
  assert.equal(cloudflareClientIp(req("  203.0.113.9  ")), "203.0.113.9");
  assert.equal(cloudflareClientIp(req("2001:db8::1")), "2001:db8::1");

  // anything that is not exactly one address leaves Express's own answer standing, which is what this replaced.
  // A list is what Node gives when the header arrives twice - someone trying to prepend their own choice.
  for (const bad of [undefined, "", "   ", "203.0.113.9, 1.2.3.4", "evil.example", "not-an-ip", "999.1.1.1",
                     "203.0.113.9:443", ["1.2.3.4", "5.6.7.8"], 12345, null, "x".repeat(200)]) {
    assert.equal(cloudflareClientIp(req(bad)), null, `should not be read as an address: ${String(bad)}`);
  }

  // the gate: off Cloudflare that header is a free pass to name your own address, so it is off unless we know better
  assert.equal(trustCloudflareHeader({}), false, "a laptop and the spawned test servers must not trust it");
  assert.equal(trustCloudflareHeader({ RENDER: "true" }), true, "all *.onrender.com traffic transits Cloudflare");
  assert.equal(trustCloudflareHeader({ RENDER: "true", TRUST_CF_CONNECTING_IP: "0" }), false, "a kill switch that needs no code deploy");
  assert.equal(trustCloudflareHeader({ TRUST_CF_CONNECTING_IP: "true" }), true, "another Cloudflare-fronted host");
  assert.equal(trustCloudflareHeader({ RENDER: "true", TRUST_CF_CONNECTING_IP: "" }), true, "empty means unset");
  for (const bad of ["maybe", "2", "-1"]) assert.throws(() => trustCloudflareHeader({ TRUST_CF_CONNECTING_IP: bad }), /TRUST_CF_CONNECTING_IP/, bad);
});

test("an access token says it is one, a refresh token says it is another, and only HS256 is read", () => {
  const { generateTokens, verifyToken } = require("../../services/core/adminService");
  const { accessToken, refreshToken, jti } = generateTokens({ id: "64b64b64b64b64b64b64b64b", email: "a@b.co", type: "viewer" }, "sid-1");
  const a = jwt.decode(accessToken);
  const r = jwt.decode(refreshToken);
  assert.equal(a.use, "access");
  assert.equal(a.type, "viewer", "the account type claim is still the account type: access tokens issued before this change read the same");
  assert.equal(r.type, "refresh");
  assert.equal(r.use, "refresh");
  assert.equal(r.jti, jti);
  assert.equal(r.sid, "sid-1");
  assert.ok(r.exp > Math.floor(Date.now() / 1000));
  // the replacement cookie ends when the session does
  const exp = Math.floor(Date.now() / 1000) + 1234;
  assert.equal(jwt.decode(generateTokens({ id: "x" }, "s", { refreshExp: exp, jti: "j" }).refreshToken).exp, exp);
  // two refresh tokens never share an id
  assert.notEqual(generateTokens({ id: "x" }, "s").jti, generateTokens({ id: "x" }, "s").jti);
  // verification
  assert.equal(verifyToken(accessToken).sid, "sid-1");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...a })).toString("base64url")}.`;
  assert.throws(() => verifyToken(unsigned), { code: "INVALID_TOKEN" });
  const hs512 = jwt.sign({ id: "x" }, jwtSecret(), { algorithm: "HS512", issuer: "ERP-system", audience: "ERP-admin" });
  assert.throws(() => verifyToken(hs512), { code: "INVALID_TOKEN" }, "another algorithm of the same key is not accepted either");
});

test("no controller, service, route or middleware prints a request or a document: debug output goes through the logger, which is off in production", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (/^\s*console\.log\(/.test(line)) offenders.push(`${path.relative(ROOT, full)}:${i + 1}`);
        });
      }
    }
  };
  for (const dir of ["controllers", "services", "routes", "middleware"]) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, [], `console.log in code that handles requests: ${offenders.join(", ")}. Use utils/logger (logger.debug).`);
});

// =====================================================================================================================
// the sign-in throttle when the address is not the visitor's
// =====================================================================================================================
// Put the API behind the app's own origin (a Render static-site rewrite) and every request reaches the backend from ONE
// address. An address bucket is then a GLOBAL bucket: twenty failures by anybody would shut the door on every client in
// the world. SHARED_CLIENT_ADDRESS=true says so and moves the counting onto the two keys that still mean something.
// Unset, nothing about the throttle changes - which is what the first two tests below are for.

// One pass through the middleware. `status` is what the request ends as, and only a failure is counted.
const doorFor = (options) => {
  const mw = loginThrottle(options);
  return (ip, email, status = 401) =>
    new Promise((resolve) => {
      const req = { ip, body: email === null ? {} : { email }, socket: {} };
      const res = new EventEmitter();
      res.statusCode = status;
      res.sent = {};
      res.set = (k, v) => { res.sent[k] = v; };
      mw(req, res, (err) => {
        if (err) return resolve({ refused: true, code: err.code, status: err.statusCode, message: err.message, retryAfter: res.sent["Retry-After"] });
        res.emit("finish");
        resolve({ refused: false });
      });
    });
};

test("SHARED_CLIENT_ADDRESS is read as a plain true or false, and says nothing unless it is set", () => {
  assert.equal(sharedClientAddress({}), false);
  assert.equal(sharedClientAddress({ SHARED_CLIENT_ADDRESS: "" }), false);
  assert.equal(sharedClientAddress({ SHARED_CLIENT_ADDRESS: "   " }), false);
  for (const yes of ["1", "true", "TRUE", "yes", "on"]) assert.equal(sharedClientAddress({ SHARED_CLIENT_ADDRESS: yes }), true, yes);
  for (const no of ["0", "false", "no", "off"]) assert.equal(sharedClientAddress({ SHARED_CLIENT_ADDRESS: no }), false, no);
  assert.throws(() => sharedClientAddress({ SHARED_CLIENT_ADDRESS: "maybe" }), /must be true or false/);
});

test("with the address its own, the throttle counts per address exactly as it always did", async () => {
  const door = doorFor({ shared: false, max: 3, windowMs: 60000 });
  for (const who of ["a", "b", "c"]) assert.equal((await door("1.1.1.1", who + "@x.test")).refused, false);
  const shut = await door("1.1.1.1", "d@x.test");
  assert.equal(shut.refused, true, "three failures from one address and the fourth was still answered");
  assert.equal(shut.code, "TOO_MANY_ATTEMPTS");
  assert.equal(shut.status, 429);
  assert.match(shut.message, /from this address/);
  assert.ok(Number(shut.retryAfter) > 0, "a refusal says how long to wait");
  assert.equal((await door("2.2.2.2", "e@x.test")).refused, false, "another address keeps its own allowance");
});

test("only failures count, so an office signing in successfully all morning is never held up", async () => {
  const door = doorFor({ shared: false, max: 2, windowMs: 60000 });
  for (let i = 0; i < 10; i += 1) assert.equal((await door("1.1.1.1", "a@x.test", 200)).refused, false);
});

test("behind a shared address the address bucket is off, so one proxy cannot lock out every client at once", async () => {
  const door = doorFor({ shared: true, max: 3, accountMax: 50, overallMax: 1000, windowMs: 60000 });
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await door("10.0.0.1", "person-" + i + "@x.test")).refused, false, "attempt " + i + " was refused on the address everyone arrives from");
  }
});

test("behind a shared address, guessing at one account is still stopped wherever it comes from", async () => {
  const door = doorFor({ shared: true, accountMax: 3, overallMax: 1000, windowMs: 60000 });
  for (let i = 0; i < 3; i += 1) await door("10.0.0." + i, "victim@x.test");
  const shut = await door("10.0.0.9", "  VICTIM@X.test  ");
  assert.equal(shut.refused, true, "case and spacing bought a fresh allowance: the key is not normalised as sign-in normalises it");
  assert.match(shut.message, /for this account/);
  assert.equal((await door("10.0.0.9", "someone-else@x.test")).refused, false, "another account is unaffected");

  // the body is the client's to write, so anything that is not a string names nobody
  const hostile = doorFor({ shared: true, accountMax: 1, overallMax: 1000, windowMs: 60000 });
  await hostile("10.0.0.1", { $ne: null });
  assert.equal((await hostile("10.0.0.2", { $ne: null })).refused, false, "an object was taken for an account name");
});

test("behind a shared address one overall ceiling is all that is left to catch credential stuffing", async () => {
  const door = doorFor({ shared: true, accountMax: 50, overallMax: 5, windowMs: 60000 });
  for (let i = 0; i < 5; i += 1) assert.equal((await door("10.0.0.1", "stuff-" + i + "@x.test")).refused, false);
  const shut = await door("10.0.0.1", "stuff-6@x.test");
  assert.equal(shut.refused, true, "every try named a different account from the one address, so only the ceiling could stop it");
  assert.equal(shut.code, "TOO_MANY_ATTEMPTS");
  assert.doesNotMatch(shut.message, /this address|this account/, "the ceiling is neither, and must not claim to be");
});

test("the second sign-in step names no account, so behind a shared address only the ceiling holds it", async () => {
  const door = doorFor({ shared: true, accountMax: 2, overallMax: 4, windowMs: 60000 });
  for (let i = 0; i < 4; i += 1) assert.equal((await door("10.0.0.1", null)).refused, false);
  assert.equal((await door("10.0.0.1", null)).refused, true);
});
