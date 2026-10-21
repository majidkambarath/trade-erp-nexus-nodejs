// The refusal table Zarvia AI explains from. Pure: no database, no server.
//
// The test that matters most is the last one: every code in the table must actually be thrown
// somewhere in this codebase. A table that explains a code the API never sends is worse than no
// table, because the explanation reads as authoritative and will never be corrected by anybody
// hitting it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const codes = require("../assistantCodes");

const ROOT = path.join(__dirname, "..", "..");
const WHO = ["self", "administrator", "support"];

test("every entry says what happened, why, what to do and who can do it", () => {
  for (const [code, e] of Object.entries(codes.CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/, `${code} is not shaped like an error code`);
    // a label is a short name for what happened ("You were signed out"); why and fix have to
    // carry real substance, so they are held to a longer minimum.
    assert.ok(typeof e.label === "string" && e.label.trim().length > 10, `${code}.label`);
    for (const field of ["why", "fix"]) {
      assert.equal(typeof e[field], "string", `${code}.${field}`);
      assert.ok(e[field].trim().length > 20, `${code}.${field} is too short to help anybody`);
    }
    assert.ok(WHO.includes(e.who), `${code}.who is ${e.who}`);
    assert.ok(Array.isArray(e.asked) && e.asked.length, `${code} says nothing about how it is asked`);
    for (const s of e.screens || []) assert.match(s, /^\/[a-z0-9-/]*$/, `${code} screen ${s}`);
  }
});

test("a code is defined once: the groups are spread into one object and a repeat would be lost", () => {
  const src = fs.readFileSync(path.join(ROOT, "utils", "assistantCodes.js"), "utf8");
  const declared = [...src.matchAll(/^  ([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
  assert.equal(declared.length, Object.keys(codes.CODES).length, "a group key was silently overwritten");
  assert.equal(new Set(declared).size, declared.length, "a code is declared twice");
});

test("nothing in the table names a file, a service or a test: a client reads these words", () => {
  const all = Object.entries(codes.CODES)
    .map(([c, e]) => [c, e.label, e.why, e.fix, ...(e.asked || [])].join(" "))
    .join("\n");
  assert.doesNotMatch(all, /\.js\b|__tests__|[a-z]+Service\b|\.test\./, "the table names code");
});

test("an unknown code falls back to the server's own message instead of guessing", () => {
  const out = codes.explain("SOMETHING_NEW", { serverMessage: "Posting is closed up to 31 Aug 2026" });
  assert.equal(out.known, false);
  assert.equal(out.serverMessage, "Posting is closed up to 31 Aug 2026");
  assert.equal(out.why, undefined, "an unknown code must carry no explanation at all");
  assert.equal(codes.summary("SOMETHING_NEW"), "");
  assert.equal(codes.explain(undefined).code, null);
});

test("a known code carries the server's message through: it holds the specifics", () => {
  const out = codes.explain("PERIOD_CLOSED", { serverMessage: "Posting is closed up to 31 Aug 2026" });
  assert.equal(out.known, true);
  assert.equal(out.who, "administrator");
  assert.equal(out.whoText, codes.WHO.administrator);
  assert.equal(out.serverMessage, "Posting is closed up to 31 Aug 2026");
  assert.ok(codes.summary("PERIOD_CLOSED").startsWith("PERIOD_CLOSED: "));
});

test("the questions people ask are unique, so retrieval cannot score one code twice", () => {
  const qs = codes.allQuestions();
  assert.ok(qs.length > 50, `only ${qs.length} phrasings`);
  const seen = new Map();
  for (const { code, question } of qs) {
    // matched case-insensitively at retrieval time, so "VAT return" and "vat return" are one key
    const key = question.toLowerCase();
    assert.ok(!seen.has(key), `"${question}" is claimed by ${seen.get(key)} and ${code}`);
    seen.set(key, code);
  }
});

test("every code in the table is really thrown by this codebase", () => {
  const dirs = ["utils", "services", "middleware", "controllers", "models", "routes"];
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__tests__") walk(p);
      } else if (entry.name.endsWith(".js")) files.push(p);
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  const haystack = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const missing = Object.keys(codes.CODES).filter((c) => !haystack.includes(`"${c}"`) && !haystack.includes(`'${c}'`));
  assert.deepEqual(missing, [], "these codes are explained but never sent, so the explanation can never be corrected");
});
