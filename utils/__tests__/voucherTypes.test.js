// Pure rules of the voucher type master (utils/voucherTypes.js): the seed, how a number is rendered,
// which counter a date belongs to, what a type is allowed to do, and the continuity report.
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../voucherTypes");

const type = (key, over = {}) => ({ ...V.DEFAULTS, ...V.seedFor(key), ...over });
const num = (t, seq, { branchId = "main", yearCode = "2026" } = {}) => V.renderNumber({ type: t, branchId, yearCode, seq });

test("the seed reproduces the numbering that was hardcoded, so no existing client's numbers move", () => {
  assert.equal(V.seedRows().length, 29, "every series the app issues");
  assert.equal(num(type("SO"), 1), "SO-2026-0001");
  assert.equal(num(type("PO"), 1), "PO-2026-0001");
  assert.equal(num(type("RV"), 1), "RV-2026-0001");
  assert.equal(num(type("SORD"), 12), "SORD-2026-0012", "a four-letter prefix");
  assert.equal(num(type("SO"), 1, { branchId: "shj" }), "SHJ-SO-2026-0001", "a branch carries its code in front");
  assert.equal(num(type("SO"), 1, { branchId: "MAIN" }), "SO-2026-0001", "head office never does, whatever its case");
  // Every seeded row must round-trip to the old format: prefix, year, four digits.
  for (const row of V.seedRows()) {
    assert.match(num(row, 7), /^[A-Z]+-2026-0007$/, row.key);
  }
});

test("renderNumber: every part of the format, and the parts a type can leave out", () => {
  assert.equal(num(type("SO", { prefix: "INV", separator: "/" }), 1), "INV/2026/0001");
  assert.equal(num(type("SO", { includeYear: false }), 1), "SO-0001");
  assert.equal(num(type("SO", { numberLength: 6 }), 42), "SO-2026-000042");
  assert.equal(num(type("SO", { numberLength: 3 }), 42), "SO-2026-042");
  assert.equal(num(type("SO", { suffix: "A" }), 1), "SO-2026-0001-A");
  assert.equal(num(type("SO", { separator: "" }), 1), "SO20260001", "no separator runs the parts together");
  assert.equal(num(type("SO", { branchPrefix: "none" }), 1, { branchId: "shj" }), "SO-2026-0001", "the branch can be left out");
  assert.equal(num(type("SO", { branchPrefixes: [{ branchId: "shj", prefix: "SH" }] }), 1, { branchId: "shj" }), "SH-SO-2026-0001", "a branch can be given a shorter code");
  assert.equal(num(type("SO"), 0), "SO-2026-0000", "a counter at nothing still renders");
  assert.equal(num(type("SO"), 99999), "SO-2026-99999", "a number past its width is never truncated");
  assert.equal(V.renderPrefixFor(type("SO"), "shj"), "SHJ-SO");
});

test("labelOf: the printed label identifies the counter, which is what stops a duplicate", () => {
  const yearly = type("SO");
  const withYear = V.labelOf({ type: yearly, fiscalYear: { code: "2026" }, year: "2026" });
  const noYearYet = V.labelOf({ type: yearly, fiscalYear: null, year: "2026" });
  assert.equal(withYear.label, "2026");
  assert.equal(noYearYet.label, "2026");
  assert.equal(withYear.label, noYearYet.label,
    "numbers issued before a fiscal year was configured must keep counting on the same counter once one exists, or the series restarts at 1 and mints SO-2026-0001 twice");

  const fy2027 = V.labelOf({ type: yearly, fiscalYear: { code: "2027" }, year: "2027" });
  assert.notEqual(fy2027.label, withYear.label, "a different year is a different counter");
  assert.equal(V.labelOf({ type: yearly, fiscalYear: { code: "fy2025-26" }, year: "2026" }).label, "FY2025-26", "a year named anything at all");

  const cont = V.labelOf({ type: type("JV", { resetPolicy: "never" }), fiscalYear: { code: "2026" }, year: "2026" });
  assert.equal(cont.label, V.CONTINUOUS);
  assert.equal(cont.yearCode, "", "a continuous series prints no year");
  assert.equal(V.labelOf({ type: type("JV", { resetPolicy: "never" }), fiscalYear: { code: "2031" }, year: "2031" }).label, cont.label, "and counts under one label for good");
  assert.match(V.labelText("2026"), /2026/);
  assert.match(V.labelText(V.CONTINUOUS), /continuous/i);
});

test("mayReuse: a tax document we issue keeps its number for good, whatever the setting says", () => {
  for (const key of ["SO", "SR", "DN", "CN"]) {
    assert.equal(V.seedFor(key).statutory, true, key + " is a document we issue bearing tax");
    assert.equal(V.mayReuse(type(key, { allowReuse: true })), false, key + " must refuse re-use even when it is switched on");
  }
  for (const key of ["RV", "PV", "JV", "CV", "EV", "SA", "WO", "PRD", "LD", "PO", "PR"]) {
    assert.equal(V.mayReuse(type(key, { allowReuse: true })), true, key + " may re-use when switched on");
    assert.equal(V.mayReuse(type(key)), false, key + " does not re-use unless it is switched on");
  }
  for (const key of ["OBV", "YEC", "OST", "BRC"]) {
    assert.equal(V.mayReuse(type(key, { allowReuse: true })), false, key + " is written by the system");
  }
  assert.equal(V.mayReuse(null), false, "no type, no re-use");
});

test("mayOverride: a number may be typed, including on a tax document, but never on a system series", () => {
  assert.equal(V.mayOverride(type("SO", { method: "auto_override" })), true,
    "a business moving onto the product mid-year has to carry on from its paper invoice book");
  assert.equal(V.mayOverride(type("SO")), false, "not unless it is switched on");
  assert.equal(V.mayOverride(type("YEC", { method: "auto_override" })), false, "nobody types a year-end closing number");
  assert.equal(V.mayOverride(null), false);
});

test("seqOf: a typed number is placed in its series only when it is really in that format", () => {
  const so = type("SO");
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "SO-2026-0042" }), 42);
  assert.equal(V.seqOf({ type: so, branchId: "shj", yearCode: "2026", number: "SHJ-SO-2026-0042" }), 42);
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "so-2026-0042" }), 42, "case does not matter");
  assert.equal(V.seqOf({ type: so, branchId: "shj", yearCode: "2026", number: "SO-2026-0042" }), null, "another branch's number is not ours");
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "SO-2025-0042" }), null, "another year's is not either");
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "SO-2026-42" }), null, "the counter is a fixed width");
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "SO-2026-0000" }), null, "a sequence starts at one");
  assert.equal(V.seqOf({ type: so, branchId: "main", yearCode: "2026", number: "INV/OLD/77" }), null,
    "a number carried over from a paper book is recorded, but it is not this series' 77th document");
  assert.equal(V.seqOf({ type: type("SO", { suffix: "A" }), branchId: "main", yearCode: "2026", number: "SO-2026-0042-A" }), 42);
  assert.equal(V.seqOf({ type: type("SO", { suffix: "A" }), branchId: "main", yearCode: "2026", number: "SO-2026-0042" }), null, "the suffix is part of the format");
  assert.equal(V.seqOf({ type: type("JV", { resetPolicy: "never", includeYear: false }), branchId: "main", yearCode: "", number: "JV-0045" }), 45);
  // Whatever it renders, it reads back.
  for (const over of [{}, { separator: "/" }, { numberLength: 6 }, { suffix: "X" }, { includeYear: false }, { prefix: "INV" }]) {
    const t = type("SO", over);
    assert.equal(V.seqOf({ type: t, branchId: "shj", yearCode: "2026", number: num(t, 123, { branchId: "shj" }) }), 123, JSON.stringify(over));
  }
});

const errs = (over, opts) => V.validateVoucherType({ ...V.DEFAULTS, key: "XX", name: "A type", prefix: "XX", kind: "voucher", ...over }, opts);

test("validateVoucherType: the shape of a number", () => {
  assert.deepEqual(errs({}), {}, "the defaults are valid");
  assert.ok(errs({ key: "" }).key, "a code is needed");
  assert.ok(errs({ key: "X" }).key, "two characters at least");
  assert.ok(errs({ key: "TOOLONGAKEY" }).key);
  assert.ok(errs({ key: "X-Y" }).key, "letters and digits only");
  assert.ok(errs({ key: "RV" }, { takenKeys: ["RV"] }).key, "a code in use is refused");
  assert.ok(errs({ name: "" }).name);
  assert.ok(errs({ name: "n".repeat(61) }).name);
  assert.ok(errs({ prefix: "" }).prefix);
  assert.ok(errs({ prefix: "SO-X" }).prefix, "the prefix carries no separator of its own");
  assert.ok(errs({ suffix: "TOOLONG" }).suffix);
  assert.ok(errs({ separator: "." }).separator);
  assert.ok(errs({ numberLength: 2 }).numberLength);
  assert.ok(errs({ numberLength: 11 }).numberLength);
  assert.ok(errs({ numberLength: 4.5 }).numberLength);
  assert.ok(errs({ resetPolicy: "daily" }).resetPolicy);
  assert.ok(errs({ branchPrefix: "maybe" }).branchPrefix);
  assert.ok(errs({ method: "manual" }).method, "only automatic, with or without an override");
});

test("validateVoucherType: a continuous counter cannot carry the year", () => {
  assert.ok(errs({ resetPolicy: "never" }).includeYear,
    "the year would move while the count carried on, and the two would disagree about which counter a number came from");
  assert.deepEqual(errs({ resetPolicy: "never", includeYear: false }), {}, "without the year it is fine");
  assert.match(V.warningsFor({ ...V.DEFAULTS, resetPolicy: "never", includeYear: false }).join(" "), /will not say which year/);
  assert.match(V.warningsFor({ ...V.DEFAULTS, branchPrefix: "none" }, { branches: [{ code: "main" }, { code: "shj" }] }).join(" "), /same number/);
  assert.deepEqual(V.warningsFor({ ...V.DEFAULTS, branchPrefix: "none" }, { branches: [{ code: "main" }] }), [], "one branch cannot clash with itself");
});

test("validateVoucherType: reuse, override and the 16-character cap on a tax document", () => {
  assert.ok(errs({ allowReuse: true, statutory: true }).allowReuse);
  assert.deepEqual(errs({ allowReuse: true, statutory: false }), {}, "an internal document may re-use");
  assert.ok(errs({ allowReuse: true, kind: "system" }).allowReuse);
  assert.ok(errs({ method: "auto_override", kind: "system" }).method);

  // India CGST Rule 46(b) caps an invoice serial at 16 characters, judged against the WIDEST number the
  // series can ever reach - and in the longest-coded branch, which is where it actually bites.
  const branches = [{ code: "main" }, { code: "shj" }];
  assert.deepEqual(errs({ statutory: true }, { branches }), {}, "SHJ-SO-2026-9999 is exactly 16");
  assert.ok(errs({ statutory: true, numberLength: 5 }, { branches }).numberLength, "one more digit is 17");
  assert.ok(errs({ statutory: true }, { branches: [{ code: "jebel-ali-free-zone" }] }).numberLength);
  assert.deepEqual(errs({ statutory: false, numberLength: 5 }, { branches }), {}, "an internal document is not capped at 16");
  assert.ok(errs({ statutory: false, numberLength: 10, prefix: "ABCDEFGHIJ", suffix: "ZZZZZZ" }, { branches: [{ code: "jebel-ali-free-zone" }] }).numberLength, "but it still has to print");

  const parent = { ...V.DEFAULTS, ...V.seedFor("PV") };
  assert.ok(errs({ parentKey: "NOPE" }, { parent: null }).parentKey);
  assert.deepEqual(errs({ key: "PCV", name: "Petty cash", prefix: "PCV", parentKey: "PV" }, { parent }), {});
  assert.ok(errs({ parentKey: "PCV" }, { parent: { ...parent, parentKey: "PV" } }).parentKey, "a variant cannot have a variant");
});

test("gapsOf: every hole in a sequence is explained, and the three kinds are told apart", () => {
  const row = (seq, status, over = {}) => ({ seq, status, number: "JV-2026-" + String(seq).padStart(4, "0"), ...over });
  const clean = V.gapsOf([row(1, "issued"), row(2, "issued"), row(3, "issued")]);
  assert.equal(clean.continuous, true);
  assert.equal(clean.issued, 3);
  assert.equal(clean.highest, 3);
  assert.deepEqual(clean.gaps, []);

  const holes = V.gapsOf([
    row(1, "issued"),
    row(2, "released", { reason: "entered twice" }),
    row(3, "cancelled", { reason: "wrong party" }),
    row(5, "issued"),
  ]);
  assert.equal(holes.continuous, false);
  assert.equal(holes.issued, 2);
  assert.equal(holes.highest, 5);
  assert.deepEqual(holes.gaps.map((g) => [g.seq, g.code]), [[2, "RELEASED"], [3, "CANCELLED"], [4, "UNRECORDED"]]);
  assert.equal(holes.gaps[0].reason, "entered twice");
  assert.match(holes.gaps[2].reason, /No record/, "a number taken by a transaction that rolled back is named as such");
  assert.match(V.gapsOf([row(1, "released")])[ "gaps" ][0].reason, /handed back/, "a released number says so even with no reason given");
  assert.equal(V.gapsOf([]).continuous, true, "nothing issued is not a gap");
  assert.equal(V.gapsOf([], { upTo: 3 }).gaps.length, 3, "a counter ahead of the register is three unrecorded numbers");
  assert.equal(V.gapsOf([{ seq: null, status: "issued" }]).highest, 0, "a typed number outside the format belongs to no sequence");
});

test("seriesFor: a variant is chosen by its own key, and the built-in wins otherwise", () => {
  const types = [
    { key: "PV", postsAs: "payment", parentKey: null, isActive: true },
    { key: "PCV", postsAs: "payment", parentKey: "PV", isActive: true },
    { key: "OLD", postsAs: "payment", parentKey: "PV", isActive: false },
  ];
  assert.equal(V.seriesFor({ postsAs: "payment", types }).key, "PV", "no variant named, so the built-in");
  assert.equal(V.seriesFor({ voucherTypeKey: "PCV", postsAs: "payment", types }).key, "PCV");
  assert.equal(V.seriesFor({ voucherTypeKey: "OLD", postsAs: "payment", types }).key, "PV", "a switched-off variant falls back");
  assert.equal(V.seriesFor({ postsAs: "nothing", types }), null);
  assert.equal(V.seriesFor({ types }), null);
  assert.deepEqual(V.variantsOf("PV", types).map((t) => t.key), ["PCV"], "only the live ones are offered");
});
