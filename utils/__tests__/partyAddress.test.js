const test = require("node:test");
const assert = require("node:assert/strict");
const { EMIRATES, resolveAddress, emirateOf } = require("../partyAddress");

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test("the seven emirates, in the words the VAT return uses", () => {
  assert.deepEqual(EMIRATES, ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"]);
  assert.equal(emirateOf("  ras al  khaimah "), "Ras Al Khaimah");
  assert.equal(emirateOf("Riyadh"), null);
});

test("a request that names neither country nor emirate changes nothing", () => {
  assert.equal(resolveAddress({}, undefined), null);
  assert.equal(resolveAddress({ country: undefined, emirate: undefined }, { country: "AE", emirate: "Dubai" }), null);
});

test("the UAE needs one of the seven emirates, and the case is tidied", () => {
  assert.deepEqual(resolveAddress({ country: "ae", emirate: "dubai" }), { country: "AE", emirate: "Dubai" });
  assert.equal(code(() => resolveAddress({ country: "AE" })), "INVALID_EMIRATE");
  assert.equal(code(() => resolveAddress({ country: "AE", emirate: "Riyadh" })), "INVALID_EMIRATE");
});

test("any other country has no emirate, whatever was sent", () => {
  assert.deepEqual(resolveAddress({ country: "IN", emirate: "Dubai" }), { country: "IN", emirate: null });
  assert.equal(code(() => resolveAddress({ country: "India" })), "INVALID_COUNTRY");
});

test("an edit that sends only the emirate is judged against the stored country", () => {
  assert.deepEqual(resolveAddress({ emirate: "Sharjah" }, { country: "AE", emirate: "Dubai" }), { country: "AE", emirate: "Sharjah" });
  assert.deepEqual(resolveAddress({ emirate: "Sharjah" }, { country: "IN" }), { country: "IN", emirate: null });
  // only the country sent, and still the UAE: the stored emirate stays
  assert.deepEqual(resolveAddress({ country: "AE" }, { country: "AE", emirate: "Ajman" }), { country: "AE", emirate: "Ajman" });
});
