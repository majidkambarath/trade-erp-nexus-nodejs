// Shared helpers for the trading demo seeder: an API client per signed-in person (the second-approver
// story needs Fatima to approve AS Fatima), a seeded random source, and day arithmetic.
// Every document goes through the product's own HTTP API, so what is written is exactly what a person
// clicking through the screens would have written, and every rule (period lock, credit control,
// approvals) still applies.
const BASE = process.env.BASE || "http://localhost:3000/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00.000Z`);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
// Friday is the UAE's short day but the banks work it; Saturday and Sunday are the weekend here.
const nextWeekday = (d) => { let x = d; while (!isWeekday(x)) x = addDays(x, 1); return x; };

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

// One signed-in person. Retries a network blip, a 5xx and a write conflict, never a business refusal.
function client(email, password) {
  let token = null;
  async function signIn() {
    const res = await fetch(`${BASE}/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(60000),
    });
    const d = await res.json().catch(() => ({}));
    const t = d.data?.tokens?.accessToken;
    if (res.status !== 200 || !t) {
      throw new Error(`sign-in as ${email} failed: ${res.status} ${d.errorCode || d.message || ""}${d.data?.twoFactorRequired ? " (two-factor is on)" : ""}`);
    }
    token = t;
  }
  async function api(method, url, body) {
    if (!token) await signIn();
    let last;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const res = await fetch(`${BASE}${url}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(120000),
        });
        const text = await res.text();
        let data = null; try { data = JSON.parse(text); } catch (_) { /* not json */ }
        if (res.status === 401 && attempt < 5) { await signIn(); continue; }
        const transient = res.status >= 500 || (res.status === 409 && data?.errorCode === "WRITE_CONFLICT");
        if (transient && attempt < 5) { await sleep(400 * attempt); continue; }
        return { status: res.status, ok: res.status < 300, data, body: data?.data, code: data?.errorCode, message: data?.message || text.slice(0, 200) };
      } catch (e) { last = e; await sleep(800 * attempt); }
    }
    return { status: 0, ok: false, data: null, body: null, code: "NETWORK", message: String(last?.message || last) };
  }
  return { api, email };
}

// The record out of the usual { data: { thing: {...} } } / { data: {...} } shapes.
const rec = (r) => {
  const b = r?.body;
  if (!b || typeof b !== "object") return null;
  if (b._id) return b;
  return Object.values(b).find((v) => v && typeof v === "object" && !Array.isArray(v) && v._id) || null;
};
const listOf = (r) => {
  const b = r?.body;
  if (Array.isArray(b)) return b;
  if (!b || typeof b !== "object") return [];
  for (const k of ["rows", "items", "data"]) if (Array.isArray(b[k])) return b[k];
  const arr = Object.values(b).find(Array.isArray);
  return arr || [];
};
// A refusal is never swallowed: the seeder stops with the server's own words.
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.status} ${r.code || ""} ${r.message}`);
  return r;
};

// Run fn over items with at most `n` in flight. Each approval costs seconds against a remote database,
// so a year of documents one at a time takes hours; a few at once is the difference. Writes that touch the
// same record conflict and the API retries them, so keep n small.
async function pmap(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

module.exports = { pmap, BASE, sleep, r2, iso, parse, addDays, isWeekday, nextWeekday, rng, client, rec, listOf, must };
