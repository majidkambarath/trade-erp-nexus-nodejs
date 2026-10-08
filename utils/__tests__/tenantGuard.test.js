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
const NOT_YET = {
  InventoryMovement: "companyId is nullable and no write path ever set it, so every existing row is unassigned; it joins once those rows are back-filled",
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
  assert.ok(scoped >= 32, `expected at least 32 scoped models, found ${scoped}`);
});
