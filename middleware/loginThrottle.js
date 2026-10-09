// A limit on FAILED sign-ins from one address. Without it a script could try passwords at any speed against every account
// of every organisation (the per-account lock-out only stops it from hammering ONE account).
//
// Only failures count - a wrong password (401) or a locked account (423) - so a company whose staff all share an office
// address, and sign in successfully all morning, is never held up. After `LOGIN_FAILURE_LIMIT` failures (default 20) within
// `LOGIN_FAILURE_WINDOW_MS` (default 15 minutes) the address is refused for the rest of the window with a Retry-After.
//
// IN MEMORY AND PER PROCESS (see middleware/rateLimit.js): a restart clears it and a second server instance halves it. And the
// address is the left-most X-Forwarded-For entry, which a client can set to anything, so a determined attacker can dodge it.
// It stops the impatient script, not the determined one; the lock-out on each account (5 failures, 15 minutes) is the guard
// that does not depend on the address.
const AppError = require("../utils/AppError");
const { clientIp } = require("./rateLimit");

function loginThrottle({ windowMs = Number(process.env.LOGIN_FAILURE_WINDOW_MS) || 15 * 60 * 1000, max = Number(process.env.LOGIN_FAILURE_LIMIT) || 20 } = {}) {
  const buckets = new Map(); // address -> { start, count }
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (now - bucket.start > windowMs) buckets.delete(key);
    const ip = String(clientIp(req));
    const bucket = buckets.get(ip);
    if (bucket && bucket.count >= max) {
      const seconds = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set("Retry-After", String(seconds));
      return next(new AppError(`Too many failed sign-in attempts from this address. Try again in ${Math.ceil(seconds / 60)} minutes.`, 429, "TOO_MANY_ATTEMPTS"));
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

module.exports = { loginThrottle };
