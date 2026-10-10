// A limit on FAILED sign-ins from one address. Without it a script could try passwords at any speed against every account
// of every organisation (the per-account lock-out only stops it from hammering ONE account).
//
// Only failures count - a wrong password (401) or a locked account (423) - so a company whose staff all share an office
// address, and sign in successfully all morning, is never held up. After `LOGIN_FAILURE_LIMIT` failures (default 20) within
// `LOGIN_FAILURE_WINDOW_MS` (default 15 minutes) the address is refused for the rest of the window with a Retry-After.
//
// IN MEMORY AND PER PROCESS (see middleware/rateLimit.js): a restart clears it and a second server instance halves it. The address is
// req.ip, which is the connecting socket unless server.js was told how many proxies of ours stand in front (TRUST_PROXY_HOPS) - never a
// header the client wrote. It is a courtesy against an impatient script; the lock-out on each account (5 failures, 15 minutes, counted
// before the secret is weighed) is the guard that does not depend on the address.
const AppError = require("../utils/AppError");
const { clientIp } = require("./rateLimit");

function loginThrottle({ windowMs = Number(process.env.LOGIN_FAILURE_WINDOW_MS) || 15 * 60 * 1000, max = Number(process.env.LOGIN_FAILURE_LIMIT) || 20, what = "sign-in attempts" } = {}) {
  const buckets = new Map(); // address -> { start, count }
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (now - bucket.start > windowMs) buckets.delete(key);
    const ip = String(clientIp(req));
    const bucket = buckets.get(ip);
    if (bucket && bucket.count >= max) {
      const seconds = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set("Retry-After", String(seconds));
      return next(new AppError(`Too many failed ${what} from this address. Try again in ${Math.ceil(seconds / 60)} minutes.`, 429, "TOO_MANY_ATTEMPTS"));
    }
    res.on("finish", () => {
      if (res.statusCode !== 401 && res.statusCode !== 423) return;
      const t = Date.now();
      const current = buckets.get(ip);
      if (!current || t - current.start > windowMs) buckets.set(ip, { start: t, count: 1 });
      else current.count += 1;
    });
    return next();
  };
}

// ONE throttle for every way of proving who you are at the door: the password (POST /login) and the code that follows it
// (POST /auth/login/2fa) count failures in the same bucket per address, so a wrong code is a failed sign-in like a wrong password
// and trying both alternately buys no extra attempts. Made on first use, so it reads the environment of the running server.
let shared;
const sharedLoginThrottle = () => (shared ||= loginThrottle());

// Renewing a session counts its own failures (a cookie that no longer names a live session): somebody feeding the refresh door cookies
// has no business doing it a hundred times. Failures only, so a whole office renewing at once is never held up. Its own bucket.
let refresh;
const refreshFailureThrottle = () => (refresh ||= loginThrottle({ max: Number(process.env.REFRESH_FAILURE_LIMIT) || 100, what: "session renewals" }));

module.exports = { loginThrottle, sharedLoginThrottle, refreshFailureThrottle };
