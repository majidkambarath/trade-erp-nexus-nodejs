const ActivityLog = require("../../models/modules/financial/activityLogModel");
const { getTenant } = require("../../utils/tenant");
const { changes: changesOf } = require("../../utils/auditDiff");

// Keep log rows small and free of secrets.
const SENSITIVE = /(password|passwd|secret|token|apikey|api_key|passenc|keyenc|enc$|otp|recovery)/i;
function scrub(value, depth = 0) {
  if (value == null) return null;
  // deeper than this is cut, never passed through raw: a secret four levels down must not reach the log
  if (depth > 4) return typeof value === "object" ? "[too deep]" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value;
  // A MongoDB id is written as its hex string; left alone it serialises as raw bytes.
  if (typeof value.toHexString === "function") return value.toHexString();
  if (typeof value === "object") {
    if (typeof value.toObject === "function") value = value.toObject();
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? "[redacted]" : scrub(v, depth + 1);
    return out;
  }
  return typeof value === "string" && value.length > 500 ? value.slice(0, 500) + "…" : value;
}

class AuditService {
  // Fire-and-forget by design: a logging failure must never fail the request it describes.
  static async log({ req, action, entity, entityId, summary, before, after, changes }) {
    try {
      const { companyId } = getTenant(req);
      await ActivityLog.create({
        companyId,
        userId: req?.admin?.id ? String(req.admin.id) : null,
        username: req?.admin?.email || req?.admin?.name || null,
        action,
        entity,
        entityId: entityId ? String(entityId) : null,
        // a long summary is cut rather than losing the row to the length limit
        summary: typeof summary === "string" ? summary.slice(0, 500) : summary,
        before: scrub(before),
        after: scrub(after),
        // old and new value of each field that changed, when both sides are known
        ...(changes ? { changes } : before && after && typeof before === "object" && typeof after === "object" ? { changes: changesOf(before, after) } : {}),
        ip: req?.ip || null,
      });
    } catch (err) {
      console.error("[audit] could not write log:", err.message);
    }
  }

  // Records removed from their own collection, kept whole (utils/auditPlugin.js), newest first.
  static async deletedRecords(req, { entity, page = 1, limit = 50 } = {}) {
    const DeletedRecord = require("../../models/modules/deletedRecordModel");
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (typeof entity === "string" && entity.trim()) q.entity = entity.trim();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const [rows, total] = await Promise.all([
      DeletedRecord.find(q).sort({ deletedAt: -1, _id: -1 }).skip(skip).limit(lim).lean(),
      DeletedRecord.countDocuments(q),
    ]);
    // each row says whether it can be put back and whether it is back already (services/core/restoreService.js)
    const annotated = await require("./restoreService").annotate(rows);
    return { rows: annotated.map((r) => ({ ...r, data: scrub(r.data) })), total, page: Number(page) || 1, pages: Math.ceil(total / lim) };
  }

  static async list(req, { entity, entityId, action, user, from, to, page = 1, limit = 50 } = {}) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (entity) q.entity = entity;
    if (entityId) q.entityId = entityId;
    if (action) q.action = action;
    // who made it: by sign-in address or account id
    if (typeof user === "string" && user.trim()) q.$or = [{ username: user.trim().toLowerCase() }, { userId: user.trim() }];
    if (from || to) {
      q.at = {};
      if (from) q.at.$gte = new Date(from);
      if (to) q.at.$lte = new Date(to);
    }
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const [rows, total] = await Promise.all([
      ActivityLog.find(q).sort({ at: -1, _id: -1 }).skip(skip).limit(lim).lean(),
      ActivityLog.countDocuments(q),
    ]);
    return { rows, total, page: Number(page) || 1, pages: Math.ceil(total / lim) };
  }
}

module.exports = AuditService;
