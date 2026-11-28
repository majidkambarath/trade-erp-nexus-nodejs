// The onboarding form's rules, without a database: what may be stored, what stops a submit, and what is written into the
// organisation made from it.
const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../clientOnboarding");

// A complete UAE form: every rule below changes one thing about it.
const complete = () => ({
  company: {
    legalName: "Gulf Fresh Trading LLC", tradeName: "Gulf Fresh", country: "AE", emirate: "dubai",
    addressLine1: "Warehouse 4, Al Quoz 3", city: "Dubai", phone: "+971501234567", email: "Accounts@GulfFresh.ae",
    taxRegistered: "yes", taxNumber: "100 1234 5678 9012", taxRegisteredFrom: "2024-01-01",
    bankName: "Emirates NBD", iban: "AE07 0331 2345 6789 0123 456", swift: "EBILAEAD",
  },
  business: { baseCurrency: "aed", fiscalYearStart: 1, businessType: "distribution", sells: "goods", modules: ["sales", "purchase", "inventory", "vansales"] },
  people: {
    admin: { name: "Omar Hassan", email: "omar@gulffresh.ae", mobile: "+971501112222" },
    users: [{ name: "Ravi", email: "ravi@gulffresh.ae", role: "van_salesman" }],
  },
  goLive: { goLiveDate: "2027-01-01", customersCount: "120" },
});

test("only known answers are kept, each in its own type and length", () => {
  const a = rules.normaliseAnswers({
    company: { legalName: "  A".padEnd(300, "x"), country: "ae", emirate: "SHARJAH", extra: "dropped", taxRegistered: "maybe", phone: { $ne: null } },
    business: { modules: ["sales", "sales", "made-up", 7], fiscalYearStart: "13", baseCurrency: "dirham" },
    people: { users: Array.from({ length: 80 }, (_, i) => ({ name: `P${i}`, role: "super_admin" })) },
    goLive: { goLiveDate: "2027-02-30", itemsCount: -4 },
    hacker: { $where: "1" },
  });
  assert.equal(a.company.legalName.length, 100);
  assert.equal(a.company.country, "AE");
  assert.equal(a.company.emirate, "Sharjah", "an emirate is stored in its own spelling");
  assert.equal(a.company.extra, undefined);
  assert.equal(a.company.taxRegistered, "", "a choice outside its set is dropped");
  assert.equal(a.company.phone, "", "an object is never text");
  assert.deepEqual(a.business.modules, ["sales"], "unknown parts dropped, repeats once");
  assert.equal(a.business.fiscalYearStart, null);
  assert.equal(a.business.baseCurrency, "");
  assert.equal(a.people.users.length, rules.LIMITS.users);
  assert.equal(a.people.users[0].role, "", "nobody is made an Owner from the form");
  assert.equal(a.goLive.goLiveDate, "", "31 February is not a day");
  assert.equal(a.goLive.itemsCount, null);
  assert.equal(a.hacker, undefined);
  assert.deepEqual(Object.keys(a), ["company", "business", "people", "goLive"]);
});

test("nothing given is a whole form of empty answers, never an error", () => {
  for (const input of [undefined, null, "text", 42, [], { company: "x", people: [1] }]) {
    const a = rules.normaliseAnswers(input);
    assert.equal(a.company.legalName, "");
    assert.deepEqual(a.people.users, []);
  }
});

test("a complete form has nothing missing", () => {
  assert.deepEqual(rules.issuesOf(complete(), { currencies: ["AED", "INR"] }), []);
  assert.equal(rules.progressOf(complete()).percent, 100);
});

test("an empty form names every required answer, in the client's words", () => {
  const issues = rules.issuesOf({});
  const fields = issues.map((i) => `${i.section}.${i.field}`);
  for (const f of ["company.legalName", "company.country", "company.addressLine1", "company.city", "company.phone", "company.email", "company.taxRegistered", "business.baseCurrency", "business.fiscalYearStart", "business.sells", "business.modules", "people.admin.name", "people.admin.email", "people.admin.mobile", "goLive.goLiveDate"]) {
    assert.ok(fields.includes(f), `${f} should be asked for`);
  }
  assert.ok(issues.every((i) => i.message.length > 10));
  assert.equal(rules.progressOf({}).percent, 0);
});

test("the tax number follows the country: a UAE TRN, an Indian GSTIN", () => {
  const uae = complete();
  uae.company.taxNumber = "12345";
  assert.deepEqual(rules.issuesOf(uae).map((i) => i.field), ["taxNumber"]);

  const india = complete();
  Object.assign(india.company, { country: "IN", emirate: "", stateCode: "", taxNumber: "27ABCDE1234F1Z5", iban: "" });
  assert.deepEqual(rules.issuesOf(india).map((i) => i.field), ["stateCode"], "India needs its state, not an emirate");
  india.company.stateCode = "27";
  assert.deepEqual(rules.issuesOf(india), []);

  const none = complete();
  Object.assign(none.company, { taxRegistered: "no", taxNumber: "", taxRegisteredFrom: "" });
  assert.deepEqual(rules.issuesOf(none), [], "a company that is not registered gives no number");
});

test("a wrong IBAN, a duplicate email and a van salesman without van sales are each caught", () => {
  const a = complete();
  a.company.iban = "AE07 0331 2345 6789 0123 457";
  a.people.users.push({ name: "Twin", email: "OMAR@gulffresh.ae", role: "viewer" });
  a.business.modules = ["sales"];
  const issues = rules.issuesOf(a);
  assert.ok(issues.some((i) => i.field === "iban"));
  assert.ok(issues.some((i) => i.field === "users.1.email" && /already used/.test(i.message)));
  assert.ok(issues.some((i) => i.field === "users.0.role" && /Van sales/.test(i.message)));
});

test("a currency the books cannot keep is refused when the list is known", () => {
  const a = complete();
  a.business.baseCurrency = "KWD";
  assert.deepEqual(rules.issuesOf(a, { currencies: ["AED"] }).map((i) => i.field), ["baseCurrency"]);
  assert.deepEqual(rules.issuesOf(a), [], "without the list, any three letters pass (the console checks again)");
});

test("the letterhead patch carries what the client gave, in the profile service's own field names", () => {
  const patch = rules.toProfilePatch(complete());
  assert.equal(patch.companyName, "Gulf Fresh Trading LLC");
  assert.equal(patch.state, "Dubai");
  assert.equal(patch.emailAddress, "accounts@gulffresh.ae");
  assert.equal(patch.bankDetails.bankName, "Emirates NBD");
  assert.equal(patch.bankDetails.swiftCode, "EBILAEAD");
  assert.equal(patch.bankDetails.currency, "AED");
  assert.equal(patch.website, undefined, "a blank answer is not written over anything");
});

test("the settings patch carries the tax identity and the year's first month", () => {
  const s = rules.toSettingsPatch(complete());
  assert.deepEqual(s.profile, { emirate: "Dubai", trn: "100123456789012", vatRegistered: true, vatRegisteredFrom: "2024-01-01" });
  assert.equal(s.fiscalYearStartMonth, 1);

  const india = complete();
  Object.assign(india.company, { country: "IN", emirate: "", stateCode: "", taxNumber: "29abcde1234f1z5" });
  india.business.fiscalYearStart = 4;
  const si = rules.toSettingsPatch(india);
  assert.equal(si.profile.stateCode, "29", "an Indian company's state comes from its GSTIN when not chosen");
  assert.equal(si.profile.trn, "29ABCDE1234F1Z5");
  assert.equal(si.fiscalYearStartMonth, 4);

  const none = complete();
  none.company.taxRegistered = "no";
  assert.equal(rules.toSettingsPatch(none).profile.vatRegistered, false);
  assert.equal(rules.toSettingsPatch({}), null);
});

test("each upload slot takes only its own kinds of file", () => {
  assert.equal(rules.fileAllowed("customers", "Customers List.XLSX"), ".xlsx");
  assert.equal(rules.fileAllowed("customers", "customers.pdf"), null);
  assert.equal(rules.fileAllowed("tradeLicence", "licence.pdf"), ".pdf");
  assert.equal(rules.fileAllowed("logo", "logo.svg"), null, "an SVG can carry a script");
  assert.equal(rules.fileAllowed("logo", "no-ending"), null);
  assert.equal(rules.fileAllowed("made-up", "a.csv"), null);
});
