// Shared plumbing for the security sweeps (securitySweepHttp, tenantBleedHttp, massAssignmentHttp): start the real
// server as a child process against a throwaway database in STRICT tenant mode, wait until it is ready, make
// organisations and signed-in people, and call it over HTTP. The pattern is the one identityHttp.test.js and
// permissionsHttp.test.js use, written once. Lives in a subfolder, so `npm test` never runs it as a test.
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
const mongoose = require("mongoose");
// The SERVER builds its own indexes when it starts. This process only inserts and reads, so it must not also build ~60 collections' worth
// on a shared cluster (it added about a minute to every run).
mongoose.set("autoIndex", false);

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PASSWORD = "12312312";
const FAKE_ID = "64b64b64b64b64b64b64b64b"; // matches nothing: a gate that lets it through answers 404, one that does not answers 403

const skipReason = () => (!process.env.MONGO_URI ? "MONGO_URI not set" : false);

/**
 * Start the server on a free port against its own database. `label` only goes into the database name.
 * -> { base, db, uri, port, child, logs(), models, services, ctx, stop() }
 */
async function startStack(label = "sec", { probe = false } = {}) {
  const db = `erp_e2e_${Date.now()}_${label}${Math.floor(Math.random() * 1e6)}`;
  const port = 3300 + Math.floor(Math.random() * 600);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${db}?`);
  if (!uri.includes(db)) throw new Error("could not point the server at the throwaway database");
  let logs = "";
  const armFile = path.join(require("os").tmpdir(), `probe-arm-${db}`);
  const child = spawn(process.execPath, [...(probe ? ["--require", path.join(__dirname, "pollutionProbe.js")] : []), "server.js"], {
    cwd: ROOT,
    env: { ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", PROBE_ARM_FILE: armFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  let exited = false;
  child.on("exit", () => { exited = true; });

  await mongoose.connect(uri);
  const ctx = require("../../../utils/tenantContext");
  const stack = {
    base, db, uri, port, child, ctx,
    logs: () => logs,
    // lines the in-process prototype probe printed (only with { probe: true })
    probeLines: () => logs.split(/\r?\n/).filter((l) => l.includes("[pollution-probe]")),
    armProbe: () => require("fs").writeFileSync(armFile, "1"),
    exited: () => exited,
    // runs `fn` as an organisation (and branch), the way a request would
    as: (company, fn, branch = "main") => ctx.runWithTenant({ companyId: company, branchId: branch }, fn),
    // reads across organisations, for a test that checks what is really stored
    raw: (fn) => ctx.runUnscoped("a security test inspecting what is really stored, across organisations", fn),
    stop: async () => {
      try { child.kill(); } catch (_) { /* already gone */ }
      try { require("fs").unlinkSync(armFile); } catch (_) { /* never armed */ }
      if (mongoose.connection.readyState === 1) {
        if (mongoose.connection.name !== db) throw new Error("refusing to drop anything but the throwaway database");
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
    },
  };
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  stack.Org = require("../../core/organisationService");
  return stack;
}

/**
 * One HTTP call. Never throws on a status. A refused connection is retried twice (a busy Atlas or a server that
 * is still warming up); anything else is returned as status 0 with the error text, so a sweep can name the route.
 * `text` is the raw response body, so a leak check scans every byte, not just what parsed.
 */
function makeCaller(base) {
  return async function call(method, url, { body, token, headers = {}, form, raw, timeoutMs = 60000 } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h["Content-Type"] = h["Content-Type"] || "application/json"; payload = JSON.stringify(body); }
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const started = Date.now();
        const res = await fetch(`${base}${url}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
        const type = res.headers.get("content-type") || "";
        const text = type.includes("json") || type.includes("text") ? await res.text() : (await res.arrayBuffer()) && "(binary)";
        let data = null;
        if (type.includes("json")) { try { data = JSON.parse(text); } catch (_) { data = null; } }
        return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, text, headers: res.headers, ms: Date.now() - started };
      } catch (e) {
        last = e;
        if (e.name === "TimeoutError") break; // a slow answer is a finding, not something to retry
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return { status: 0, data: null, body: undefined, code: "NO_RESPONSE", text: String(last?.cause?.message || last?.message || last), headers: new Headers(), ms: timeoutMs };
  };
}

/** Run `items` through `fn` with at most `limit` in flight. Results keep the order of `items`. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { startStack, makeCaller, pool, PASSWORD, FAKE_ID, ROOT, skipReason };
