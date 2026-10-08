// A guard on the models themselves: every schema that carries `companyId` must carry the tenant plugin,
// or it is a collection that mixes organisations the day a second one exists. This is what makes "add a
// tenanted model and forget the plugin" fail in CI instead of in production.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

(function load(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) load(p);
    else if (p.endsWith(".js")) require(path.resolve(p));
  }
})(path.resolve(__dirname, "..", "..", "models"));

// Models that carry companyId but are NOT yet scoped, each with the reason. When a row here is fixed the
// test below fails until it is removed, so the list can only shrink.
const NOT_YET = {}; // empty: every model that carries companyId is scoped. Keep the mechanism for the next awkward one.

// The ONLY unique indexes that are deliberately global, each with the reason. Everything else that is unique must
// be unique WITHIN an organisation, or a second organisation could not use the same invoice number, SKU or TRN.
const GLOBAL_UNIQUE = {
  Admin: { email: "one person belongs to one organisation, so sign-in needs no organisation picker" },
  Organisation: { code: "the registry of organisations: its code is the companyId" },
  Attachment: { key: "a random server-generated storage path, not something a person chooses" },
  PlatformUser: { email: "the developer console's own people belong to no organisation at all: their own collection, their own sign-in" },
  ShareLink: { publicId: "the public selector of a link: the public reader finds its row by it, with no organisation known" },
};

const tenanted = () => mongoose.modelNames().map((n) => mongoose.model(n)).filter((m) => m.schema.path("companyId"));

test("every model that carries companyId also carries the tenant plugin", () => {
  const missing = tenanted().filter((m) => !m.schema.options.tenantScoped && !NOT_YET[m.modelName]).map((m) => m.modelName);
  assert.deepEqual(missing, [], `these models have companyId but no tenantPlugin: ${missing.join(", ")}`);
});

test("the list of exceptions cannot go stale", () => {
  for (const name of Object.keys(NOT_YET)) {
    const model = mongoose.models[name];
    assert.ok(model, `${name} is listed as an exception but is not a model`);
    assert.equal(!!model.schema.options.tenantScoped, false, `${name} is now scoped: remove it from NOT_YET`);
  }
});

test("a scoped model must require companyId and never default it, or a missing stamp would pass silently", () => {
  for (const model of tenanted().filter((m) => m.schema.options.tenantScoped)) {
    const { options } = model.schema.path("companyId");
    assert.ok(options.required, `${model.modelName}.companyId must be required`);
    assert.equal(options.default, undefined, `${model.modelName}.companyId must have no default`);
  }
});

test("there are a known number of scoped models, so a quiet drop is noticed", () => {
  const scoped = tenanted().filter((m) => m.schema.options.tenantScoped).length;
  assert.ok(scoped >= 50, `expected at least 50 scoped models, found ${scoped}`);
});

test("every unique index is unique WITHIN an organisation, except the few that are global on purpose", () => {
  const leaks = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    for (const [keys, options] of model.schema.indexes()) {
      if (!options || !options.unique) continue;
      const fields = Object.keys(keys);
      if (fields[0] === "companyId") continue;
      const reason = GLOBAL_UNIQUE[name] && fields.length === 1 && GLOBAL_UNIQUE[name][fields[0]];
      if (!reason) leaks.push(`${name} ${JSON.stringify(keys)}`);
    }
  }
  assert.deepEqual(leaks, [], `these unique indexes are global, so two organisations would collide on them: ${leaks.join("; ")}`);
});

test("every deliberately global unique index still exists, so the list cannot go stale", () => {
  for (const [name, fields] of Object.entries(GLOBAL_UNIQUE)) {
    const model = mongoose.models[name];
    assert.ok(model, `${name} is listed but is not a model`);
    const have = model.schema.indexes().filter(([, o]) => o && o.unique).map(([k]) => Object.keys(k)[0]);
    for (const field of Object.keys(fields)) assert.ok(have.includes(field), `${name}.${field} is listed as globally unique but is not`);
  }
});
