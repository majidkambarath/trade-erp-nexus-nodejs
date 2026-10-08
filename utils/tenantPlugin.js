// The Mongoose plugin that makes organisations unable to see each other. Applied to every schema that
// carries `companyId` (a guard test fails if a tenanted model is added without it):
//
//   reads    every query gets `companyId = <the organisation in scope>` ANDed on, whatever else it says
//   writes   a new document is stamped with the organisation; naming a different one is an error
//   updates  a document can never be moved to another organisation, by $set, $unset, $rename or replace
//   joins    a $lookup / $unionWith into another tenanted collection is scoped too
//   no scope an error (TenantScopeError), never a quiet "return everything" - see tenantContext.js
//
// What it deliberately cannot see, and the code must not do: Model.collection.* (the raw driver), and a
// $lookup into a collection that is not tenanted yet. Both are listed in CLAUDE.md.
const mongoose = require("mongoose");
const { tenantForQuery, TenantScopeError } = require("./tenantContext");

const QUERY_OPS = ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "countDocuments", "distinct"];
const UPDATE_OPS = new Set(["findOneAndUpdate", "findOneAndReplace", "updateOne", "updateMany", "replaceOne"]);
const REPLACE_OPS = new Set(["findOneAndReplace", "replaceOne"]);
const MUST_BE_FIRST = new Set(["$geoNear", "$search", "$searchMeta", "$vectorSearch", "$collStats", "$indexStats", "$currentOp"]);

const crossTenant = (what, given, want) =>
  new TenantScopeError(`Refusing ${what}: it names organisation ${JSON.stringify(given)} but this call is scoped to ${JSON.stringify(want)}`, "CROSS_TENANT");

// A filter that names an organisation must name THE organisation in scope. (The scope is ANDed on anyway,
// so a different one could only return nothing; refusing it makes the mistake loud instead of empty.)
function checkFilter(filter, tenant, what) {
  if (filter && Object.prototype.hasOwnProperty.call(filter, "companyId") && filter.companyId !== tenant.companyId) {
    throw crossTenant(what, filter.companyId, tenant.companyId);
  }
}

function checkUpdate(update, tenant, what) {
  if (!update || Array.isArray(update)) return;
  for (const [key, value] of Object.entries(update)) {
    if (key === "companyId") {
      if (value !== tenant.companyId) throw crossTenant(what, value, tenant.companyId);
    } else if (key.startsWith("$") && value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "companyId")) {
      if (key === "$unset" || key === "$rename" || value.companyId !== tenant.companyId) {
        throw crossTenant(`${what} (${key} companyId)`, key === "$set" || key === "$setOnInsert" ? value.companyId : key, tenant.companyId);
      }
    }
  }
}

// Collections whose schemas carry the plugin, looked up when needed so a model registered later counts.
function tenantedCollections() {
  const set = new Set();
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    if (model.schema.options.tenantScoped) set.add(model.collection.collectionName);
  }
  return set;
}

// Walk a pipeline and scope every join into a tenanted collection. The top-level $match for the
// pipeline's own collection is added by the caller; this handles what it pulls in from elsewhere.
function scopeStages(stages, tenant, tenanted) {
  for (const stage of stages || []) {
    if (stage.$lookup) {
      const lookup = stage.$lookup;
      const from = typeof lookup.from === "string" ? lookup.from : lookup.from?.coll;
      if (tenanted.has(from)) lookup.pipeline = [{ $match: { companyId: tenant.companyId } }, ...(lookup.pipeline || [])];
      scopeStages(lookup.pipeline, tenant, tenanted);
    } else if (stage.$unionWith) {
      const union = typeof stage.$unionWith === "string" ? { coll: stage.$unionWith } : stage.$unionWith;
      if (tenanted.has(union.coll)) union.pipeline = [{ $match: { companyId: tenant.companyId } }, ...(union.pipeline || [])];
      scopeStages(union.pipeline, tenant, tenanted);
      stage.$unionWith = union;
    } else if (stage.$facet) {
      for (const branch of Object.values(stage.$facet)) scopeStages(branch, tenant, tenanted);
    } else if (stage.$graphLookup && tenanted.has(stage.$graphLookup.from)) {
      throw new TenantScopeError("$graphLookup into a tenanted collection cannot be scoped; do the traversal in code", "UNSUPPORTED_STAGE");
    }
  }
}

// options.leadIndexes: put companyId at the front of every index the schema DECLARED (schema.index(...)), so
// "unique" means "unique within an organisation" and every query, which always carries companyId, finds an
// index that starts with it. A field-level unique/index on a path is not covered: declare those with
// schema.index() instead (tenantGuard fails any unique index that is left global).
function tenantPlugin(schema, options = {}) {
  if (!schema.path("companyId")) throw new Error("tenantPlugin: this schema has no companyId path, so there is nothing to scope by");
  if (schema.options.tenantScoped) return; // already applied (a model file can be evaluated twice)
  schema.options.tenantScoped = true;
  if (options.leadIndexes) {
    schema._indexes = schema._indexes.map(([fields, indexOptions]) =>
      Object.prototype.hasOwnProperty.call(fields, "companyId") ? [fields, indexOptions] : [{ companyId: 1, ...fields }, indexOptions]
    );
  }
  const hasBranch = Boolean(schema.path("branchId"));

  // ---- queries
  schema.pre(QUERY_OPS, function scopeQuery() {
    const tenant = tenantForQuery();
    if (!tenant) return; // deliberately unscoped
    const what = `${this.op} on ${this.model.modelName}`;
    const filter = this.getFilter();
    checkFilter(filter, tenant, what);
    this.setQuery({ ...filter, companyId: tenant.companyId });
    if (UPDATE_OPS.has(this.op)) {
      const update = this.getUpdate();
      checkUpdate(update, tenant, what);
      // A replacement document with no companyId would silently drop it; stamp it.
      if (REPLACE_OPS.has(this.op) && update && !Array.isArray(update) && update.companyId === undefined) update.companyId = tenant.companyId;
    }
  });

  // estimatedDocumentCount reads collection metadata and ignores any filter, so it cannot be scoped.
  schema.pre("estimatedDocumentCount", function refuseEstimated() {
    if (tenantForQuery()) throw new TenantScopeError("estimatedDocumentCount cannot be limited to an organisation; use countDocuments", "UNSUPPORTED_OP");
  });

  // ---- aggregations
  schema.pre("aggregate", function scopeAggregate() {
    const tenant = tenantForQuery();
    if (!tenant) return;
    const pipeline = this.pipeline();
    const first = pipeline[0] && Object.keys(pipeline[0])[0];
    if (MUST_BE_FIRST.has(first)) throw new TenantScopeError(`${first} must be the first stage, so it cannot be scoped by the plugin`, "UNSUPPORTED_STAGE");
    for (const stage of pipeline) if (stage.$match) checkFilter(stage.$match, tenant, "an aggregation $match");
    scopeStages(pipeline, tenant, tenantedCollections());
    pipeline.unshift({ $match: { companyId: tenant.companyId } });
  });

  // ---- documents
  const stampDocument = (doc, tenant) => {
    if (doc.companyId == null || doc.$isDefault?.("companyId")) doc.companyId = tenant.companyId;
    else if (doc.companyId !== tenant.companyId) throw crossTenant(`saving a ${doc.constructor?.modelName || "document"}`, doc.companyId, tenant.companyId);
    if (hasBranch && (doc.branchId == null || doc.$isDefault?.("branchId"))) doc.branchId = tenant.branchId;
  };
  const stampPlain = (doc, tenant, what) => {
    if (doc.companyId == null) doc.companyId = tenant.companyId;
    else if (doc.companyId !== tenant.companyId) throw crossTenant(what, doc.companyId, tenant.companyId);
    if (hasBranch && doc.branchId == null) doc.branchId = tenant.branchId;
  };

  // Only a NEW document is stamped. An existing one is often loaded with only some fields (select("status")),
  // so a missing companyId there means "not loaded", not "unassigned": stamping it would write the current
  // organisation and branch over what is stored. An existing document is only CHECKED: if it names another
  // organisation than the one in scope, saving it is refused.
  schema.pre("validate", function stampOnValidate() {
    const tenant = tenantForQuery();
    if (!tenant) return;
    if (this.isNew) stampDocument(this, tenant);
    else if (this.companyId != null && this.companyId !== tenant.companyId) {
      throw crossTenant(`saving a ${this.constructor?.modelName || "document"}`, this.companyId, tenant.companyId);
    }
  });
  schema.pre("save", function noMoving() {
    if (!this.isNew && this.isModified("companyId") && tenantForQuery()) {
      throw new TenantScopeError("A document cannot be moved to another organisation", "CROSS_TENANT");
    }
  });
  schema.pre("deleteOne", { document: true, query: false }, function checkOwn() {
    const tenant = tenantForQuery();
    if (tenant && this.companyId !== tenant.companyId) throw crossTenant("deleting a document", this.companyId, tenant.companyId);
  });

  // ---- bulk operations
  schema.pre("insertMany", function stampMany(next, docs) {
    try {
      const tenant = tenantForQuery();
      if (tenant) {
        for (const doc of docs || []) {
          if (typeof doc.$isDefault === "function") stampDocument(doc, tenant);
          else stampPlain(doc, tenant, "insertMany");
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  schema.pre("bulkWrite", function scopeBulk(next, ops) {
    try {
      const tenant = tenantForQuery();
      if (tenant) {
        for (const op of ops || []) {
          const [kind, body] = Object.entries(op)[0] || [];
          if (!body) continue;
          if (kind === "insertOne") {
            stampPlain(body.document, tenant, "bulkWrite insertOne");
          } else {
            checkFilter(body.filter, tenant, `bulkWrite ${kind}`);
            body.filter = { ...(body.filter || {}), companyId: tenant.companyId };
            if (body.update) checkUpdate(body.update, tenant, `bulkWrite ${kind}`);
            if (body.replacement) stampPlain(body.replacement, tenant, "bulkWrite replaceOne");
          }
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}

module.exports = tenantPlugin;
module.exports.tenantedCollections = tenantedCollections;
