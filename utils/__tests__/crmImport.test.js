// Reading a spreadsheet into the CRM: every awkward cell is a case here, so none of them is a support call.
const test = require("node:test");
const assert = require("node:assert/strict");
const imp = require("../crmImport");

const ID = "a".repeat(24);
const held = (emails = [], phones = []) => ({ emails: new Set(emails), phones: new Set(phones) });
const plan = (rows, opts) => imp.planLeadImport(rows, opts);
const statuses = (p) => p.rows.map((r) => r.status);

// ---- amounts, sources, numbers ----------------------------------------------------------------------------------

test("an amount is read the way people type it", () => {
  const read = (v) => imp.moneyFrom(v).value;
  assert.equal(read("12500"), 12500);
  assert.equal(read("AED 12,500.50"), 12500.5, "a currency word and grouping commas");
  assert.equal(read("12 500"), 12500, "a space as the thousands separator");
  assert.equal(read("1,20,000"), 120000, "lakh grouping");
  assert.equal(read("₹1,20,000"), 120000, "a currency symbol");
  assert.equal(read("12,50"), 12.5, "one comma and two digits is a decimal comma");
  assert.equal(read("1.234.567"), 1234567, "dots as grouping");
  assert.equal(read("1,234.56"), 1234.56);
  assert.equal(read("1.234,56"), 1234.56, "whichever separator comes last is the decimal point");
  assert.equal(read(12.345), 12.35, "a number is rounded to two places");
  assert.equal(read(""), 0, "a blank cell is nothing, which is zero");
  assert.equal(imp.moneyFrom("").ok, true, "and not a mistake");
  assert.equal(imp.moneyFrom("lots").ok, false, "text with no number in it is");
  assert.equal(imp.moneyFrom({ $ne: 1 }).ok, true, "an object reads as blank: the row is judged on its other fields");
  assert.equal(imp.moneyFrom("-5").value, -5, "a negative is kept, so the lead rules can refuse it by name");
});

test("a source is whichever of ours the word means, and a word we do not know is kept, not lost", () => {
  const src = (v) => imp.sourceFrom(v);
  assert.deepEqual(src("Walk-in"), { source: "walk_in", note: "" });
  assert.deepEqual(src("walk_in"), { source: "walk_in", note: "" }, "our own key works too");
  assert.deepEqual(src("WhatsApp"), { source: "whatsapp", note: "" });
  assert.deepEqual(src("Phone Call"), { source: "phone", note: "" });
  assert.deepEqual(src("Trade show"), { source: "exhibition", note: "" });
  assert.deepEqual(src("Repeat customer"), { source: "repeat", note: "" });
  assert.deepEqual(src("LinkedIn"), { source: "other", note: "LinkedIn" }, "unknown: Other, with the original word in the note");
  assert.deepEqual(src(""), { source: "other", note: "" });
  assert.deepEqual(src(["x"]), { source: "other", note: "" }, "an array is not a word");
});

test("two spellings of one phone number share their last eight digits", () => {
  assert.equal(imp.phoneTail("+971 50 123 4567"), "01234567");
  assert.equal(imp.phoneTail("050-123-4567"), "01234567");
  assert.equal(imp.phoneTail("12345"), "", "too short to say anything about");
  assert.equal(imp.phoneTail(null), "");
});

// ---- leads ------------------------------------------------------------------------------------------------------

test("a good row is created, a bad one says what is wrong with it, and one bad row does not stop the others", () => {
  const p = plan([
    { name: "Ali Traders", phone: "+971 50 111 2222", source: "Walk-in", expectedValue: "AED 5,000", city: " Dubai " },
    { name: "", phone: "0501112233" },
    { name: "No way to reach", company: "X" },
    { name: "Bad value", email: "b@x.com", expectedValue: "lots" },
    { name: "Bad email", email: "not-an-email" },
    { name: "Fine", email: "fine@x.com" },
  ]);
  assert.deepEqual(statuses(p), ["create", "invalid", "invalid", "invalid", "invalid", "create"]);
  assert.deepEqual(p.summary, { total: 6, create: 2, invalid: 4, duplicate: 0, skipped: 0 });
  assert.equal(p.rows[0].fields.expectedValue, 5000);
  assert.equal(p.rows[0].fields.source, "walk_in");
  assert.equal(p.rows[0].fields.city, "Dubai", "cells are trimmed");
  assert.deepEqual(p.rows[1].errors.map((e) => e.code), ["LEAD_NAME_REQUIRED"]);
  assert.deepEqual(p.rows[2].errors.map((e) => e.code), ["LEAD_CONTACT_REQUIRED"]);
  assert.deepEqual(p.rows[3].errors.map((e) => e.code), ["LEAD_VALUE_INVALID"]);
  assert.deepEqual(p.rows[4].errors.map((e) => e.code), ["LEAD_EMAIL_INVALID"]);
});

test("a row is numbered the way the person's spreadsheet is: the header is line 1", () => {
  const p = plan([{ name: "A", phone: "0501112233" }, { name: "B", phone: "0502223344" }]);
  assert.deepEqual(p.rows.map((r) => r.line), [2, 3]);
  const q = plan([{ line: 41, name: "A", phone: "0501112233" }]);
  assert.equal(q.rows[0].line, 41, "the screen says which line of the file a row came from, even when it sends them in lots");
});

test("the same email or phone is a duplicate: of an earlier row, of a lead we hold, of a customer we hold", () => {
  const p = plan(
    [
      { name: "First", phone: "+971 50 123 4567", email: "ali@x.com" },
      { name: "Same phone, written differently", phone: "050-123-4567" },
      { name: "Same email, other case", email: "ALI@X.COM" },
      { name: "Already a lead", email: "lead@x.com" },
      { name: "Already a customer", email: "cust@x.com" },
      { name: "A customer by phone", phone: "0509998877" },
      { name: "New", email: "new@x.com" },
    ],
    { existing: { leads: held(["lead@x.com"]), customers: held(["cust@x.com"], ["09998877"]) } }
  );
  assert.deepEqual(statuses(p), ["create", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "create"]);
  assert.deepEqual(p.rows[1].duplicateOf, { kind: "file", line: 2, by: "phone" }, "it names the earlier row");
  assert.deepEqual(p.rows[2].duplicateOf, { kind: "file", line: 2, by: "email" });
  assert.deepEqual(p.rows[3].duplicateOf, { kind: "lead", by: "email" });
  assert.deepEqual(p.rows[4].duplicateOf, { kind: "customer", by: "email" });
  assert.deepEqual(p.rows[5].duplicateOf, { kind: "customer", by: "phone" });
  assert.equal(p.summary.duplicate, 5);
});

test("a refused row never claims the email an earlier good row did not", () => {
  const p = plan([
    { name: "", email: "x@x.com" }, // invalid: no name
    { name: "Good", email: "x@x.com" }, // must still be created: the invalid one claimed nothing
  ]);
  assert.deepEqual(statuses(p), ["invalid", "create"]);
});

test("a duplicate can be imported anyway, and still says what it duplicates", () => {
  const p = plan([{ name: "First", email: "a@x.com" }, { name: "Second", email: "a@x.com" }], { allowDuplicates: true });
  assert.deepEqual(statuses(p), ["create", "create"]);
  assert.deepEqual(p.rows[1].duplicateOf, { kind: "file", line: 2, by: "email" });
});

test("an owner is found by name, and one we cannot find is a warning, never a refusal", () => {
  const p = plan(
    [
      { name: "A", email: "a@x.com", owner: "  sara " },
      { name: "B", email: "b@x.com", owner: "Nobody Here" },
      { name: "C", email: "c@x.com" },
    ],
    { owners: [{ id: ID, name: "Sara" }] }
  );
  assert.equal(p.rows[0].fields.ownerId, ID, "case and spacing are ignored");
  assert.deepEqual(statuses(p), ["create", "create", "create"], "an unknown owner does not stop the row");
  assert.equal(p.rows[1].fields.ownerId, undefined, "so the lead is handed out as usual");
  assert.deepEqual(p.rows[1].warnings.map((w) => w.code), ["OWNER_NOT_FOUND"]);
  assert.deepEqual(p.rows[2].warnings, []);
});

test("nothing a request carries can reach a query as anything but text", () => {
  const p = plan([
    { name: { $ne: "x" }, phone: ["a"], email: { $gt: "" }, company: 5, source: {}, expectedValue: [1] },
    "a string, not a row",
    null,
    [],
    { name: "Real", email: "real@x.com", ownerId: { $ne: null }, line: { $ne: 1 } },
  ]);
  assert.deepEqual(statuses(p), ["invalid", "invalid", "invalid", "invalid", "create"]);
  assert.equal(p.rows[4].fields.ownerId, undefined, "an ownerId in a row is not an owner: only the Owner column, by name, is");
  assert.equal(p.rows[4].line, 6, "a line that is not a number is ignored");
  assert.equal(p.rows[0].fields.company, "5", "a number is text");
});

test("no rows, too many rows and not-an-array are refused whole, with a code", () => {
  assert.equal(plan([]).error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(plan(undefined).error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(plan("rows").error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(plan({ length: 3 }).error.code, "IMPORT_ROWS_REQUIRED", "an object that only looks like a list");
  const many = Array.from({ length: imp.MAX_ROWS + 1 }, (_, i) => ({ name: `L${i}`, email: `l${i}@x.com` }));
  assert.equal(plan(many).error.code, "IMPORT_TOO_MANY");
  assert.equal(plan(many.slice(0, imp.MAX_ROWS)).summary.create, imp.MAX_ROWS, "the limit itself is allowed");
});

test("issuesOf lists what a person has to look at, and is capped", () => {
  const p = plan([{ name: "Good", email: "g@x.com" }, { name: "", email: "z@x.com" }, { name: "Dup", email: "g@x.com" }, { name: "Owner", email: "o@x.com", owner: "Ghost" }]);
  const lines = imp.issuesOf(p.rows).map((r) => r.line);
  assert.deepEqual(lines, [3, 4, 5], "invalid, duplicate and a row with a warning - not the clean one");
  assert.equal(imp.issuesOf(p.rows, 1).length, 1);
});

// ---- contacts ---------------------------------------------------------------------------------------------------

const cplan = (rows, opts) => imp.planContactImport(rows, opts);
const CUSTOMERS = [{ id: "c".repeat(24), name: "Al Noor Trading" }, { id: "d".repeat(24), name: "Twin Co" }, { id: "e".repeat(24), name: "twin co" }];

test("a person is linked to the customer their company names, by name, ignoring case and spacing", () => {
  const p = cplan([{ name: "Omar", designation: "Buyer", email: "omar@noor.ae", company: "  al  noor TRADING " }], { customers: CUSTOMERS });
  assert.equal(p.rows[0].status, "create");
  assert.equal(p.rows[0].fields.customerId, "c".repeat(24));
  assert.equal(p.rows[0].fields.designation, "Buyer");
});

test("a company that is not a customer leaves the person unlinked, with the company kept in the notes", () => {
  const p = cplan([{ name: "Sana", phone: "0501112233", company: "Brand New Co", notes: "met at the expo" }], { customers: CUSTOMERS });
  assert.equal(p.rows[0].status, "create");
  assert.equal(p.rows[0].fields.customerId, undefined);
  assert.equal(p.rows[0].fields.notes, "Company: Brand New Co. met at the expo", "nothing the file said is lost");
  assert.deepEqual(p.rows[0].warnings.map((w) => w.code), ["COMPANY_NOT_A_CUSTOMER"]);
});

test("a person whose company is not a customer can be left out instead", () => {
  const p = cplan([{ name: "Sana", phone: "0501112233", company: "Brand New Co" }, { name: "Omar", phone: "0502223344", company: "Al Noor Trading" }], { customers: CUSTOMERS, unmatched: "skip" });
  assert.deepEqual(statuses(p), ["skipped", "create"]);
  assert.equal(p.summary.skipped, 1);
});

test("two customers with one name is refused: linking to the wrong one is worse than not linking", () => {
  const p = cplan([{ name: "Zed", email: "zed@twin.ae", company: "Twin Co" }], { customers: CUSTOMERS });
  assert.equal(p.rows[0].status, "invalid");
  assert.deepEqual(p.rows[0].errors.map((e) => e.code), ["CONTACT_COMPANY_AMBIGUOUS"]);
});

test("only a name is required of a person, as a business card has little else", () => {
  const p = cplan([{ name: "Just A Name" }, { name: "" }, { name: "Bad Email", email: "nope" }]);
  assert.deepEqual(statuses(p), ["create", "invalid", "invalid"]);
  assert.deepEqual(p.rows[1].errors.map((e) => e.code), ["CONTACT_NAME_REQUIRED"]);
  assert.deepEqual(p.rows[2].errors.map((e) => e.code), ["CONTACT_EMAIL_INVALID"]);
});

test("a person is a duplicate by email, by phone, or - with neither - by name at one customer", () => {
  const p = cplan(
    [
      { name: "A", email: "a@x.com" },
      { name: "A again", email: "A@x.com" },
      { name: "B", phone: "+971 50 777 8888" },
      { name: "B again", phone: "0507778888" },
      { name: "Held", email: "held@x.com" },
      { name: "No details", company: "Al Noor Trading" },
      { name: "no  DETAILS", company: "Al Noor Trading" },
      { name: "No details", company: "Twin Co" },
    ],
    { customers: [CUSTOMERS[0]], existing: { emails: new Set(["held@x.com"]), phones: new Set(), names: new Set() } }
  );
  assert.deepEqual(statuses(p), ["create", "duplicate", "create", "duplicate", "duplicate", "create", "duplicate", "create"]);
  assert.deepEqual(p.rows[1].duplicateOf, { kind: "file", line: 2, by: "email" });
  assert.deepEqual(p.rows[4].duplicateOf, { kind: "contact", by: "email" });
  assert.deepEqual(p.rows[6].duplicateOf, { kind: "file", line: 7, by: "name" });
});

test("contact rows are as hard to hurt as lead rows", () => {
  const p = cplan([{ name: { $ne: 1 }, company: ["x"], email: {} }, null, { name: "Real" }]);
  assert.deepEqual(statuses(p), ["invalid", "invalid", "create"]);
  assert.equal(cplan([]).error.code, "IMPORT_ROWS_REQUIRED");
});
