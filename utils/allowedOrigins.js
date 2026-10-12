// The browser origins this API trusts. Kept in its own file because two places need it and neither may
// require the other: server.js (CORS) and services/messaging/shareService.js (which frontend a
// customer's document link should point at).
//
// Trailing slashes are stripped so "https://x.com/" in the env var still matches the Origin header,
// which never carries one.
// The dev server addresses, which are a convenience on a developer's machine and a hole in production: the
// session cookie is SameSite=None there, so a page served from someone's own localhost could call the live API
// with their cookie, and shareService would accept that address as the base of a customer's document link.
const LOCAL_ORIGINS = [
  "http://localhost:5173", // vite dev server
  "http://localhost:4173", // vite preview
  "http://localhost:3000",
  "http://localhost:8080",
];

const inProduction = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

const DEFAULT_ALLOWED_ORIGINS = [
  ...(inProduction ? [] : LOCAL_ORIGINS),
  "https://zarvia.onrender.com", // deployed frontend
];

const normalizeOrigin = (value) => String(value || "").trim().replace(/[/]+$/, "");

const allowedOrigins = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.CORS_ORIGINS || "").split(",").map(normalizeOrigin).filter(Boolean),
];

const isAllowedOrigin = (origin) => {
  const o = normalizeOrigin(origin);
  return Boolean(o) && allowedOrigins.includes(o);
};

module.exports = { DEFAULT_ALLOWED_ORIGINS, LOCAL_ORIGINS, allowedOrigins, normalizeOrigin, isAllowedOrigin };
