// Tenancy scope for new models. The app has no company/branch concept yet, so every request
// resolves to one default scope. New models carry companyId + branchId and lead their indexes
// with them, so a second company or branch is a data change, not a migration across every
// collection. When real tenancy arrives, only this function changes.
const DEFAULT_TENANT = Object.freeze({
  companyId: process.env.COMPANY_ID || "default",
  branchId: process.env.BRANCH_ID || "main",
});

const getTenant = (_req) => ({ ...DEFAULT_TENANT });

module.exports = { DEFAULT_TENANT, getTenant };
