// A small fixed-window request limiter. IN MEMORY AND PER PROCESS, so it is a courtesy, not a defence:
// a restart clears it and a second server instance halves it. A real limiter needs a shared store,
// which is not built. What it does buy: a runaway script or an impatient retry loop cannot hammer the
// public document link or the send endpoint unnoticed.
//
// There is no timer: stale windows are swept as new requests arrive, so nothing needs unref().
const AppError = require("../utils/AppError");

// The address the request came from. The server does not trust the proxy, so req.ip is Render's
// own address - every customer would share one bucket. The left-most X-Forwarded-For entry is the
// client as the proxy chain saw it. A client can put anything there, which lets it dodge its own
// limit and nothing worse: the per-link limit does not depend on it.
const clientIp = (req) => {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
};

// A shortened address for storing as evidence: enough to show a view happened, not a tracking record.
const coarseIp = (ip) => {
  const s = String(ip || "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.replace(/\.\d{1,3}$/, ".0");
  if (s.includes(":")) return `${s.split(":").slice(0, 3).join(":")}::`;
  return s;
};

function rateLimit({ windowMs, max, key = clientIp, code = "RATE_LIMITED", message = "Too many requests. Try again in a little while." }) {
  const buckets = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.start > windowMs) buckets.delete(k);
    const k = String(key(req));
    const b = buckets.get(k);
    if (!b) {
      buckets.set(k, { start: now, count: 1 });
      return next();
    }
    b.count += 1;
    if (b.count > max) return next(new AppError(message, 429, code));
    return next();
  };
}

module.exports = { rateLimit, clientIp, coarseIp };
