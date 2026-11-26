// What a barcode may be (utils/barcodes.js, pure). node --test utils/__tests__/barcodes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanBarcode, MAX_LENGTH } = require("../barcodes");

test("a barcode is trimmed text; nothing given is a blank, never an error", () => {
  assert.deepEqual(cleanBarcode(" 6291041500213 "), { value: "6291041500213" });
  assert.deepEqual(cleanBarcode(6291041500213), { value: "6291041500213" }, "a spreadsheet's number keeps its digits");
  for (const none of [undefined, null, "", "   "]) assert.deepEqual(cleanBarcode(none), { value: "" });
  assert.deepEqual(cleanBarcode("Ab-12/x"), { value: "Ab-12/x" }, "case and punctuation are kept: a code is matched exactly");
});

test("anything a scanner cannot have typed is refused with a sentence", () => {
  assert.ok(cleanBarcode("x".repeat(MAX_LENGTH + 1)).error);
  assert.deepEqual(cleanBarcode("x".repeat(MAX_LENGTH)), { value: "x".repeat(MAX_LENGTH) });
  assert.ok(cleanBarcode("12\n34").error);
  assert.ok(cleanBarcode("12\t34").error);
  for (const odd of [{ $ne: "x" }, ["1"], true]) assert.ok(cleanBarcode(odd).error, JSON.stringify(odd));
});
