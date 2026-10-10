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
  const prod = (extra = {}) => configProblems({ NODE_ENV: "production", MONGO_URI: "mongodb+srv://x", JWT_SECRET: STRONG, SECRET_BOX_KEY: "a".repeat(64), PUBLIC_APP_URL: "https://app.example", PLATFORM_JWT_SECRET: `${STRONG}-platform`, ...extra });
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
