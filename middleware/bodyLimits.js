// How much body the server reads, and from whom.
//
// It used to read up to 50 MB of JSON (and of form text) from ANYONE, before any login: one unauthenticated request could make the
// server hold and parse 50 MB, and a handful at once could exhaust the memory of a small instance. Now:
//
//   - a JSON body is limited to JSON_BODY_LIMIT (default 1 MB: the largest ordinary document is a few kilobytes)
//   - the few routes that really take a big JSON body get LARGE_JSON_BODY_LIMIT (default 12 MB) - and only from someone who presents a
//     validly signed, unexpired ACCESS token. Nobody else gets more than the small limit, whatever route they name.
//       * bank statement import and its preview (every line of the statement is in the body)
//       * opening balances (every account, party or item of the go-live set)
//   - form-encoded bodies (nothing in the app sends one) are limited to 100 KB, flat keys only (no nested `a[$ne]=1` objects)
//   - files are not JSON: they go through multer, each route with its own size limit
const express = require("express");

const LARGE_ROUTES = [
  /^\/api\/v1\/banking\/reconciliation\/import(\/preview)?\/?$/,
  /^\/api\/v1\/opening-balances(\/|$)/,
];

// webhooks are signed over the exact bytes, so those bodies are kept as they arrived (only those: see server.js)
const keepRawBody = (req, _res, buf) => {
  if (req.originalUrl.includes("/webhook")) req.rawBody = buf;
};

function bodyParsers({ verifyToken } = {}) {
  const small = express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb", verify: keepRawBody });
  const large = express.json({ limit: process.env.LARGE_JSON_BODY_LIMIT || "12mb", verify: keepRawBody });

  const holdsValidToken = (req) => {
    const header = req.headers.authorization;
    if (!verifyToken || !header || !header.startsWith("Bearer ")) return false;
    try {
      const claims = verifyToken(header.slice(7));
      return claims.type !== "refresh" && claims.use !== "refresh";
    } catch (_) {
      return false;
    }
  };

  const bigForTheTrusted = (req, res, next) => {
    // body-parser leaves a body that is already parsed alone, so the small parser after this one is a no-op for these
    if (LARGE_ROUTES.some((rx) => rx.test(req.path)) && holdsValidToken(req)) return large(req, res, next);
    return next();
  };

  return [bigForTheTrusted, small, express.urlencoded({ limit: "100kb", extended: false })];
}

module.exports = { bodyParsers, LARGE_ROUTES };
