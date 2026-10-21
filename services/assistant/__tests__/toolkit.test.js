// The three things Zarvia AI can do. Pure: no database, no model, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const toolkit = require("../toolkit");

const POOL = [
  { id: "t1", title: "Order to cash", source: "", screens: ["/sales-order"], tags: [], review: "",
    questions: ["how do I raise an invoice"], body: "Price the order, then approve it." },
  { id: "t2", title: "Customers and vendors", source: "", screens: ["/customers"], tags: [], review: "",
    questions: ["how do I add a customer"], body: "A customer carries a credit limit and contacts." },
];

test("there is no tool that reads a client's books, and this file performs no query", () => {
  assert.deepEqual(toolkit.definitions().map((d) => d.name), ["search_help", "open_screen", "ask_support"]);
  const src = fs.readFileSync(path.join(__dirname, "..", "toolkit.js"), "utf8");
  for (const forbidden of ["findOne", "aggregate(", "countDocuments", "updateOne", "insertMany", "mongoose"]) {
    assert.ok(!src.includes(forbidden), `the toolkit uses ${forbidden}`);
  }
});

test("every tool is strict, closed, and takes no identifier it must not", () => {
  for (const d of toolkit.definitions()) {
    assert.equal(d.strict, true, `${d.name} is not strict`);
    assert.equal(d.input_schema.additionalProperties, false, `${d.name} accepts extra properties`);
    assert.ok(d.input_schema.required.length, `${d.name} requires nothing`);
    assert.ok(d.description.length > 60, `${d.name} is barely described`);
    const schema = JSON.stringify(d.input_schema);
    assert.doesNotMatch(schema, /customer|party|company|branch|tenant/i, `${d.name} takes an identifier it must not`);
  }
});

test("the screens it may link to come from the documentation, not a list kept by hand", () => {
  const fromPool = toolkit.allowedScreens({ topics: POOL });
  assert.ok(fromPool.includes("/sales-order") && fromPool.includes("/customers"));
  assert.ok(toolkit.allowedScreens().includes("/accounting-setup"), "a refusal's screens count too");
  assert.deepEqual(fromPool, [...fromPool].sort(), "the list must be stable, so prompts cache");
});

test("search_help answers from the corpus, and says plainly when it has nothing", () => {
  const ctx = toolkit.newContext({ topics: POOL });
  const hit = toolkit.run("search_help", { question: "how do I add a customer" }, ctx);
  assert.equal(hit.ok, true);
  assert.equal(hit.data.topics[0].title, "Customers and vendors");
  const miss = toolkit.run("search_help", { question: "how do I set up production" }, ctx);
  assert.equal(miss.ok, true, "nothing found is a result, not an error");
  assert.equal(miss.data.found, 0);
  assert.match(miss.data.note, /Do not answer it from anything else you know/);
  assert.equal(toolkit.run("search_help", {}, ctx).ok, false);
});

test("open_screen refuses a path the documentation does not name, and says which it would take", () => {
  const ctx = toolkit.newContext({ topics: POOL });
  const good = toolkit.run("open_screen", { path: "/customers", label: "Open customers" }, ctx);
  assert.equal(good.ok, true);
  assert.deepEqual(ctx.links, [{ path: "/customers", label: "Open customers" }]);
  const bad = toolkit.run("open_screen", { path: "/pay-me-here", label: "Click" }, ctx);
  assert.equal(bad.ok, false, "an invented path must never become a link");
  assert.match(bad.error, /\/customers/, "it is told what it may use instead");
  assert.equal(ctx.links.length, 1, "the refused path was not recorded");
});

test("ask_support records the hand-over once, and a tool that throws does not take the answer down", () => {
  const ctx = toolkit.newContext({ topics: POOL });
  const first = toolkit.run("ask_support", { summary: "Cannot post to August", question: "why is it closed" }, ctx);
  assert.equal(first.data.passedOn, true);
  assert.equal(ctx.escalation.summary, "Cannot post to August");
  const again = toolkit.run("ask_support", { summary: "Again", question: "again" }, ctx);
  assert.equal(again.data.alreadyPassedOn, true, "one hand-over per question");
  assert.equal(ctx.escalation.summary, "Cannot post to August", "the first one stands");
  assert.equal(toolkit.run("ask_support", { summary: "only this" }, ctx).ok, false);
  assert.equal(toolkit.run("no_such_tool", {}, ctx).ok, false);
  assert.equal(toolkit.run("search_help", null, ctx).ok, false, "a null input must not throw");
});
