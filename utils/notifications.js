// Pure rules for the in-app notification feed. No database, no tenant scope - see
// services/core/notificationService.js for where these are applied.
const roles = require("./permissions");

/** Whether `admin`'s grants let them see this notification. One permission key per row names the whole
 * organisation's holders - judged the same way the approvals queue judges a document (utils/approvalRules.js),
 * nothing narrower in this first slice. A row with no `audience.permission` is visible to anyone signed in. */
function visibleTo(notification, grants) {
  const need = notification?.audience?.permission;
  return !need || roles.can(grants, need);
}

/** What a background check's fresh detection of `dedupeKey` should do to the stored row for it (or its
 * absence):
 *  - "create"  no row yet
 *  - "touch"   an OPEN row already exists - it is the same unresolved episode, so only `occurredAt` (and
 *              the row's own text, in case it changed) move; a person who already read and dismissed it
 *              must not see it marked unread again for a condition that never went away
 *  - "reopen"  the existing row was RESOLVED and the condition has recurred - a fresh episode, so it opens
 *              unread again */
function planRaise(existing) {
  if (!existing) return "create";
  if (existing.resolvedAt) return "reopen";
  return "touch";
}

module.exports = { visibleTo, planRaise };
