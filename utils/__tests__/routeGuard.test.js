// The safety net under the whole permission system: every route in every router must name what it needs, or say
// plainly why it needs nothing. A new route that does neither fails here, so "we added a router and forgot" cannot
// ship an open door. (Same idea as tenantGuard for models: make guarding the default and unguarded the exception.)
//
// It loads each router and walks its stack, so it needs no server and no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const perms = require("../permissions");

const ROOT = path.resolve(__dirname, "..", "..");
const ROUTES = path.join(ROOT, "routes");

// The developer console is a separate identity with its own token and its own login (middleware/platformAuth.js): it has
// no organisation, no role and no permission to hold. Everything else under /api/v1 belongs to a customer's people.
const OTHER_IDENTITY = new Set(["routes/platform/platformRoutes.js"]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const files = walk(ROUTES).filter((f) => !OTHER_IDENTITY.has(rel(f)));

// every route of a router, nested routers included, with the guards that apply to it
function routesOf(router, inherited = []) {
  const out = [];
  let standing = [...inherited]; // router.use(...) layers seen so far apply to the routes defined after them
  for (const layer of router.stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase());
      for (const method of methods) out.push({ method, path: layer.route.path, handlers: [...standing, ...handlers] });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      out.push(...routesOf(layer.handle, [...standing, layer.handle])); // a nested router: its own routes, plus what came before
    } else if (layer.handle) {
      standing = [...standing, layer.handle];
    }
  }
  return out;
}

const guardOf = (handlers) => handlers.find((h) => h && (h.permission !== undefined || h.selfService || h.public));
const keysOf = (need) => (typeof need === "function" ? [] : [].concat(need));

test("the routers are found, so the test below is not passing on an empty list", () => {
  assert.ok(files.length >= 30, `found ${files.length} router files`);
  let total = 0;
  for (const f of files) total += routesOf(require(f)).length;
  assert.ok(total >= 300, `found ${total} routes`);
});

test("every route names the permission it needs, or says why it needs none", () => {
  const open = [];
  for (const f of files) {
    const router = require(f);
    for (const r of routesOf(router)) {
      const guard = guardOf(r.handlers);
      // a router-level guard (router.use) counts only if it is tagged: authenticateToken and requireFeature are not guards of this kind
      if (!guard) open.push(`${rel(f)}  ${r.method} ${r.path}`);
    }
  }
  assert.deepEqual(open, [], `these routes name no permission and give no reason:\n  ${open.join("\n  ")}`);
});

test("every permission a route names exists in the catalogue", () => {
  const unknown = [];
  for (const f of files) {
    for (const r of routesOf(require(f))) {
      const guard = guardOf(r.handlers);
      if (!guard || guard.permission === undefined) continue;
      for (const k of keysOf(guard.permission)) if (!perms.isKey(k)) unknown.push(`${rel(f)}  ${r.method} ${r.path}  ->  ${k}`);
    }
  }
  assert.deepEqual(unknown, [], "a typo in a permission key would lock everyone out of that route, or (worse) be silently ignored");
});

test("the old role guards are gone: a role is a set of permissions now, and a route may not ask for a type", () => {
  const stale = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const word of ["requireRole(", "requireSuperAdmin", "canChange", "canSend", "canManageUsers"]) if (src.includes(word)) stale.push(`${rel(f)} still uses ${word}`);
  }
  assert.deepEqual(stale, []);
});

test("the routes that need no permission are few, and each says why", () => {
  const exempt = [];
  for (const f of files) {
    for (const r of routesOf(require(f))) {
      const guard = guardOf(r.handlers);
      if (guard && guard.permission === undefined) exempt.push({ where: `${rel(f)}  ${r.method} ${r.path}`, why: guard.public || guard.selfService, public: Boolean(guard.public) });
    }
  }
  for (const e of exempt) assert.ok(String(e.why).length >= 10, `${e.where} needs a real reason`);
  const open = exempt.filter((e) => e.public).map((e) => e.where).sort();
  assert.deepEqual(open, [
    "routes/core/adminRouter.js  POST /login",
    "routes/core/adminRouter.js  POST /logout",
    "routes/core/adminRouter.js  POST /refresh-token",
    "routes/core/authRoutes.js  POST /forgot-password",
    "routes/core/authRoutes.js  POST /login/2fa",
    "routes/core/authRoutes.js  POST /reset-password",
    "routes/einvoice/einvoiceRoutes.js  POST /inbound/webhook",
    "routes/einvoice/einvoiceRoutes.js  POST /inbound/webhook/:org",
    "routes/messaging/shareRoutes.js  GET /:token",
    "routes/messaging/shareRoutes.js  POST /:token/viewed",
  ], "the whole list of routes anyone may call without signing in: adding one is a decision, made here");
  // a person's own profile and the status route (8), and the five routes of a person's own two-factor (routes/core/authRoutes.js:
  // the account is the signed-in one and the password is asked for again); anything more should be a permission
  assert.ok(exempt.length - open.length <= 13, "a person's own profile, the status route and their own two-factor; anything more should be a permission");
});

test("what a person may do to a document is decided by its type, and a stored document by its stored type", async () => {
  const { byDocumentType } = require("../../middleware/permissionGate");
  const need = byDocumentType("approve");
  assert.equal(await need({ params: {}, body: { type: "sales_order" }, query: {} }), "sales.approve");
  assert.equal(await need({ params: {}, body: { type: "purchase_return" }, query: {} }), "purchase.approve");
  assert.equal(await need({ params: {}, body: {}, query: { type: "purchase_order" } }), "purchase.approve");
  assert.deepEqual(await need({ params: {}, body: {}, query: {} }), ["sales.approve", "purchase.approve"], "no type given: either module will do, and the list is narrowed afterwards");
  assert.deepEqual(await need({ params: {}, body: {}, query: { type: ["sales_order", "purchase_order"] } }), ["sales.approve", "purchase.approve"]);
});
