const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../orgLocale");
const { runWithTenant } = require("../tenantContext");

test.afterEach(() => { L.forget(); L.useLoader(null); });

test("outside any scope it is what the whole system assumed until now: AED and Asia/Dubai", () => {
  assert.deepEqual(L.current(), { baseCurrency: "AED", timezone: "Asia/Dubai", country: "AE" });
  assert.equal(L.baseCurrency(), "AED");
  assert.equal(L.timezone(), "Asia/Dubai");
});

test("an organisation that is known reads as its own, inside its scope and only there", () => {
  L.warm({ code: "mumbai", baseCurrency: "inr", timezone: "Asia/Kolkata", country: "in" });
  L.warm({ code: "london", baseCurrency: "GBP", timezone: "Europe/London", country: "GB" });
  runWithTenant({ companyId: "mumbai", branchId: "main" }, () => {
    assert.deepEqual(L.current(), { baseCurrency: "INR", timezone: "Asia/Kolkata", country: "IN" }, "tidied: upper case");
    assert.equal(L.baseCurrency(), "INR");
  });
  runWithTenant({ companyId: "london", branchId: "main" }, () => assert.equal(L.baseCurrency(), "GBP"));
  assert.equal(L.baseCurrency(), "AED", "and nothing leaks out of the scope");
});

test("a bad zone or a blank currency never breaks a read: the default stands in for that part", () => {
  L.warm({ code: "odd", baseCurrency: "  ", timezone: "Nowhere/Land", country: "" });
  runWithTenant({ companyId: "odd", branchId: "main" }, () => assert.deepEqual(L.current(), { baseCurrency: "AED", timezone: "Asia/Dubai", country: "AE" }));
});

test("the day helpers use the zone of the organisation in scope", () => {
  L.warm({ code: "mumbai", baseCurrency: "INR", timezone: "Asia/Kolkata", country: "IN" });
  const instant = new Date("2026-10-08T19:00:00Z"); // 00:30 on the 9th in Kolkata, 23:00 on the 8th in London
  runWithTenant({ companyId: "mumbai", branchId: "main" }, () => {
    assert.equal(L.dayOf(instant), "2026-10-09");
    assert.equal(L.today(instant), "2026-10-09");
    assert.equal(L.dayStart("2026-10-09").toISOString(), "2026-10-08T18:30:00.000Z");
    assert.equal(L.dayEnd("2026-10-09").toISOString(), "2026-10-09T18:30:00.000Z");
    assert.equal(L.yearOf(new Date("2026-12-31T19:00:00Z")), 2027);
  });
  assert.equal(L.dayOf(instant), "2026-10-08", "outside, Dubai: 23:00 on the 8th");
});

test("an organisation not yet loaded reads as the default for that moment and is loaded in the background", async () => {
  const asked = [];
  L.useLoader(async (code) => { asked.push(code); return { baseCurrency: "GBP", timezone: "Europe/London", country: "GB" }; });
  runWithTenant({ companyId: "newco", branchId: "main" }, () => assert.equal(L.baseCurrency(), "AED", "this one read had nothing else to go on"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, ["newco"]);
  runWithTenant({ companyId: "newco", branchId: "main" }, () => assert.equal(L.baseCurrency(), "GBP", "and the next read has it"));
});

test("a loader that fails changes nothing and throws nothing", async () => {
  L.useLoader(async () => { throw new Error("registry down"); });
  runWithTenant({ companyId: "x", branchId: "main" }, () => assert.equal(L.timezone(), "Asia/Dubai"));
  await new Promise((r) => setTimeout(r, 20));
  runWithTenant({ companyId: "x", branchId: "main" }, () => assert.equal(L.timezone(), "Asia/Dubai"));
});

test("forgetting an organisation makes the next read load it again", () => {
  L.warm({ code: "mumbai", baseCurrency: "INR", timezone: "Asia/Kolkata", country: "IN" });
  L.forget("mumbai");
  runWithTenant({ companyId: "mumbai", branchId: "main" }, () => assert.equal(L.baseCurrency(), "AED"));
});
