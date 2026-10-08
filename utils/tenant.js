// Which organisation and branch the caller is working for. Pure reading: the scope itself is opened by
// utils/tenantContext.js (sign-in opens one per request; a background job opens one per organisation it
// serves), so the ~230 existing `getTenant(req)` calls keep working without anyone threading `req`.
//
// Order of trust: the ambient scope, then a tenant the auth middleware attached to the request, then -
// only while TENANT_LEGACY_DEFAULT is on - the single default organisation. Anything else is an error.
const { DEFAULT_TENANT, TenantScopeError, ambientTenant, isUnscoped, legacyDefaultEnabled } = require("./tenantContext");

const getTenant = (req) => {
  if (isUnscoped()) {
    throw new TenantScopeError("getTenant() was called inside an unscoped block, which has no organisation. Pass the organisation explicitly.", "UNSCOPED_HAS_NO_TENANT");
  }
  const ambient = ambientTenant();
  const fromReq = req?.tenant?.companyId ? req.tenant : null;
  if (ambient && fromReq && ambient.companyId !== fromReq.companyId) {
    throw new TenantScopeError("The request's organisation does not match the scope it is running in", "TENANT_MISMATCH");
  }
  const t = ambient || fromReq;
  if (t) return { companyId: t.companyId, branchId: t.branchId || DEFAULT_TENANT.branchId };
  if (legacyDefaultEnabled()) return { ...DEFAULT_TENANT };
  throw new TenantScopeError("No organisation is in scope for this call", "NO_TENANT_SCOPE");
};

module.exports = { DEFAULT_TENANT, getTenant };
