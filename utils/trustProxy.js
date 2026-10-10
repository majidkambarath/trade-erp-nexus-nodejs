// How many proxies of ours stand between the internet and this server, for Express's `trust proxy` setting.
//
// It decides what `req.ip` is, which every per-address limit uses (sign-in failures, reset requests, the public document link) and
// which the sessions and the audit trail record. Express takes the X-Forwarded-For header, counts N addresses in from the RIGHT (each
// proxy appends the address it was connected from, so the right-hand end is written by us, not by the client) and takes the next one.
//   0   no proxy: req.ip is the connecting socket and the header is ignored (local development, the tests)
//   N   N proxies in front
//
// Too LOW a number makes every visitor look like our own proxy (one shared allowance: a few failed sign-ins lock everybody out of the
// door). Too HIGH a number lets a client choose its address by writing the header (no per-address limit at all, as before). The
// per-account lock-out does not depend on the address either way.
//
// On Render a request passes Cloudflare and then Render's own proxy before the app, which is two hops. That is the default when the
// RENDER variable is present; TRUST_PROXY_HOPS overrides it. Check it after a deploy: GET /api/v1/health answers `yourAddress`, the address
// the server believes the request came from - it should be YOUR address, and should not change when you add a forged X-Forwarded-For.
function trustProxyHops(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw !== undefined && String(raw).trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
    throw new Error(`TRUST_PROXY_HOPS must be a whole number from 0 to 10 (got "${raw}")`);
  }
  return env.RENDER ? 2 : 0;
}

module.exports = { trustProxyHops };
