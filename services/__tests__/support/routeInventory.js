// A live INVENTORY of every route the server mounts: method, full path, path parameters and the gate that guards it.
// Test support only (it sits in a subfolder, which `npm test` does not glob, so it is never run as a test).
//
// It is read from the code, never from a list kept by hand, so a route added tomorrow is in the inventory tomorrow:
//   1. server.js is read as TEXT for its `app.use("/api/v1/...", router)` lines (it cannot be required: it listens and
//      connects to the database the moment it loads);
//   2. each router file is required and its stack walked, nested routers included, with the prefix they were mounted at
//      (Router.prototype.use is wrapped to remember the path, because a Layer does not keep it);
//   3. the gate of a route is read from the handlers that apply to it: `permission` is set by requirePermission,
//      `selfService` by signedIn / selfOr, `public` by publicRoute (middleware/permissionGate.js).
//
// The same technique as utils/__tests__/routeGuard.test.js, with the mount prefix added so a request can be built.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");

// ---- remember the path every router.use(path, ...) was given. Must run before any router file is required.
const RouterProto = require("router").prototype;
if (!RouterProto.__mountPathRemembered) {
  const original = RouterProto.use;
  RouterProto.use = function use(...args) {
    const before = this.stack.length;
    const result = original.apply(this, args);
    const mountPath = typeof args[0] === "string" ? args[0] : "/";
    for (let i = before; i < this.stack.length; i++) this.stack[i].mountPath = mountPath;
    return result;
  };
  RouterProto.__mountPathRemembered = true;
}

const { authenticateToken, authenticateTokenAllowingBlocked } = require("../../../middleware/authMiddleware");
const { authenticatePlatform } = require("../../../middleware/platformAuth");

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const join = (...parts) => ("/" + parts.map((p) => String(p || "")).join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

// ---- 1. the mounts, from server.js, in order
function readMounts(file = path.join(ROOT, "server.js")) {
  const src = fs.readFileSync(file, "utf8");
  const vars = {};
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](\.\/routes\/[^"']+)["']\s*\)/g)) vars[m[1]] = m[2];
  const mounts = [];
  const re = /app\.use\(\s*["'`](\/api\/v1[^"'`]*)["'`]\s*,\s*(?:require\(\s*["']([^"']+)["']\s*\)|([A-Za-z_$][\w$]*))\s*\)/g;
  for (const m of src.matchAll(re)) {
    const rel = m[2] || vars[m[3]];
    if (!rel) continue; // not a router file (a function declared inline)
    mounts.push({ prefix: m[1], file: path.join(ROOT, rel) });
  }
  return mounts;
}

// ---- 2. the stack of one router
function routesOf(router, prefix, inherited) {
  const out = [];
  // layers from router.use(): `at` is where they apply (a path-less use applies to everything after it)
  let standing = [...inherited];
  for (const layer of router.stack) {
    if (layer.route) {
      const route = layer.route;
      const methods = route.methods._all ? ALL_METHODS : Object.keys(route.methods).filter((m) => route.methods[m]).map((m) => m.toUpperCase());
      const own = route.stack.map((l) => l.handle);
      const local = route.path;
      const applicable = standing.filter((s) => s.at === "/" || join(local).startsWith(s.at));
      for (const method of methods) out.push({ method, path: join(prefix, local), handlers: [...applicable.map((s) => s.handler), ...own] });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const at = layer.mountPath || "/";
      const applicable = standing.filter((s) => s.at === "/" || join(at).startsWith(s.at));
      out.push(...routesOf(layer.handle, join(prefix, at), [...applicable.map((s) => ({ at: "/", handler: s.handler }))]));
    } else if (layer.handle) {
      standing = [...standing, { at: layer.mountPath || "/", handler: layer.handle }];
    }
  }
  return out;
}

const guardOf = (handlers) => handlers.find((h) => h && (h.permission !== undefined || h.selfService || h.public));

function describe(handlers) {
  const guard = guardOf(handlers);
  const authenticated = handlers.some((h) => h === authenticateToken || h === authenticateTokenAllowingBlocked);
  const platform = handlers.includes(authenticatePlatform);
  let gate = "none";
  let permission;
  let reason;
  if (guard?.public) { gate = "public"; reason = guard.public; }
  else if (guard && guard.permission !== undefined) { gate = "permission"; permission = typeof guard.permission === "function" ? "(decided per request)" : [].concat(guard.permission); reason = guard.selfService; }
  else if (guard?.selfService) { gate = "signedIn"; reason = guard.selfService; }
  return { gate, permission, reason, authenticated, platform };
}

let cached;
/**
 * Every route, in mount order:
 *   { method, path: "/api/v1/vendors/vendors/:id", params: ["id"], file, gate: "permission"|"signedIn"|"public"|"none",
 *     permission: [..]|"(decided per request)", reason, authenticated, identity: "organisation"|"platform", key: "GET /api/v1/..." }
 */
function inventory() {
  if (cached) return cached;
  const out = [];
  for (const mount of readMounts()) {
    const router = require(mount.file);
    if (!router || !Array.isArray(router.stack)) continue;
    for (const r of routesOf(router, mount.prefix, [])) {
      const d = describe(r.handlers);
      out.push({
        method: r.method,
        path: r.path,
        params: [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]),
        file: path.relative(ROOT, mount.file).split(path.sep).join("/"),
        gate: d.gate,
        permission: d.permission,
        reason: d.reason,
        authenticated: d.authenticated,
        identity: d.platform || /\/platform(\/|$)/.test(r.path) ? "platform" : "organisation",
        key: `${r.method} ${r.path}`,
      });
    }
  }
  cached = out;
  return out;
}

/** A concrete URL for a route: each :param replaced with `values[name]` (or `fallback`). Query strings are the caller's. */
function fill(route, values = {}, fallback = "64b64b64b64b64b64b64b64b") {
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => encodeURIComponent(values[name] ?? fallback));
}

module.exports = { inventory, readMounts, fill, ROOT, ALL_METHODS };
