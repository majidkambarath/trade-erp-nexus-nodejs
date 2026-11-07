// What version of the API is running, read once at start-up.
//
// It exists because the app and the API are deployed SEPARATELY (two Render services - see CLAUDE.md's
// Deployment section), so "which version is live" is genuinely two questions, and a mismatch between them
// is a real diagnosis rather than a curiosity. The figure is reported in two places: GET /api/v1/health,
// which anybody can check from outside without signing in, and GET /organisation/status, so a signed-in
// screen already has it without a second request.
const path = require("path");

let version = "unknown";
try {
  // eslint-disable-next-line import/no-dynamic-require
  version = String(require(path.resolve(__dirname, "..", "package.json")).version || "unknown");
} catch (_) {
  // A package.json that cannot be read is not a reason to refuse to start: the version is a label, not a rule.
}

// When this process started, which tells a deploy apart from a restart.
const startedAt = new Date().toISOString();

module.exports = { version, startedAt };
