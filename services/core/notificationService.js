// The in-app notification feed. Read side is self-service - any signed-in person reads only what their own
// grants make visible (routes/core/notificationRoutes.js is `signedIn`, not a permission gate, because the
// audience of any one row can be any permission key). Write side (`raise`/`resolveMissing`) is called by
// scheduled checks (services/core/notificationChecksService.js), never by a request.
const Notification = require("../../models/core/notificationModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/notifications");

// Read oldest-first would bury what just happened; a feed is read newest-first and cut here, like the
// approvals queue, so a person is never handed thousands of rows to page through.
const CAP = 300;
const SHOWN = 100;

class NotificationService {
  static row(n, me) {
    return {
      id: String(n._id),
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body || "",
      link: n.link || null,
      occurredAt: n.occurredAt,
      createdAt: n.createdAt,
      read: (n.readBy || []).map(String).includes(me),
    };
  }

  /** -> { items, counts: { total, unread }, capped } for the signed-in person. Resolved conditions are left
   * out entirely - a closed alert does not belong in an inbox. */
  static async forPerson(req, { unreadOnly = false } = {}) {
    const grants = req.admin?.grants;
    const me = String(req.admin.id);
    const rows = await Notification.find({ resolvedAt: null }).sort({ createdAt: -1 }).limit(CAP + 1).lean();
    const capped = rows.length > CAP;
    const mine = rows.slice(0, CAP).filter((n) => rules.visibleTo(n, grants));
    const shaped = mine.map((n) => this.row(n, me));
    const unread = shaped.filter((n) => !n.read);
    return { items: (unreadOnly ? unread : shaped).slice(0, SHOWN), counts: { total: shaped.length, unread: unread.length }, capped };
  }

  static async unreadCount(req) {
    const { counts, capped } = await this.forPerson(req, { unreadOnly: true });
    return { count: counts.unread, capped };
  }

  /** Mark one read. 404s rather than 403s on someone else's/invisible row - nothing confirms it exists. */
  static async markRead(req, id) {
    const found = await Notification.findById(id);
    if (!found || !rules.visibleTo(found, req.admin?.grants)) throw new AppError("Notification not found", 404, "NOTIFICATION_NOT_FOUND");
    await Notification.updateOne({ _id: found._id }, { $addToSet: { readBy: String(req.admin.id) } });
    return { id: String(found._id), read: true };
  }

  static async markAllRead(req) {
    const { items } = await this.forPerson(req, { unreadOnly: true });
    const ids = items.map((n) => n.id);
    if (ids.length) await Notification.updateMany({ _id: { $in: ids } }, { $addToSet: { readBy: String(req.admin.id) } });
    return { count: ids.length };
  }

  /**
   * The write side a scheduled check calls when it (re)detects a condition, inside that organisation's own
   * tenant scope. Not atomic (find then write): two checks for the same key would have to race inside the
   * same few-millisecond window of one process's own timer, which cannot happen today - worth an atomic
   * upsert only once a second writer exists.
   */
  static async raise({ kind, severity = "info", title, body = "", link = null, dedupeKey, permission = null, now = new Date() }) {
    const existing = await Notification.findOne({ dedupeKey }).lean();
    const action = rules.planRaise(existing);
    if (action === "touch") {
      await Notification.updateOne({ _id: existing._id }, { $set: { occurredAt: now, title, body, link, severity } });
      return { action, id: String(existing._id) };
    }
    if (action === "reopen") {
      await Notification.updateOne({ _id: existing._id }, { $set: { title, body, link, severity, occurredAt: now, resolvedAt: null, readBy: [] } });
      return { action, id: String(existing._id) };
    }
    const created = await Notification.create({ kind, severity, title, body, link, dedupeKey, audience: { permission }, occurredAt: now });
    return { action, id: String(created._id) };
  }

  /** Everything of `kind` that is open but not in `activeDedupeKeys` any more is resolved: the condition
   * went away (an item was restocked) and a future recurrence opens a fresh, unread row rather than
   * silently staying "read" forever. */
  static async resolveMissing({ kind, activeDedupeKeys, now = new Date() }) {
    const result = await Notification.updateMany({ kind, resolvedAt: null, dedupeKey: { $nin: activeDedupeKeys } }, { $set: { resolvedAt: now } });
    return { resolved: result.modifiedCount || 0 };
  }
}

module.exports = NotificationService;
