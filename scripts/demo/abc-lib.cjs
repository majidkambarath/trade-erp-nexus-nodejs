// Shared helpers for the ABC TRADE build: an API client that signs in, re-signs-in when the token ages out, and retries the
// failures that are only the network or a write conflict - never a business refusal - plus a deterministic random source and
// a state file, so a stopped run resumes exactly where it was.
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://localhost:3000/api/v1";
const EMAIL = process.env.E;
const PASS = process.env.P;
const STATE_FILE = path.join(__dirname, "abc-state.json");
const LOG_FILE = path.join(__dirname, "abc-build.log");

let token = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) { /* log only */ }
};

async function signIn() {
  const res = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASS }), signal: AbortSignal.timeout(60000) });
  const d = await res.json().catch(() => ({}));
  if (res.status !== 200 || !d.data?.tokens?.accessToken) throw new Error(`sign-in failed: ${res.status} ${d.errorCode || d.message || ""}${d.data?.twoFactorRequired ? " (two-factor is on)" : ""}`);
  token = d.data.tokens.accessToken;
}

/** One API call. Retries network errors, 5xx and 409 WRITE_CONFLICT with backoff; a 401 signs in again once. Never retries a refusal. */
async function api(method, url, body, { quiet = false } = {}) {
  if (!token) await signIn();
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
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
    } catch (e) {
      last = e;
      await sleep(800 * attempt);
    }
  }
  if (!quiet) log("  network gave up:", method, url, last?.message);
  return { status: 0, ok: false, data: null, body: null, code: "NETWORK", message: String(last?.message || last) };
}

// the record out of the usual { data: { thing: {...} } } / { data: {...} } shapes
const rec = (r) => {
  const b = r?.body;
  if (!b || typeof b !== "object") return null;
  if (b._id) return b;
  return Object.values(b).find((v) => v && typeof v === "object" && !Array.isArray(v) && v._id) || null;
};

// deterministic random numbers: the same story every run
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
    get state() { return a; },
    set state(v) { a = v >>> 0; },
  };
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const parse = (s) => new Date(`${s}T00:00:00.000Z`);
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0));

// a valid UAE IBAN (23 characters, ISO 13616 mod-97 check) from a 3-digit bank code and a 16-digit account number
function uaeIban(bank3, acct16) {
  const bban = `${bank3}${acct16}`;
  const num = `${bban}101400`; // "AE00" with the letters as numbers
  let rem = 0;
  for (const ch of num) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, "0");
  return `AE${check}${bban}`;
}

const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null);
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s));

module.exports = { BASE, api, rec, rng, r2, iso, addDays, parse, isWeekday, lastDayOfMonth, uaeIban, loadState, saveState, log, sleep };
