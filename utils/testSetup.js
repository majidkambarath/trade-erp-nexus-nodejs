// Loaded before the test suites (`node --require ./utils/testSetup.js --test ...`, see package.json).
//
// The server fails closed: a query with no organisation in scope throws. The older suites exercise the
// services directly as ONE company and have no request to open a scope, so they run in the single-company
// compatibility mode. A suite that is about tenancy sets TENANT_LEGACY_DEFAULT itself and is unaffected.
if (process.env.TENANT_LEGACY_DEFAULT === undefined) process.env.TENANT_LEGACY_DEFAULT = "1";
