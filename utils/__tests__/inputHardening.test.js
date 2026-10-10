// The two small pieces of input hardening the security sweeps led to, tested without a server:
//   - middleware/sanitizeInput.js  drops __proto__ / constructor / prototype / $operator keys from a request body
//   - utils/regex.js               text typed into a search box is text to find, never a pattern to run
// (The sweeps in services/__tests__/{tenantBleed,massAssignment}Http.test.js prove the same over HTTP against the real routes.)
const test = require("node:test");
const assert = require("node:assert/strict");
const sanitizeInput = require("../../middleware/sanitizeInput");
const { escapeRegex, searchRegex } = require("../regex");

test("a body loses __proto__, constructor, prototype and $operator keys at any depth, and keeps everything else", () => {
  // JSON.parse makes "__proto__" an OWN key (an object literal would set the prototype instead): this is what arrives from the wire
  const body = JSON.parse('{"name":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"$set":{"name":"y"},"items":[{"qty":1,"$ne":2,"deep":{"__proto__":{"a":1},"keep":true}}],"profile":{"legalName":"z","prototype":{}}}');
  assert.deepEqual(Object.keys(body).sort(), ["$set", "__proto__", "constructor", "items", "name", "profile"].sort());
  const dropped = sanitizeInput.clean(body);
  assert.equal(dropped, 6);
  assert.deepEqual(body, { name: "x", items: [{ qty: 1, deep: { keep: true } }], profile: { legalName: "z" } });
  assert.equal({}.polluted, undefined, "nothing reached Object.prototype");
});

test("the middleware cleans req.body and calls next; a body that is not an object is left alone", () => {
  let called = 0;
  const req = { body: JSON.parse('{"a":1,"$where":"1"}') };
  sanitizeInput(req, {}, () => called++);
  assert.deepEqual(req.body, { a: 1 });
  assert.equal(called, 1);
  for (const body of [undefined, null, "text", 5, []]) {
    sanitizeInput({ body }, {}, () => called++);
  }
  assert.equal(called, 6);
});

test("a body that points back at itself does not hang the cleaner", () => {
  const body = { a: { b: {} } };
  body.a.b.again = body;
  body.a.$x = 1;
  assert.equal(sanitizeInput.clean(body), 1);
});

test("a very deep body is cleaned without a stack overflow", () => {
  let deep = { $bad: 1 };
  for (let i = 0; i < 20000; i++) deep = { child: deep };
  assert.equal(sanitizeInput.clean(deep), 1);
});

test("escapeRegex neutralises every regular-expression metacharacter", () => {
  const nasty = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
  const re = new RegExp(`^${escapeRegex(nasty)}$`);
  assert.ok(re.test(nasty), "the text matches itself, literally");
  assert.ok(!re.test("axb"), "and not as a pattern");
});

test("searchRegex never throws and never runs what was typed", () => {
  for (const typed of ["[", "(", "\\", "*", "+", "?", "{1,", "(?<=", "a{1000000}", "(a+)+$", "(.*)*(.*)*x"]) {
    const re = searchRegex(typed);
    assert.ok(re instanceof RegExp, typed);
    assert.ok(re.test(`before ${typed} after`), `${typed} is found as text`);
  }
  // a catastrophic pattern, typed as text, matches in no time against the text it would have exploded on
  const started = Date.now();
  searchRegex("(a+)+$").test("a".repeat(5000) + "!");
  assert.ok(Date.now() - started < 200, "no backtracking blow-up");
  // case-insensitive "contains"
  assert.ok(searchRegex("rice").test("Basmati RICE 5kg"));
  // an object (what ?search[$ne]=x or a JSON body can produce) is searched for as plain text, never as an operator
  assert.equal(searchRegex({ $ne: "x" }).source, "\\[object Object\\]");
  assert.equal(searchRegex(undefined).source, "(?:)");
  // a very long term is capped
  assert.ok(searchRegex("x".repeat(5000)).source.length <= 100);
});

test("logging a request's query (an object with no prototype) does not throw inside the request", () => {
  const logger = require("../logger");
  const before = { level: process.env.LOG_LEVEL, silent: process.env.LOG_SILENT };
  process.env.LOG_LEVEL = "debug";
  process.env.LOG_SILENT = "true"; // nothing is printed, but the line is still built only when logging is on: force it on for the call below
  try {
    assert.doesNotThrow(() => logger.debug(Object.assign(Object.create(null), { search: "x" })));
    process.env.LOG_SILENT = "false";
    const lines = [];
    const original = console.log;
    console.log = (l) => lines.push(l);
    try { logger.debug(Object.assign(Object.create(null), { search: "x" })); } finally { console.log = original; }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /search: 'x'/);
  } finally {
    if (before.level === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = before.level;
    if (before.silent === undefined) delete process.env.LOG_SILENT; else process.env.LOG_SILENT = before.silent;
  }
});
