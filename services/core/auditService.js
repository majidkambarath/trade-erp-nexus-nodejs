const ActivityLog = require("../../models/modules/financial/activityLogModel");
const { getTenant } = require("../../utils/tenant");

// Keep log rows small and free of secrets.
const SENSITIVE = /(password|secret|token|apikey|api_key)/i;
function scrub(value, depth = 0) {
  if (value == null || depth > 4) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value;
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
  static async log({ req, action, entity, entityId, summary, before, after }) {
    try {
      const { companyId } = getTenant(req);
      await ActivityLog.create({
        companyId,
        userId: req?.admin?.id ? String(req.admin.id) : null,
        username: req?.admin?.email || req?.admin?.name || null,
        action,
        entity,
        entityId: entityId ? String(entityId) : null,
        summary,
        before: scrub(before),
        after: scrub(after),
        ip: req?.ip || null,
      });
    } catch (err) {
      console.error("[audit] could not write log:", err.message);
    }
  }

  static async list(req, { entity, entityId, action, from, to, page = 1, limit = 50 } = {}) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (entity) q.entity = entity;
    if (entityId) q.entityId = entityId;
    if (action) q.action = action;
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
