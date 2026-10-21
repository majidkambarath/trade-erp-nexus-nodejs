// The address the VISITOR came from, when Cloudflare stands in front of us.
//
// Express works `req.ip` out of the socket and the number of proxies we told it to trust
// (utils/trustProxy.js, server.js). Counting hops in from the right only lands on the visitor if the number
// is EXACTLY the number of proxies that really append to X-Forwarded-For. On Render it is not: measured
// against the live service on 21 Oct 2026, GET /api/v1/health answered a CLOUDFLARE address every time
// (172.71.*, 162.158.*, 104.23.*), never the caller's, and a different one on each request. So:
//   - every per-address limit (failed sign-ins, failed refreshes, forgot/reset password, platform sign-ins,
//     the public document link) shared one rotating allowance, which is the same as having no limit;
//   - every stored address - AuthSession.ip, ActivityLog.ip, PasswordReset.requestedFrom,
//     ShareLink.views[].ip - recorded Cloudflare instead of the visitor.
// The per-ACCOUNT lock-out never depended on the address and was unaffected; it is the real brute-force guard.
//
// Counting one hop further would be right today and spoofable the day Render adds or drops an internal hop,
// because once the count passes the number of proxies that really append, the LEFT-most entry - the one the
// client wrote - wins. That is why the hop count is not the lever here and utils/trustProxy.js is unchanged:
// 2 is wrong on the safe side (too coarse, provably not forgeable - a forged X-Forwarded-For does not move
// it), and it stays as the fallback for a request that arrives without Cloudflare's header.
//
// CF-Connecting-IP does not depend on the count. Cloudflare writes it itself and REFUSES a request that
// tries to supply its own (the live service answered 403, Cloudflare "error code: 1000"), so behind
// Cloudflare it names the visitor and nothing else can. Off Cloudflare it is just a header anyone can write,
// so it is trusted only where we know Cloudflare is in front - see trustCloudflareHeader.
const net = require("net");

// Decided once, at start-up, so a bad value stops the server instead of surprising one request
// (utils/trustProxy.js refuses a bad TRUST_PROXY_HOPS the same way).
//
// Default: on when RENDER is present, because all *.onrender.com traffic transits Cloudflare; off everywhere
// else - a developer's laptop and the spawned test servers, where the header would be a free pass to name
// your own address. TRUST_CF_CONNECTING_IP=0 turns it off on Render with an environment change and no code
// deploy (the kill switch, if the premise above ever stops holding); =1 turns it on for another
// Cloudflare-fronted host.
function trustCloudflareHeader(env = process.env) {
  const raw = env.TRUST_CF_CONNECTING_IP;
  if (raw === undefined || String(raw).trim() === "") return Boolean(env.RENDER);
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`TRUST_CF_CONNECTING_IP must be true or false (got "${raw}")`);
}

// Exactly one address, or null. A list ("a, b" - what Node gives when a header arrives twice), a host name,
// an empty value or junk is NOT an address: answer null and let Express's own answer stand, which is the
// behaviour this file replaced. net.isIP is Node's own check (exact for IPv4 and IPv6, 0 for anything else).
function cloudflareClientIp(req) {
  const raw = req?.headers?.["cf-connecting-ip"];
  if (typeof raw !== "string") return null;
  const ip = raw.trim();
  if (!ip || ip.length > 45 || net.isIP(ip) === 0) return null;
  return ip;
}

const TRUSTED = trustCloudflareHeader();

// `req.ip` is a getter on Express's request prototype, declared configurable and with no setter, so an own
// property shadows it for this one request and a plain `req.ip = x` would silently do nothing. Correcting it
// here, once, fixes every reader - the limiters, the sessions, the audit trail, /health - without each
// having to remember, and without a future reader of req.ip quietly getting the old bug back.
//
// Only when we HAVE a trusted address: with nothing to say we leave Express's answer exactly as it was, so
// off Cloudflare, and in the tests, this middleware changes nothing at all.
function clientAddress(req, _res, next) {
  const ip = TRUSTED ? cloudflareClientIp(req) : null;
  if (ip) Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
  next();
}

module.exports = clientAddress;
module.exports.clientAddress = clientAddress;
module.exports.cloudflareClientIp = cloudflareClientIp;
module.exports.trustCloudflareHeader = trustCloudflareHeader;
