// Loaded before the test suites (`node --require ./utils/testSetup.js --test ...`, see package.json).
//
// The server fails closed: a query with no organisation in scope throws. The older suites exercise the
// services directly as ONE company and have no request to open a scope, so they run in the single-company
// compatibility mode. A suite that is about tenancy sets TENANT_LEGACY_DEFAULT itself and is unaffected.
if (process.env.TENANT_LEGACY_DEFAULT === undefined) process.env.TENANT_LEGACY_DEFAULT = "1";

// Attachments: the tests write to the server's own disk, never to the real Cloudinary account (the credentials
// in .env would otherwise be used by every suite that uploads a file, and by the servers they spawn, which
// inherit this). services/core/attachmentService.js reads it.
// VAT registration rules (utils/vatRegistration.js) off: the older suites build UAE organisations with no tax number and expect VAT at the
// standard rate. The suites about the rule switch them on for themselves; a deployment never sets this.
if (process.env.VAT_REGISTRATION_RULES === undefined) process.env.VAT_REGISTRATION_RULES = "off";

if (process.env.ATTACHMENT_STORAGE === undefined) process.env.ATTACHMENT_STORAGE = "disk";
