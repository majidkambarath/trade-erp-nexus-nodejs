const test = require("node:test");
const assert = require("node:assert/strict");
const { ONBOARDING_ITEMS, EXIT_ITEMS, standardItems, validateAppraisal } = require("../talent");

test("standardItems returns the onboarding list, the exit list, or null for anything else", () => {
  assert.deepEqual(standardItems("onboarding"), [...ONBOARDING_ITEMS]);
  assert.deepEqual(standardItems("exit"), [...EXIT_ITEMS]);
  assert.equal(standardItems("made-up"), null);
  assert.equal(standardItems(undefined), null);
});

test("standardItems returns a COPY, not the frozen original - a caller editing its array cannot mutate the standard list", () => {
  const items = standardItems("onboarding");
  items.push("Hostile addition");
  assert.equal(ONBOARDING_ITEMS.includes("Hostile addition"), false, "the shared constant is untouched");
  assert.equal(standardItems("onboarding").includes("Hostile addition"), false, "a fresh call still returns the real list");
});

test("an appraisal needs a period, a real review day, and at least one filled field", () => {
  assert.ok(validateAppraisal({}).length > 0, "nothing at all is refused");
  assert.ok(
    validateAppraisal({ periodLabel: "2026 annual", reviewDate: "2026-11-07" }).some((e) => e.code === "APPRAISAL_EMPTY"),
    "a period and a date with nothing SAID is still refused - an appraisal records something"
  );
  assert.deepEqual(validateAppraisal({ periodLabel: "2026 annual", reviewDate: "2026-11-07", rating: "Meets expectations" }), []);
  assert.deepEqual(validateAppraisal({ periodLabel: "2026 annual", reviewDate: "2026-11-07", strengths: "Reliable and on time" }), []);
});

test("a made-up review date is refused, a real one is not", () => {
  const errs = validateAppraisal({ periodLabel: "2026 annual", reviewDate: "not-a-day", rating: "Good" });
  assert.ok(errs.some((e) => e.code === "INVALID_REVIEW_DATE"));
});
