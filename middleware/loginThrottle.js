// A limit on FAILED sign-ins. Without it a script could try passwords at any speed against every account of every
// organisation (the per-account lock-out only stops it from hammering ONE account).
//
// Only failures count - a wrong password (401) or a locked account (423) - so a company whose staff all share an office
// address, and sign in successfully all morning, is never held up. After `LOGIN_FAILURE_LIMIT` failures (default 20) within
// `LOGIN_FAILURE_WINDOW_MS` (default 15 minutes) the address is refused for the rest of the window with a Retry-After.
//
// IN MEMORY AND PER PROCESS (see middleware/rateLimit.js): a restart clears it and a second server instance halves it. The address is
// req.ip, which is the connecting socket unless server.js was told how many proxies of ours stand in front (TRUST_PROXY_HOPS) - never a
// header the client wrote. It is a courtesy against an impatient script; the lock-out on each account (5 failures, 15 minutes, counted
// before the secret is weighed) is the guard that does not depend on the address.
//
// WHEN THE ADDRESS IS NOT THE VISITOR'S (`SHARED_CLIENT_ADDRESS=true`)
// Put something in front that does not forward the visitor's address - the Render static-site rewrite the app uses
// is one, see "Deployment (Render)" in CLAUDE.md - and every request arrives from one egress. An address bucket is then a GLOBAL bucket, and
// twenty failures by anyone would shut the door on every client in the world. The flag says so: the address bucket is switched off
// and the two keys that still mean something take over.
//   - per ACCOUNT, the email that was typed: bounded guessing against one person, beside the database lock-out. The second
//     sign-in step names no email (it carries a challenge), so there it simply does not count - the account lock covers it.
//   - one OVERALL ceiling: the only thing left that can catch credential stuffing, where every try names a different account
//     so neither of the other two ever fires. It is deliberately far above honest traffic - a burst alarm, not a limit - and it
//     CAN be used to deny service to everyone, which is the price of giving up the address.
// Both are off unless the flag is set, so nothing changes for a deployment that still sees its visitors.
const AppError = require("../utils/AppError");
const { clientIp } = require("./rateLimit");

// Whether req.ip is a proxy's rather than the visitor's. Spelt out rather than guessed: no request can tell us, because a
// shared egress looks exactly like one busy office.
function sharedClientAddress(env = process.env) {
  const raw = env.SHARED_CLIENT_ADDRESS;
  if (raw === undefined || String(raw).trim() === "") return false;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`SHARED_CLIENT_ADDRESS must be true or false (got "${raw}")`);
}

// The account a sign-in names, keyed exactly as adminService looks it up (trim + lowercase), so "A@b.com" and "a@b.com "
// cannot each carry their own allowance. Anything that is not a string is nobody: the body is the client's to write.
function accountOf(req) {
  const email = req?.body?.email;
  if (typeof email !== "string") return null;
  const key = email.trim().toLowerCase();
  return key || null;
}

// One fixed window of counters. Stale windows are swept as requests arrive, so nothing needs a timer or unref().
function counters(windowMs) {
  const buckets = new Map();
  return {
    sweep(now) {
      for (const [k, b] of buckets) if (now - b.start > windowMs) buckets.delete(k);
    },
    // Seconds left to wait, or 0 when this key is free (or switched off, or there is no key for this request).
    heldFor(key, max, now) {
      if (!key || !max) return 0;
      const b = buckets.get(key);
      if (!b || b.count < max) return 0;
      return Math.max(1, Math.ceil((b.start + windowMs - now) / 1000));
    },
    add(key, now) {
      if (!key) return;
      const b = buckets.get(key);
      if (!b || now - b.start > windowMs) buckets.set(key, { start: now, count: 1 });
      else b.count += 1;
    },
  };
}

function loginThrottle({
  windowMs = Number(process.env.LOGIN_FAILURE_WINDOW_MS) || 15 * 60 * 1000,
  max = Number(process.env.LOGIN_FAILURE_LIMIT) || 20,
  what = "sign-in attempts",
  shared = sharedClientAddress(),
  accountMax = Number(process.env.LOGIN_ACCOUNT_FAILURE_LIMIT) || 10,
  overallMax = Number(process.env.LOGIN_GLOBAL_FAILURE_LIMIT) || 300,
} = {}) {
  const byAddress = counters(windowMs);
  const byAccount = counters(windowMs);
  const overall = counters(windowMs);

  // What this request is counted under. A switched-off bucket has no key, so it is never read and never written.
  const keysFor = (req) => [
    { store: byAddress, key: shared ? null : String(clientIp(req)), max, where: " from this address" },
    { store: byAccount, key: shared ? accountOf(req) : null, max: accountMax, where: " for this account" },
    { store: overall, key: shared ? "all" : null, max: overallMax, where: "" },
  ];

  return (req, res, next) => {
    const now = Date.now();
    byAddress.sweep(now);
    byAccount.sweep(now);
    overall.sweep(now);

    const keys = keysFor(req);
    for (const { store, key, max: limit, where } of keys) {
      const seconds = store.heldFor(key, limit, now);
      if (!seconds) continue;
      res.set("Retry-After", String(seconds));
      return next(new AppError(`Too many failed ${what}${where}. Try again in ${Math.ceil(seconds / 60)} minutes.`, 429, "TOO_MANY_ATTEMPTS"));
    }

    res.on("finish", () => {
      if (res.statusCode !== 401 && res.statusCode !== 423) return;
      const t = Date.now();
      for (const { store, key } of keys) store.add(key, t);
    });
    return next();
  };
}

// ONE throttle for every way of proving who you are at the door: the password (POST /login) and the code that follows it
// (POST /auth/login/2fa) count failures in the same bucket per address, so a wrong code is a failed sign-in like a wrong password
// and trying both alternately buys no extra attempts. Made on first use, so it reads the environment of the running server.
let sharedDoor;
const sharedLoginThrottle = () => (sharedDoor ||= loginThrottle());

// Renewing a session counts its own failures (a cookie that no longer names a live session): somebody feeding the refresh door cookies
// has no business doing it a hundred times. Failures only, so a whole office renewing at once is never held up. Its own bucket.
// It carries no email, so behind a shared address only the overall ceiling is left to hold it.
let refresh;
const refreshFailureThrottle = () => (refresh ||= loginThrottle({ max: Number(process.env.REFRESH_FAILURE_LIMIT) || 100, what: "session renewals" }));

module.exports = { loginThrottle, sharedLoginThrottle, refreshFailureThrottle, sharedClientAddress };
