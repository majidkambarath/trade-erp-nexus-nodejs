const VoucherType = require("../../models/modules/financial/voucherTypeModel");
const NumberSeries = require("../../models/modules/financial/numberSeriesModel");
const IssuedNumber = require("../../models/modules/financial/issuedNumberModel");
const Branch = require("../../models/core/branchModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const V = require("../../utils/voucherTypes");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What a person may change. `key`, `kind`, `postsAs` and `statutory` are not here: they decide what a
// type IS and what the engine does with it, and a seeded row's identity must not move under the
// documents already numbered from it.
const FIELDS = ["name", "prefix", "suffix", "separator", "includeYear", "numberLength", "resetPolicy", "branchPrefix", "branchPrefixes", "method", "allowReuse", "isActive"];

// Changing one of these changes which counter a document is numbered from, so the new counter has to be
// seeded from the old one or the series silently restarts at 1.
const RESEEDS = ["resetPolicy"];

const clean = (v) => String(v == null ? "" : v).trim().toUpperCase();

// The configuration is read on the hot path of every document, so it is cached per organisation on a
// short lease, the way utils/orgLocale.js caches an organisation's currency and zone. A change made by
// this instance clears it at once; a change made by another shows within the lease.
const CACHE = new Map();
const LEASE_MS = 60_000;
const actor = (req) => (req && req.admin && req.admin.id ? String(req.admin.id) : null);

class VoucherTypeService {
  /** Forget the cached configuration for an organisation, or for all of them. */
  static forget(companyId) {
    if (companyId) CACHE.delete(companyId);
    else CACHE.clear();
  }

  /**
   * The organisation's types, cached. Read WITHOUT the caller's session on purpose: configuration is not
   * part of a posting transaction, and caching a read made inside one that later aborted would leave the
   * cache holding rows that never existed.
   */
  static async cached(companyId) {
    const hit = CACHE.get(companyId);
    if (hit && Date.now() - hit.at < LEASE_MS) return hit.rows;
    const rows = await VoucherType.find({ companyId }).lean();
    CACHE.set(companyId, { at: Date.now(), rows });
    return rows;
  }

  /**
   * The configuration a series is numbered by. NEVER writes and never seeds: an organisation that has
   * not opened the Numbering screen has no rows at all and falls back to the seed, which is exactly
   * today's hardcoded behaviour. That is what keeps allocation read-only and keeps seeding out of a
   * posting transaction.
   */
  static async configFor({ series, voucherTypeKey, postsAs, companyId }) {
    const rows = await this.cached(companyId);
    const wanted = clean(voucherTypeKey || series);
    if (wanted) {
      const own = rows.find((t) => clean(t.key) === wanted);
      if (own) return own;
    }
    const found = V.seriesFor({ voucherTypeKey, postsAs, types: rows });
    if (found) return found;
    const seeded = V.seedFor(wanted);
    return seeded ? { ...V.DEFAULTS, ...seeded } : null;
  }

  // Seeded on first read, exactly as DocumentTypeService does it: an early-out on the count, upserts
  // that only ever set on insert, and a swallowed duplicate for the parallel first call. Never
  // overwrites, so an organisation's own choices survive every later read - and because the seed is
  // today's hardcoded defaults, an organisation already trading keeps every number it has issued.
  static async ensureDefaults(req) {
    const { companyId } = getTenant(req);
    const rows = V.seedRows();
    if ((await VoucherType.countDocuments({ companyId, isSystem: true })) >= rows.length) return 0;
    let made = 0;
    for (const row of rows) {
      const r = await VoucherType.updateOne(
        { companyId, key: row.key },
        { $setOnInsert: { ...row, companyId } },
        { upsert: true }
      ).catch((err) => { if (err.code !== 11000) throw err; return { upsertedCount: 0 }; });
      made += r.upsertedCount || 0;
    }
    if (made) VoucherTypeService.forget(companyId);
    return made;
  }

  static async list(req, { kind, active, q } = {}) {
    const { companyId } = getTenant(req);
    await this.ensureDefaults(req);
    const filter = { companyId };
    if (kind && V.KINDS.includes(kind)) filter.kind = kind;
    if (active === true || active === "true") filter.isActive = true;
    if (q) filter.$or = [{ name: new RegExp(escapeRe(q), "i") }, { key: new RegExp(escapeRe(q), "i") }, { prefix: new RegExp(escapeRe(q), "i") }];
    return VoucherType.find(filter).sort({ kind: 1, name: 1 }).lean();
  }

  /** Every type as a plain array, for the generator and for resolving a variant. Seeds on first use. */
  static async all(req, { session } = {}) {
    const { companyId } = getTenant(req);
    await this.ensureDefaults(req);
    const q = VoucherType.find({ companyId });
    return (session ? q.session(session) : q).lean();
  }

  static async get(key, req, { session } = {}) {
    const { companyId } = getTenant(req);
    const q = VoucherType.findOne({ companyId, key: clean(key) });
    const row = await (session ? q.session(session) : q).lean();
    if (!row) throw new AppError("There is no voucher type " + clean(key), 404, "VOUCHER_TYPE_NOT_FOUND");
    return row;
  }

  /**
   * The type a document of this kind is numbered from, seeded if the organisation has never read the
   * list. Falls back to the SEED row so a brand-new organisation, or one whose row was somehow removed,
   * still gets a number rather than an error: numbering must never be the thing that stops a sale.
   */
  static async resolve({ series, voucherTypeKey, postsAs, req, session } = {}) {
    const types = await this.all(req, { session });
    const wanted = clean(voucherTypeKey || series);
    if (wanted) {
      const own = types.find((t) => clean(t.key) === wanted);
      if (own) return own;
    }
    const found = V.seriesFor({ voucherTypeKey, postsAs, types });
    if (found) return found;
    const seeded = V.seedFor(wanted);
    return seeded ? { ...V.DEFAULTS, ...seeded } : null;
  }

  static async branches(req) {
    const { companyId } = getTenant(req);
    return Branch.find({ companyId }).select("code name isActive isHeadOffice").lean();
  }

  static patchOf(body) {
    return Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
  }

  // The pure rules decide; this only supplies what they cannot know (the parent, and the branch codes a
  // number has to stay short enough for).
  static async assertValid(patch, { req, key, parentKey, statutory, kind, takenKeys = [] }) {
    const parent = parentKey ? await this.get(parentKey, req).catch(() => null) : null;
    const branches = await this.branches(req);
    const errors = V.validateVoucherType({ ...V.DEFAULTS, ...patch, key, parentKey, statutory, kind }, { takenKeys, parent, branches });
    const first = Object.keys(errors)[0];
    if (first) throw new AppError(errors[first], 400, "VOUCHER_TYPE_INVALID", { errors, field: first });
    return parent;
  }

  /** A named variant of a built-in: its own name, prefix and counter, posting exactly as its parent. */
  static async create(body, req) {
    const { companyId } = getTenant(req);
    await this.ensureDefaults(req);
    const key = clean(body.key);
    const parentKey = clean(body.parentKey);
    if (!parentKey) throw new AppError("A new voucher type is a variant of an existing one, so it needs a parent.", 400, "PARENT_REQUIRED");
    const parent = await this.get(parentKey, req);
    if (parent.parentKey) throw new AppError("A variant cannot have a variant of its own.", 400, "VOUCHER_TYPE_INVALID");

    const taken = (await VoucherType.find({ companyId }).select("key").lean()).map((t) => t.key);
    const patch = this.patchOf(body);
    await this.assertValid(patch, { req, key, parentKey, statutory: parent.statutory, kind: parent.kind, takenKeys: taken });

    try {
      const made = await VoucherType.create({
        ...V.DEFAULTS,
        ...patch,
        companyId,
        key,
        parentKey,
        kind: parent.kind,
        postsAs: parent.postsAs,
        statutory: parent.statutory,
        isSystem: false,
        createdBy: actor(req),
      });
      VoucherTypeService.forget(companyId);
      return made.toObject();
    } catch (err) {
      if (err.code === 11000) throw new AppError("A voucher type with that code or name already exists.", 409, "DUPLICATE_VOUCHER_TYPE");
      throw err;
    }
  }

  static async update(key, body, req) {
    const { companyId } = getTenant(req);
    const current = await this.get(key, req);
    const patch = this.patchOf(body);
    if (!Object.keys(patch).length) return current;

    const next = { ...current, ...patch };
    await this.assertValid(next, { req, key: current.key, parentKey: current.parentKey, statutory: current.statutory, kind: current.kind });

    // A policy change moves the series onto a different counter. Carry the count over first, or a client
    // who switches Journal to continuous finds its next voucher numbered 0001 all over again.
    const moved = RESEEDS.some((f) => patch[f] !== undefined && patch[f] !== current[f]);
    const reseeded = moved ? await this.reseed(current, next, req) : null;

    try {
      await VoucherType.updateOne({ companyId, key: current.key }, { $set: { ...patch, updatedBy: actor(req) } });
    } catch (err) {
      if (err.code === 11000) throw new AppError("A voucher type with that name already exists.", 409, "DUPLICATE_VOUCHER_TYPE");
      throw err;
    }
    VoucherTypeService.forget(companyId);
    const saved = await this.get(current.key, req);
    return reseeded ? { ...saved, reseeded } : saved;
  }

  /**
   * Seed the counter the series is moving ONTO from the highest number it has already reached, per
   * branch. A number is never handed out twice, so the only safe direction is forward: $max, never a
   * plain set, and never downward.
   */
  static async reseed(current, next, req) {
    const { companyId } = getTenant(req);
    const rows = await NumberSeries.find({ companyId, series: current.key }).lean();
    if (!rows.length) return null;
    const label = V.labelOf({ type: next, fiscalYear: null, year: new Date().getUTCFullYear() }).label;
    const out = [];
    for (const branchId of [...new Set(rows.map((r) => r.branchId))]) {
      const mine = rows.filter((r) => r.branchId === branchId);
      const highest = Math.max(0, ...mine.map((r) => Number(r.next) || 0));
      const already = mine.find((r) => r.fiscalYear === label);
      if (highest <= 0 || (already && Number(already.next) >= highest)) continue;
      await NumberSeries.updateOne(
        { companyId, branchId, series: current.key, fiscalYear: label },
        { $max: { next: highest }, $set: { prefix: V.renderPrefixFor(next, branchId), numberLength: V.widthOf(next) } },
        { upsert: true }
      );
      out.push({ branchId, label, from: highest });
    }
    return out.length ? out : null;
  }

  /** What has been built on this type, so a person is told before they change or switch one off. */
  static async usage(key, req) {
    const { companyId } = getTenant(req);
    const series = clean(key);
    const [issued, counters, variants] = await Promise.all([
      IssuedNumber.countDocuments({ companyId, series }),
      NumberSeries.countDocuments({ companyId, series }),
      VoucherType.countDocuments({ companyId, parentKey: series }),
    ]);
    return { issued, counters, variants };
  }

  static async remove(key, req) {
    const { companyId } = getTenant(req);
    const row = await this.get(key, req);
    if (row.isSystem) throw new AppError(row.name + " is one of the built-in types. Switch it off instead of deleting it.", 409, "VOUCHER_TYPE_IS_DEFAULT");
    const used = await this.usage(key, req);
    if (used.issued > 0) {
      throw new AppError(row.name + " has already numbered " + used.issued + " document" + (used.issued === 1 ? "" : "s") + ". Switch it off instead of deleting it.", 409, "VOUCHER_TYPE_IN_USE");
    }
    await VoucherType.deleteOne({ companyId, key: row.key });
    VoucherTypeService.forget(companyId);
    return { key: row.key, name: row.name };
  }
}

module.exports = VoucherTypeService;
module.exports.FIELDS = FIELDS;
