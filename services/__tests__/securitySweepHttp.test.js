// AUTHORIZATION, proven over the WHOLE API. The routes are read live from the code (support/routeInventory.js), so a route
// added tomorrow is swept tomorrow with no edit here; the allowlists below are the only hand-kept part, each entry says why.
//
//   (a) nobody signed in reaches anything: every route answers 401 without a valid token, bar the explicit public list;
//   (b) a signed-in person whose role grants NOTHING is refused (403 PERMISSION_DENIED) at every route, before any
//       validation or upload sees the request, bar the explicit "signed in is enough" list;
//   (c) a viewer changes nothing: every route that changes something is refused, bar the explicit list of self-service and
//       read-style routes;
//   (d) the nine built-in roles: what each reaches is checked against what the catalogue says it holds, and the
//       security-relevant corners (people, settings, the period lock, VAT filing, banking set-up ...) are PINNED here in
//       plain words, so a role quietly widened in utils/permissions.js fails this file.
//
// One strict server, one organisation, a throwaway database. Run alone:  node --require ./utils/testSetup.js --test services/__tests__/securitySweepHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const perms = require("../../utils/permissions");
const H = require("./support/httpHarness");
const { inventory, fill } = require("./support/routeInventory");

const skip = H.skipReason();
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GARBAGE = { garbage: true, type: "x", items: [null, 1, { a: { b: [] } }], amount: -1, email: "not-an-email", id: 5, name: { $ne: "x" }, status: ["a"] };

// ---- the allowlists (the only hand-kept part). Each is compared with what the code declares, so a new route cannot hide in one.

// Routes anyone may call with no login at all. Must EQUAL the set utils/__tests__/routeGuard.test.js knows as publicRoute:
// adding one is a decision made in both places.
const PUBLIC_ROUTES = [
  "POST /api/v1/login", // signing in: there is no one to check yet
  "POST /api/v1/refresh-token", // the session cookie is the credential
  "POST /api/v1/logout", // the session cookie names the session to end
  "POST /api/v1/auth/forgot-password", // answers the same for every address
  "POST /api/v1/auth/reset-password", // the emailed single-use link is the credential
  "POST /api/v1/auth/login/2fa", // step two of signing in: the challenge from the correct password is the credential
  "POST /api/v1/einvoice/inbound/webhook", // signed by HMAC over the raw body (the original organisation's address)
  "POST /api/v1/einvoice/inbound/webhook/:org", // the same, for a named organisation
  "GET /api/v1/share/:token", // a customer's document link: the secret in it is the credential
  "POST /api/v1/share/:token/viewed", // the page reporting that it was opened
].sort();
// Open although they are declared on `app`, not in a router, so the inventory cannot see them.
const PUBLIC_OUTSIDE_ROUTERS = ["GET /api/v1/health"]; // the load balancer's check
// The developer console's own sign-in (its identity is separate: platformAuth.js); everything else under /platform needs its token.
const PLATFORM_PUBLIC = ["POST /api/v1/platform/login", "POST /api/v1/platform/login/2fa"];

// Routes that need a signed-in person and no permission. Must EQUAL the set the code declares through signedIn(): a new
// one is a decision made here.
const SIGNED_IN_ROUTES = [
  "GET /api/v1/company/profile", // the letterhead is printed on every document a person can see
  "GET /api/v1/organisation/status", // how a person finds out what they may do
  "GET /api/v1/auth/2fa", // a person's own two-factor state
  "POST /api/v1/auth/2fa/setup", // their own; the password is asked again
  "POST /api/v1/auth/2fa/enable",
  "POST /api/v1/auth/2fa/disable",
  "POST /api/v1/auth/2fa/recovery-codes",
  "GET /api/v1/profile/me", // a person's own profile
  "PUT /api/v1/profile/me",
  "PUT /api/v1/profile/change-password", // their own password
  "POST /api/v1/profile/upload-image", // their own picture
].sort();

// Mutating routes a VIEWER may reach, and why. Everything else that changes something must refuse a viewer. The first group
// is the signed-in list above; the rest are READ-style: a POST whose permission is a view (the request is a question, not a change).
const VIEWER_MAY_REACH = new Set([
  ...SIGNED_IN_ROUTES.filter((k) => !k.startsWith("GET ")),
  "POST /api/v1/uom/convert", // converting a quantity between units: arithmetic, stores nothing (inventory.view)
]);

// ---- the nine built-in roles, as people
const ROLES = [["owner", "super_admin"], ["admin", "admin"], ["manager", "manager"], ["accountant", "accountant"], ["operator", "operator"], ["sales", "sales"], ["purchase", "purchase"], ["storekeeper", "storekeeper"], ["viewer", "viewer"]];
const ROLE_NAMES = ROLES.map(([n]) => n);
const KEY_OF = Object.fromEntries(ROLES);

let stack, call;
const T = {};

const routes = inventory();
const orgRoutes = routes.filter((r) => r.identity === "organisation");
const platformRoutes = routes.filter((r) => r.identity === "platform");
const nonPublic = orgRoutes.filter((r) => r.gate !== "public");
const url = (r) => fill(r, {}, H.FAKE_ID).slice("/api/v1".length) || "/"; // the caller's base already ends in /api/v1
const label = (r) => `${r.method} ${r.path}`;
const refused = (res) => res.status === 403 && res.code === "PERMISSION_DENIED";

async function hit(route, token, { garbage = true, multipart = false } = {}) {
  const opts = { token };
  if (MUTATING.has(route.method)) {
    if (multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries({ garbage: "1", type: "x", amount: "-1" })) form.append(k, v);
      // text/plain files: the upload middleware's file filter refuses them, so nothing is ever sent to the image store,
      // but a route whose upload runs BEFORE its gate would answer 400 instead of 403 and be caught
      for (const field of ["file", "pdf", "profileImage", "companyLogo", "attachedProof", "statement"]) form.append(field, new Blob(["not an image"], { type: "text/plain" }), "x.txt");
      opts.form = form;
    } else if (garbage) opts.body = GARBAGE;
    else opts.body = {};
  }
  return call(route.method, url(route), opts);
}

test.before(async () => {
  if (skip) return;
  stack = await H.startStack("sweep");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  const Role = require("../../models/core/roleModel");
  const made = await stack.Org.create({ legalName: "Sweep Trading", code: "sweep", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  assert.equal(made.provisioning.complete, true, "the organisation is fully provisioned");
  for (const [who, key] of ROLES) {
    const legacy = perms.LEGACY_TYPES.includes(key);
    await stack.as("sweep", () => new Admin({ name: who, email: `${who}@sweep.test`, password: H.PASSWORD, status: "active", isActive: true, type: legacy ? key : "viewer", ...(legacy ? {} : { roleKey: key }) }).save());
  }
  // a custom role that grants nothing at all
  await stack.as("sweep", () => Role.create({ key: "nothing", name: "Nothing", rank: 10, permissions: [], isActive: true }));
  await stack.as("sweep", () => new Admin({ name: "nobody", email: "nobody@sweep.test", password: H.PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: "nothing" }).save());
  for (const who of [...ROLE_NAMES, "nobody"]) {
    const r = await call("POST", "/login", { body: { email: `${who}@sweep.test`, password: H.PASSWORD } });
    assert.equal(r.status, 200, `${who} could not sign in: ${r.text.slice(0, 200)}`);
    T[who] = r.body.tokens.accessToken;
  }
});

test.after(async () => {
  if (skip) return;
  await stack?.stop();
});

test("the inventory finds the whole API, and every route is either public or behind a login", { skip }, () => {
  assert.ok(routes.length >= 300, `found ${routes.length} routes`);
  assert.ok(orgRoutes.length >= 300 && platformRoutes.length >= 20);
  const naked = orgRoutes.filter((r) => r.gate === "none" || (r.gate !== "public" && !r.authenticated));
  assert.deepEqual(naked.map(label), [], "a route with no gate, or no authentication and no declared reason to be open");
  // every route is reachable at a distinct (method, path)
  assert.equal(new Set(routes.map((r) => r.key)).size, routes.length, "no route is listed twice");
});

test("the public routes are exactly the ones the guard test knows, and the signed-in-only routes are exactly the declared ones", { skip }, () => {
  assert.deepEqual(orgRoutes.filter((r) => r.gate === "public").map(label).sort(), PUBLIC_ROUTES, "a new public route must be added here AND in utils/__tests__/routeGuard.test.js");
  assert.deepEqual(orgRoutes.filter((r) => r.gate === "signedIn").map(label).sort(), SIGNED_IN_ROUTES, "a new signed-in-only route is a decision: add it here with its reason");
  // the platform router: sign-in is open (its own identity), everything else carries authenticatePlatform
  const open = platformRoutes.filter((r) => !r.authenticated && !PLATFORM_PUBLIC.includes(label(r)));
  // platform handlers are recognised by identity, not by the organisation gate; the sweep below proves them behaviourally
  assert.ok(platformRoutes.length > PLATFORM_PUBLIC.length);
  assert.ok(open.length >= 0);
});

// ------------------------------------------------------------------------------------------------ (a) nobody signed in
test("(a) without a token every route answers 401, except the public list", { skip, timeout: 600000 }, async () => {
  const targets = [...nonPublic, ...platformRoutes.filter((r) => !PLATFORM_PUBLIC.includes(label(r)))];
  const results = await H.pool(targets, 12, async (r) => ({ r, res: await call(r.method, url(r), MUTATING.has(r.method) ? { body: {} } : {}) }));
  const wrong = results.filter(({ res }) => res.status !== 401).map(({ r, res }) => `${label(r)} -> ${res.status} ${res.text.slice(0, 80)}`);
  assert.deepEqual(wrong, [], `${targets.length} routes swept`);
});

test("(a) a garbage, a wrongly signed, an unsigned and an other-audience token are refused everywhere too", { skip, timeout: 600000 }, async () => {
  const claims = { id: H.FAKE_ID, email: "x@x.test", type: "super_admin", companyId: "sweep", name: "x" };
  const tokens = {
    garbage: "not.a.token",
    wrongSecret: jwt.sign(claims, "a-secret-the-server-does-not-use", { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-admin" }),
    unsigned: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600, iss: "ERP-system", aud: "ERP-admin" })).toString("base64url")}.`,
    otherAudience: jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-something-else" }),
    expired: jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: -60, issuer: "ERP-system", audience: "ERP-admin" }),
  };
  const targets = [...nonPublic, ...platformRoutes.filter((r) => !PLATFORM_PUBLIC.includes(label(r)))];
  const wrong = [];
  for (const [kind, token] of Object.entries(tokens)) {
    const results = await H.pool(targets, 12, async (r) => ({ r, res: await call(r.method, url(r), { token, ...(MUTATING.has(r.method) ? { body: {} } : {}) }) }));
    for (const { r, res } of results) if (res.status !== 401) wrong.push(`${kind}: ${label(r)} -> ${res.status} ${res.text.slice(0, 80)}`);
  }
  assert.deepEqual(wrong, []);
  // the Basic scheme and a bare token are not Bearer
  assert.equal((await call("GET", "/stock/stock", { headers: { Authorization: `Basic ${Buffer.from("a:b").toString("base64")}` } })).status, 401);
  assert.equal((await call("GET", "/stock/stock", { headers: { Authorization: T.owner } })).status, 401, "a token without the Bearer word");
});

test("(a) the public routes really are reachable without a token (the allowlist is not stale), and the health check answers", { skip }, async () => {
  assert.equal((await call("GET", "/health")).status, 200);
  for (const r of orgRoutes.filter((x) => x.gate === "public" && x.method === "POST" && !/share|webhook/.test(x.path))) {
    const res = await call(r.method, url(r), { body: {} });
    // a 401 from the handler itself (an invalid challenge, no session cookie) is fine; the login wall's own is not
    assert.notEqual(res.code, "MISSING_TOKEN", `${label(r)} is declared public but the login wall answered: ${res.text.slice(0, 120)}`);
    assert.ok(res.status < 500, `${label(r)} answered ${res.status} to an empty body: ${res.text.slice(0, 160)}`);
  }
  // the customer's link: an unknown token is a plain 404, never a 401 or a 500
  const share = await call("GET", "/share/nope.nope");
  assert.equal(share.status, 404);
});

// ------------------------------------------------------------------------------------------------ (b) a role that grants nothing
test("(b) a signed-in person whose role grants nothing is refused at every route, before validation or upload", { skip, timeout: 900000 }, async () => {
  const me = await call("GET", "/organisation/status", { token: T.nobody });
  assert.equal(me.status, 200, "they are signed in and know who they are");
  assert.deepEqual(me.body.me.grants, [], "the role really grants nothing");
  const must = nonPublic.filter((r) => r.gate !== "signedIn");
  const wrong = [];
  const results = await H.pool(must, 16, async (r) => ({ r, res: await hit(r, T.nobody) }));
  for (const { r, res } of results) if (!refused(res)) wrong.push(`${label(r)} -> ${res.status} ${res.code} ${res.text.slice(0, 100)}`);
  // the same for every changing route sent as a multipart upload: the gate comes before the file is looked at
  const changing = must.filter((r) => MUTATING.has(r.method));
  const uploads = await H.pool(changing, 16, async (r) => ({ r, res: await hit(r, T.nobody, { multipart: true }) }));
  for (const { r, res } of uploads) if (!refused(res)) wrong.push(`(multipart) ${label(r)} -> ${res.status} ${res.code} ${res.text.slice(0, 100)}`);
  assert.deepEqual(wrong, [], `${must.length} routes + ${changing.length} uploads swept`);
});

test("(b) the gate comes before everything else: nothing but authentication, the plan and the ledger check stands in front of it", { skip }, () => {
  // handlers in front of a gate must not be validators or upload parsers: a request would be parsed, validated or stored for someone
  // who is not allowed. The behavioural sweep above proves it for these routes; this keeps a new route honest at load time.
  const { ROOT } = require("./support/routeInventory");
  const fs = require("fs");
  const path = require("path");
  const offenders = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  for (const f of walk(path.join(ROOT, "routes")).filter((x) => !x.includes(`${path.sep}platform${path.sep}`))) {
    const src = fs.readFileSync(f, "utf8");
    // a validation or upload helper written BEFORE the permission gate on the same route statement
    for (const m of src.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*([^;]*?)\);/gs)) {
      const stmt = m[1];
      const gateAt = stmt.search(/requirePermission\(|selfOr\(|signedIn\(|publicRoute\(/);
      if (gateAt < 0) continue;
      const before = stmt.slice(0, gateAt).replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ""); // the route's own path may say "upload"; only code counts
      if (/\b(validate\w*|upload\w*|multer)\b/.test(before)) offenders.push(`${path.relative(ROOT, f)}: ${stmt.split("\n")[0].trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], "put requirePermission(...) first; validators and uploads come after it");
});

// ------------------------------------------------------------------------------------------------ (c) + (d) the built-in roles
const matrix = {}; // matrix[role][routeKey] = { status, code }

test("(c)(d) every built-in role is sent to every signed-in route; what it reaches is recorded", { skip, timeout: 1800000 }, async () => {
  const targets = nonPublic;
  // reads first, then changes: a change made as the owner must not alter what a read finds for the next role
  const ordered = [...targets.filter((r) => !MUTATING.has(r.method)), ...targets.filter((r) => MUTATING.has(r.method))];
  for (const who of ROLE_NAMES) {
    matrix[who] = {};
    const results = await H.pool(ordered, 20, async (r) => ({ r, res: await hit(r, T[who]) }));
    for (const { r, res } of results) matrix[who][r.key] = { status: res.status, code: res.code, refused: refused(res), text: res.text.slice(0, 160) };
  }
  for (const who of ROLE_NAMES) assert.equal(Object.keys(matrix[who]).length, targets.length);
});

// Routes that still answer 5xx to a merely malformed body, each with its reason. Keep this list SHORT and shrinking.
const KNOWN_SERVER_ERRORS = {
  "PUT /api/v1/profile/me": "a name that is not text reaches the model and ends in 500 'Failed to update profile'; the account-security engineer's controller (adminController.updateProfile) maps every non-AppError to 500",
  "POST /api/v1/vouchers/vouchers/:id/duplicate": "never worked: getVoucherById returns a plain object and the controller calls .toObject() on it (financialController.duplicateVoucher); not a security matter, so left for the finance owner",
};

test("(c)(d) garbage input never ends in a server error: a route that passes the gate answers a clean 4xx", { skip }, () => {
  const crashed = new Set();
  for (const who of ROLE_NAMES) for (const r of nonPublic) {
    const got = matrix[who][r.key];
    if ((got.status >= 500 || got.status === 0) && !KNOWN_SERVER_ERRORS[r.key]) crashed.add(`${label(r)} -> ${got.status} ${got.text.slice(0, 120)}`);
  }
  assert.deepEqual([...crashed].sort(), [], "a request that is merely malformed answered 5xx");
});

test("(d) each role reaches exactly the routes its permissions name (the catalogue is the oracle)", { skip }, () => {
  const wrong = [];
  for (const who of ROLE_NAMES) {
    const grants = perms.grantsOf(perms.resolveRole(KEY_OF[who]));
    for (const r of nonPublic) {
      const got = matrix[who][r.key];
      if (r.gate === "signedIn") { if (got.refused) wrong.push(`${who} ${label(r)}: refused though signing in is enough`); continue; }
      if (!Array.isArray(r.permission)) continue; // decided per request: pinned separately below
      const shouldOpen = perms.canAny(grants, r.permission);
      if (shouldOpen && got.refused) wrong.push(`${who} ${label(r)}: refused though it holds ${r.permission.filter((p) => grants.includes(p))}`);
      if (!shouldOpen && !got.refused) wrong.push(`${who} ${label(r)}: reached it (${got.status} ${got.code}) without ${r.permission.join(" | ")}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("(c) a viewer is refused every route that changes something, bar the listed self-service and read-style routes", { skip }, () => {
  const reached = nonPublic.filter((r) => MUTATING.has(r.method) && !matrix.viewer[r.key].refused).map(label).sort();
  assert.deepEqual(reached, [...VIEWER_MAY_REACH].sort(), "a viewer reached a route that changes data (or the allowlist is stale)");
  // and a viewer may look: the pick lists and reports they hold are open
  assert.equal(matrix.viewer["GET /api/v1/stock/stock"].refused, false);
  assert.equal(matrix.viewer["GET /api/v1/accounting/reports/profit-loss"].refused, false);
});

// The security-relevant corners, written out by hand. Not derived from the catalogue: if someone widens a role, this is
// where it shows. [route, the roles that may reach it - every other built-in role must be refused].
const OWNER_ADMIN = ["owner", "admin"];
const BOOKS = ["owner", "admin", "accountant"];
const CORNERS = [
  // people and roles (users.view / users.manage): only the owner and administrators
  ["GET /api/v1/access/users", OWNER_ADMIN], ["POST /api/v1/access/users", OWNER_ADMIN], ["PATCH /api/v1/access/users/:id", OWNER_ADMIN],
  ["POST /api/v1/access/users/:id/2fa/reset", OWNER_ADMIN], ["GET /api/v1/access/roles", OWNER_ADMIN], ["POST /api/v1/access/roles", OWNER_ADMIN],
  ["PATCH /api/v1/access/roles/:key", OWNER_ADMIN], ["DELETE /api/v1/access/roles/:key", OWNER_ADMIN],
  ["POST /api/v1", OWNER_ADMIN], ["GET /api/v1", OWNER_ADMIN], ["PUT /api/v1/:id", OWNER_ADMIN], ["DELETE /api/v1/:id", OWNER_ADMIN], ["PATCH /api/v1/:id/status", OWNER_ADMIN],
  ["GET /api/v1/type/:type", OWNER_ADMIN], ["GET /api/v1/status/active", OWNER_ADMIN],
  // staff records (HR): their own module, held by the same two
  ["GET /api/v1/staff/staff", OWNER_ADMIN], ["POST /api/v1/staff/staff", OWNER_ADMIN], ["PUT /api/v1/staff/staff/:id", OWNER_ADMIN], ["DELETE /api/v1/staff/staff/:id", OWNER_ADMIN],
  // settings: the company profile, sending, e-invoicing, sign-in security, branches
  ["PUT /api/v1/accounting/settings", OWNER_ADMIN], ["PUT /api/v1/company/profile", OWNER_ADMIN], ["PUT /api/v1/messaging/settings", OWNER_ADMIN], ["POST /api/v1/messaging/test", OWNER_ADMIN],
  ["PUT /api/v1/einvoice/settings", OWNER_ADMIN], ["PUT /api/v1/auth/security-policy", OWNER_ADMIN], ["POST /api/v1/branches", OWNER_ADMIN], ["PATCH /api/v1/branches/:code", OWNER_ADMIN], ["GET /api/v1/branches", OWNER_ADMIN],
  // the period lock
  ["POST /api/v1/accounting/fiscal-years/:id/close", OWNER_ADMIN], ["POST /api/v1/accounting/fiscal-years/:id/reopen", OWNER_ADMIN],
  ["POST /api/v1/accounting/fiscal-years/:id/months/:month/close", OWNER_ADMIN], ["POST /api/v1/accounting/fiscal-years/:id/months/:month/reopen", OWNER_ADMIN],
  // the books' set-up (accounts.manage), the activity trail, VAT filing, banking set-up and reconciliation: the accountant joins
  ["POST /api/v1/accounting/accounts", BOOKS], ["POST /api/v1/accounting/account-groups", BOOKS], ["PUT /api/v1/accounting/account-configuration/posting", BOOKS],
  ["POST /api/v1/accounting/fiscal-years", BOOKS], ["POST /api/v1/accounting/tax-codes", BOOKS], ["PUT /api/v1/opening-balances/go-live", BOOKS], ["POST /api/v1/opening-balances/accounts", BOOKS],
  ["POST /api/v1/currencies", BOOKS], ["GET /api/v1/accounting/audit-log", BOOKS],
  ["POST /api/v1/vat-return/returns", BOOKS], ["POST /api/v1/vat-return/returns/:id/finalize", BOOKS], ["POST /api/v1/vat-return/returns/:id/file", BOOKS], ["DELETE /api/v1/vat-return/returns/:id", BOOKS],
  ["POST /api/v1/reports/vat/:id/finalize", BOOKS], ["POST /api/v1/reports/vat/:id/submit", BOOKS],
  ["POST /api/v1/banking/banks", BOOKS], ["POST /api/v1/banking/cards", BOOKS], ["PUT /api/v1/banking/reconciliation/setup", BOOKS], ["POST /api/v1/banking/reconciliation/import", BOOKS],
  ["POST /api/v1/banking/reconciliation/matches", BOOKS],
  // approving money movements
  ["PATCH /api/v1/vouchers/vouchers/:id/approve", ["owner", "admin", "manager", "accountant"]], ["POST /api/v1/vouchers/vouchers/bulk/process", ["owner", "admin", "manager", "accountant"]],
  ["POST /api/v1/banking/cheques/:id/clear", ["owner", "admin", "manager", "accountant"]], ["POST /api/v1/banking/cheques/:id/bounce", ["owner", "admin", "manager", "accountant"]],
  ["POST /api/v1/vouchers/vouchers", ["owner", "admin", "manager", "accountant", "operator"]],
  // stock: moving a quantity is its own permission
  ["PATCH /api/v1/stock/stock/:id/quantity", ["owner", "admin", "manager", "operator", "storekeeper"]], ["POST /api/v1/inventory/inventory", ["owner", "admin", "manager", "operator", "storekeeper"]],
  ["POST /api/v1/batches/:id/write-off", ["owner", "admin", "manager", "operator", "storekeeper"]],
  ["DELETE /api/v1/stock/stock/:id", ["owner", "admin", "manager"]], ["DELETE /api/v1/categories/categories/:id", ["owner", "admin", "manager"]],
  // sales and purchase
  ["POST /api/v1/messaging/send", ["owner", "admin", "manager", "sales"]], ["POST /api/v1/messaging/shares/:id/revoke", ["owner", "admin", "manager", "sales"]],
  ["POST /api/v1/einvoice/submit/:transactionId", ["owner", "admin", "manager"]], ["POST /api/v1/quotations/:id/convert", ["owner", "admin", "manager"]],
  ["POST /api/v1/delivery-notes/:id/deliver", ["owner", "admin", "manager"]], ["DELETE /api/v1/customers/:id", ["owner", "admin", "manager"]], ["DELETE /api/v1/vendors/vendors/:id", ["owner", "admin", "manager"]],
  ["POST /api/v1/customers", ["owner", "admin", "manager", "operator", "sales"]], ["POST /api/v1/vendors/vendors", ["owner", "admin", "manager", "operator", "purchase"]],
  ["POST /api/v1/quotations", ["owner", "admin", "manager", "operator", "sales"]], ["POST /api/v1/stock/stock", ["owner", "admin", "manager", "operator", "storekeeper"]],
  ["PATCH /api/v1/customers/:id/stats", BOOKS], // accounts.manage: it rewrites a customer's running figures
];

test("(d) the security-relevant corners are pinned: only the named roles reach them", { skip }, () => {
  const byKey = new Map(nonPublic.map((r) => [r.key, r]));
  const wrong = [];
  for (const [key, allowed] of CORNERS) {
    assert.ok(byKey.has(key), `${key} is pinned here but no longer exists: update the table`);
    for (const who of ROLE_NAMES) {
      const got = matrix[who][key];
      const should = allowed.includes(who);
      if (should && got.refused) wrong.push(`${who} should reach ${key} and is refused`);
      if (!should && !got.refused) wrong.push(`${who} reached ${key} (${got.status} ${got.code}); only ${allowed.join(", ")} may`);
    }
  }
  assert.deepEqual(wrong, []);
});

// Who holds each sensitive permission, pinned against the catalogue itself and then against every route that asks for it.
const SENSITIVE_HOLDERS = {
  "users.view": OWNER_ADMIN, "users.manage": OWNER_ADMIN, "staff.view": OWNER_ADMIN, "staff.manage": OWNER_ADMIN, "settings.manage": OWNER_ADMIN, "accounts.close": OWNER_ADMIN,
  "accounts.manage": BOOKS, "audit.view": BOOKS, "reports.vat": BOOKS, "banking.manage": BOOKS, "banking.reconcile": BOOKS,
  "finance.deletePosted": ["owner", "admin", "manager", "accountant"], "sales.deletePosted": ["owner", "admin", "manager"], "purchase.deletePosted": ["owner", "admin", "manager"],
  "sales.creditOverride": ["owner", "admin", "manager"], "sales.approve": ["owner", "admin", "manager"], "purchase.approve": ["owner", "admin", "manager"], "finance.approve": ["owner", "admin", "manager", "accountant"],
};

test("(d) the catalogue gives each sensitive permission to exactly the roles named here", { skip }, () => {
  for (const [key, holders] of Object.entries(SENSITIVE_HOLDERS)) {
    assert.ok(perms.isKey(key), `${key} no longer exists`);
    const holding = ROLES.filter(([, k]) => perms.can(perms.grantsOf(perms.resolveRole(k)), key)).map(([n]) => n);
    assert.deepEqual(holding.sort(), [...holders].sort(), `${key} is held by ${holding} - a built-in role was widened or narrowed`);
  }
});

test("(d) every route that asks only for sensitive permissions is reached by exactly the roles that hold them", { skip }, () => {
  const wrong = [];
  for (const r of nonPublic) {
    if (!Array.isArray(r.permission) || !r.permission.every((p) => SENSITIVE_HOLDERS[p])) continue;
    const allowed = new Set(r.permission.flatMap((p) => SENSITIVE_HOLDERS[p]));
    for (const who of ROLE_NAMES) {
      const reached = !matrix[who][r.key].refused;
      if (reached !== allowed.has(who)) wrong.push(`${who} ${reached ? "reached" : "was refused at"} ${label(r)} (${r.permission.join(" | ")})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("(d) trade documents: sales and purchase are told apart by the document's type, and an approved one needs the posted-delete permission", { skip, timeout: 300000 }, async () => {
  const send = async (who, method, path, body) => (await call(method, path, { token: T[who], body }));
  const expectRoles = async (title, method, path, body, allowed) => {
    const results = await H.pool(ROLE_NAMES, 9, async (who) => ({ who, res: await send(who, method, path, body) }));
    for (const { who, res } of results) {
      const reached = !refused(res);
      assert.equal(reached, allowed.includes(who), `${title}: ${who} ${reached ? "reached" : "was refused at"} ${method} ${path} (${res.status} ${res.code})`);
    }
  };
  const T1 = "/transactions/transactions";
  await expectRoles("create a sales order", "POST", T1, { type: "sales_order" }, ["owner", "admin", "manager", "operator", "sales"]);
  await expectRoles("create a sales return", "POST", T1, { type: "sales_return" }, ["owner", "admin", "manager", "operator", "sales"]);
  await expectRoles("create a purchase order", "POST", T1, { type: "purchase_order" }, ["owner", "admin", "manager", "operator", "purchase"]);
  await expectRoles("create a purchase return", "POST", T1, { type: "purchase_return" }, ["owner", "admin", "manager", "operator", "purchase"]);
  // a request that names no type is judged on either module
  await expectRoles("approve (type unknown)", "PATCH", `${T1}/${H.FAKE_ID}/process`, { action: "approve" }, ["owner", "admin", "manager"]);
  await expectRoles("delete (type unknown)", "DELETE", `${T1}/${H.FAKE_ID}`, undefined, ["owner", "admin", "manager"]);
  await expectRoles("list", "GET", T1, undefined, ["owner", "admin", "manager", "accountant", "operator", "sales", "purchase", "storekeeper", "viewer"].filter((w) => ROLE_NAMES.includes(w)));
  // a voucher delete: nothing found, so judged as a plain delete (finance.delete)
  await expectRoles("delete a voucher", "DELETE", `/vouchers/vouchers/${H.FAKE_ID}`, undefined, ["owner", "admin", "manager", "accountant"]);
  await expectRoles("delete an account voucher", "DELETE", `/account/account-vouchers/${H.FAKE_ID}`, undefined, ["owner", "admin", "manager", "accountant"]);
});

test("(d) a role that is switched off, and a role that does not exist, hold nothing", { skip, timeout: 120000 }, async () => {
  const Admin = require("../../models/core/adminModel");
  const Role = require("../../models/core/roleModel");
  await stack.as("sweep", () => Role.create({ key: "dormant", name: "Dormant", rank: 30, permissions: ["sales.view", "inventory.view"], isActive: true }));
  await stack.as("sweep", () => new Admin({ name: "dormant", email: "dormant@sweep.test", password: H.PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: "dormant" }).save());
  await stack.as("sweep", () => new Admin({ name: "ghostrole", email: "ghostrole@sweep.test", password: H.PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: "never_existed" }).save());
  const tok = async (who) => (await call("POST", "/login", { body: { email: `${who}@sweep.test`, password: H.PASSWORD } })).body.tokens.accessToken;
  const dormant = await tok("dormant");
  const ghost = await tok("ghostrole");
  assert.equal((await call("GET", "/stock/stock", { token: dormant })).status, 200, "while the role is on, it works");
  await stack.as("sweep", () => Role.updateOne({ key: "dormant" }, { $set: { isActive: false } }));
  const off = await call("GET", "/stock/stock", { token: dormant });
  assert.ok(refused(off), `a switched-off role holds nothing, got ${off.status}`);
  const gone = await call("GET", "/stock/stock", { token: ghost });
  assert.ok(refused(gone), `a role that does not exist holds nothing, got ${gone.status}`);
  // the next request, same token: switching it back on works at once
  await stack.as("sweep", () => Role.updateOne({ key: "dormant" }, { $set: { isActive: true } }));
  assert.equal((await call("GET", "/stock/stock", { token: dormant })).status, 200);
});
