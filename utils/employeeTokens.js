// The employee portal's own tokens (D15): its own secret and audience, so a customer's admin token can
// never open these routes and an employee's token can never open the ERP - the same four independent
// barriers PlatformUser's console tokens already prove (own collection, own secret, own audience, own
// lookup), applied in the opposite direction.
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { jwtSecret } = require("./productionConfig");

const ISSUER = "ERP-system";
const AUDIENCE = "ERP-employee";
// A separate secret when one is configured; else one DERIVED from the admin secret (never the same
// value) - the same fallback platformAuthService.js uses, so this works with no extra setup and is still
// not signed with the customer-admin key.
const secret = () => process.env.EMPLOYEE_JWT_SECRET || `${jwtSecret()}::employee-portal`;

const ACCESS_LIFETIME = process.env.EMPLOYEE_ACCESS_EXPIRES_IN || "15m";
const REFRESH_LIFETIME_DAYS = Number(process.env.EMPLOYEE_REFRESH_DAYS) || 30;

function signAccess({ id, staffId, companyId }) {
  return jwt.sign(
    { sub: String(id), staffId: String(staffId), companyId, use: "access", scope: "employee" },
    secret(),
    { expiresIn: ACCESS_LIFETIME, issuer: ISSUER, audience: AUDIENCE }
  );
}

function signRefresh({ id, companyId, jti }) {
  return jwt.sign(
    { sub: String(id), companyId, jti, use: "refresh", scope: "employee" },
    secret(),
    { expiresIn: `${REFRESH_LIFETIME_DAYS}d`, issuer: ISSUER, audience: AUDIENCE }
  );
}

function newJti() {
  return crypto.randomBytes(16).toString("hex");
}

/** Verifies the signature, issuer, audience and scope; `use` (access|refresh) is the caller's own check -
 * this never assumes which kind it was handed, the same separation the admin/platform tokens keep. */
function verify(token) {
  const claims = jwt.verify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
  if (claims.scope !== "employee") throw new Error("wrong scope");
  return claims;
}

module.exports = { signAccess, signRefresh, newJti, verify, ACCESS_LIFETIME, REFRESH_LIFETIME_DAYS, AUDIENCE };
