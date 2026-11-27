// Every change a PERSON makes to a record of this model is written to the audit log with its old and new values, in the
// same transaction as the change, and a record that is deleted is first copied whole to DeletedRecord.
//
//   schema.plugin(auditPlugin, { entity: "Customer", ignore: ["cashBalance"] })
//
// Why a model plugin and not a line in each controller: a change made three services below a route (a party master saved
// by the CRM, an item's price set by an import) is still a change, and a controller list is out of date the day somebody
// adds a route. Here every save, update and delete of the model passes through the same hooks.
//
// What it does NOT log, on purpose:
//   - a write with no person behind it (a background job, a migration, a sign-in attempt): there is nobody to name;
//   - a write that only touches `ignore` fields - the figures the books keep for themselves (a party's running balance,
//     an item's quantity and cost, an account's balance), each already recorded by the posting, movement or ledger entry
//     that changed it, with its document and its author;
//   - updateMany: a bulk change made by the system. A person's edits are single.
// A failure to write the log never fails the change it describes (as AuditService.log).

const { changes, updatedPaths, ignored } = require("./auditDiff");
const { currentActor } = require("./tenantContext");

const SINGLE_UPDATES = ["findOneAndUpdate", "updateOne", "findOneAndReplace", "replaceOne"];
const QUERY_DELETES = ["deleteOne", "findOneAndDelete"];
const LABEL_KEYS = ["transactionNo", "voucherNo", "customerName", "vendorName", "itemName", "accountName", "name", "code", "key", "email", "title", "unitName"];
const MAX_BULK_COPY = 500;

// an update that writes nothing on an existing record: only $setOnInsert (and the clock)
const SYSTEM_OPS = new Set(["$setOnInsert", "$currentDate"]);
// (Mongoose adds `$set: { updatedAt }` to every update of a schema with timestamps, so a $set of the clock alone counts too)
const CLOCK = new Set(["updatedAt", "createdAt"]);
const systemOnly = (update) => {
  if (!update || Array.isArray(update)) return false;
  const keys = Object.keys(update);
  return keys.length > 0 && keys.every((k) =>
    SYSTEM_OPS.has(k) || (k === "$set" && update.$set && typeof update.$set === "object" && Object.keys(update.$set).every((f) => CLOCK.has(f))));
};
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const labelOf = (doc) => (doc && LABEL_KEYS.map((k) => doc[k]).find((v) => typeof v === "string" && v.trim())) || (doc?._id ? String(doc._id) : "");

// Loaded with the plugin, not when first needed: Mongoose creates a model's collection when the model is compiled
// (autoCreate), and a model compiled for the first time in the middle of a transaction creates it there, which MongoDB
// refuses (112, "namespace already in use") or which blocks Atlas's own size check until it times out.
const MODELS = {
  ActivityLog: require("../models/modules/financial/activityLogModel"),
  DeletedRecord: require("../models/modules/deletedRecordModel"),
};
const model = (name) => MODELS[name];
const sessionOf = (query) => query.getOptions?.().session || query.options?.session || null;
const withSession = (q, session) => (session ? q.session(session) : q);

async function writeLog(entity, action, { doc, before, after, ignore, session, summary }) {
  const actor = currentActor();
  if (!actor) return;
  try {
    const diff = changes(before, after, { ignore });
    if (action.endsWith("_UPDATED") && !diff.length) return; // nothing a person changed
    const label = labelOf(after || before || doc);
    const fields = diff.map((c) => c.field);
    const text = summary || `${entity} ${label} ${action.endsWith("_CREATED") ? "created" : action.endsWith("_DELETED") ? "deleted" : `changed: ${fields.slice(0, 8).join(", ")}${fields.length > 8 ? ` and ${fields.length - 8} more` : ""}`}`;
    await model("ActivityLog").create([{
      userId: actor.id || null,
      username: actor.name || null,
      ip: actor.ip || null,
      action,
      entity,
      entityId: (after || before || doc)?._id ? String((after || before || doc)._id) : null,
      summary: text.slice(0, 500),
      changes: diff,
    }], session ? { session } : {});
  } catch (err) {
    console.error(`[audit] could not log ${action}:`, err.message);
  }
}

async function keepDeleted(entity, docs, session, reason) {
  if (!docs.length) return;
  const actor = currentActor();
  await model("DeletedRecord").create(
    docs.map((d) => ({
      entity, entityId: String(d._id), label: labelOf(d), data: d,
      deletedBy: actor?.id || null, deletedByName: actor?.name || null, ip: actor?.ip || null,
      ...(reason ? { reason } : {}),
    })),
    session ? { session, ordered: true } : {}
  );
}

function auditPlugin(schema, { entity, ignore = [], diff = true, keep = true } = {}) {
  if (!entity) throw new Error("auditPlugin needs the entity name");
  const action = (what) => `${snake(entity)}_${what}`;
  const onlyIgnored = (paths) => paths.length > 0 && paths.every((p) => CLOCK.has(p) || p === "__v" || ignored(p.replace(/\.\$.*$/, ""), ignore));

  if (diff) {
    // ---- save(): a new record, or an existing one changed and saved
    schema.pre("save", async function auditBeforeSave() {
      this.$locals.auditNew = this.isNew;
      if (this.isNew || !currentActor()) return;
      const modified = this.modifiedPaths();
      if (!modified.length || onlyIgnored(modified)) return;
      this.$locals.auditBefore = await withSession(this.constructor.findById(this._id).lean(), this.$session());
    });
    schema.post("save", async function auditAfterSave(doc) {
      if (doc.$locals.auditNew) {
        await writeLog(entity, action("CREATED"), { after: doc.toObject(), ignore, session: doc.$session() });
      } else if (doc.$locals.auditBefore) {
        await writeLog(entity, action("UPDATED"), { before: doc.$locals.auditBefore, after: doc.toObject(), ignore, session: doc.$session() });
      }
      delete doc.$locals.auditBefore;
    });

    // ---- one record updated by a query
    schema.pre(SINGLE_UPDATES, { document: false, query: true }, async function auditBeforeUpdate() {
      if (!currentActor()) return;
      if (onlyIgnored(updatedPaths(this.getUpdate()))) return;
      // a seed written only if missing ($setOnInsert: the starter rows a screen tops up as it opens) is the system's, not a
      // person's change; reading and logging every one of them made those screens slow to open
      if (systemOnly(this.getUpdate())) return;
      this._auditBefore = await withSession(this.model.findOne(this.getFilter()).lean(), sessionOf(this));
      this._auditAsked = true;
    });
    schema.post(SINGLE_UPDATES, { document: false, query: true }, async function auditAfterUpdate() {
      if (!this._auditAsked) return;
      const before = this._auditBefore;
      const session = sessionOf(this);
      const after = before
        ? await withSession(this.model.findById(before._id).lean(), session)
        : await withSession(this.model.findOne(this.getFilter()).lean(), session); // an upsert made it
      if (!after) return;
      await writeLog(entity, action(before ? "UPDATED" : "CREATED"), { before, after, ignore, session });
    });
  }

  if (keep) {
    // ---- deletes: the whole record is kept, and the deletion logged
    schema.pre("deleteOne", { document: true, query: false }, async function auditDeleteDoc() {
      const session = this.$session();
      const data = this.toObject();
      await keepDeleted(entity, [data], session);
      await writeLog(entity, action("DELETED"), { before: data, ignore, session });
    });
    schema.pre(QUERY_DELETES, { document: false, query: true }, async function auditDeleteOne() {
      const session = sessionOf(this);
      const doc = await withSession(this.model.findOne(this.getFilter()).lean(), session);
      if (!doc) return;
      await keepDeleted(entity, [doc], session);
      await writeLog(entity, action("DELETED"), { before: doc, ignore, session });
    });
    schema.pre("deleteMany", { document: false, query: true }, async function auditDeleteMany() {
      const session = sessionOf(this);
      const docs = await withSession(this.model.find(this.getFilter()).limit(MAX_BULK_COPY + 1).lean(), session);
      if (!docs.length) return;
      if (docs.length > MAX_BULK_COPY) {
        await writeLog(entity, action("DELETED"), { doc: docs[0], ignore, session, summary: `More than ${MAX_BULK_COPY} ${entity} records deleted at once` });
        return;
      }
      await keepDeleted(entity, docs, session);
      for (const d of docs) await writeLog(entity, action("DELETED"), { before: d, ignore, session });
    });
  }
}

module.exports = auditPlugin;
module.exports.labelOf = labelOf;
