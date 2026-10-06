const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../bankStatement");

test("dates: the formats banks and Excel really produce", () => {
  assert.equal(S.parseDay("2026-10-05"), "2026-10-05");
  assert.equal(S.parseDay("2026-10-05T00:00:00.000Z"), "2026-10-05");
  assert.equal(S.parseDay("05/10/2026"), "2026-10-05");
  assert.equal(S.parseDay("05-10-2026"), "2026-10-05");
  assert.equal(S.parseDay("05.10.26"), "2026-10-05");
  assert.equal(S.parseDay("18 Jun 2022"), "2022-06-18");
  assert.equal(S.parseDay("18-Jun-22"), "2022-06-18");
  assert.equal(S.parseDay("18-JUNE-2022"), "2022-06-18");
  assert.equal(S.parseDay("Jun 18, 2022"), "2022-06-18");
  assert.equal(S.parseDay("20261005"), "2026-10-05");
  assert.equal(S.parseDay(46300), "2026-10-05"); // an Excel serial
  assert.equal(S.parseDay(new Date(2026, 9, 5, 14, 30)), "2026-10-05");
  // 03/04/2026 is the 3rd of April for a UAE statement, the 4th of March only when told so
  assert.equal(S.parseDay("03/04/2026"), "2026-04-03");
  assert.equal(S.parseDay("03/04/2026", "MDY"), "2026-03-04");
  for (const bad of ["", null, undefined, "31/02/2026", "2026-13-01", "Opening balance", "Total", 12, "00/00/0000"]) {
    assert.equal(S.parseDay(bad), null, `${bad} is not a date`);
  }
});

test("date order is read from the data: a day above 12 settles it, otherwise the UAE habit (day first)", () => {
  assert.equal(S.detectOrder(["03/04/2026", "25/04/2026"]), "DMY");
  assert.equal(S.detectOrder(["03/04/2026", "04/25/2026"]), "MDY");
  assert.equal(S.detectOrder(["03/04/2026", "05/06/2026"]), "DMY");
  assert.equal(S.detectOrder([]), "DMY");
});

test("amounts: separators, brackets, trailing signs, currency words and CR/DR", () => {
  const n = (v) => S.parseAmount(v);
  assert.equal(n("1,234.50"), 1234.5);
  assert.equal(n("-1,234.50"), -1234.5);
  assert.equal(n("(1,234.50)"), -1234.5);
  assert.equal(n("1,234.50-"), -1234.5);
  assert.equal(n("AED 1,234.50"), 1234.5);
  assert.equal(n("1234.5 AED"), 1234.5);
  assert.equal(n(" 99 "), 99);
  assert.equal(n(12.5), 12.5);
  assert.deepEqual(n("1,234.50 CR"), { value: 1234.5, side: "CR" });
  assert.deepEqual(n("1,234.50 DR"), { value: 1234.5, side: "DR" });
  assert.deepEqual(n("1,234.50CR"), { value: 1234.5, side: "CR" });
  for (const blank of ["", "  ", null, undefined]) assert.equal(n(blank), null);
  assert.equal(n("n/a"), null);
  assert.equal(n("12.34.56"), null);
});

test("cheque numbers are found inside a narration", () => {
  assert.equal(S.extractChequeNo("CHQ DEP 000123 AL NOOR"), "000123");
  assert.equal(S.extractChequeNo("Cheque No: 456789"), "456789");
  assert.equal(S.extractChequeNo("INWARD CHEQUE 123456 RETURNED"), "123456");
  assert.equal(S.extractChequeNo("POS PURCHASE 4242 DUBAI"), "");
  assert.equal(S.extractChequeNo("CHQ 12"), "", "too short to be a cheque number");
});

const GRID = [
  ["Emirates Bank - Account Statement", "", "", "", ""],
  ["Account 1234567", "", "", "", ""],
  ["", "", "", "", ""],
  ["Date", "Description", "Debit", "Credit", "Balance"],
  ["01/10/2026", "OPENING NOTE", "", "", ""],
  ["02/10/2026", "TRANSFER FROM AL NOOR GROCERY REF RV-2026-0001", "", "1,050.00", "11,050.00"],
  ["02/10/2026", "BANK CHARGES", "21.00", "", "11,029.00"],
  ["05/10/2026", "CHQ PAID 000777 VENDOR", "500.00", "", "10,529.00"],
  ["", "Total", "521.00", "1,050.00", ""],
];

test("a typical export: the header is found (below account details), debit and credit become signed amounts", () => {
  const g = S.guessMapping(GRID);
  assert.equal(g.headerRow, 3);
  assert.equal(g.complete, true);
  assert.deepEqual(g.mapping.columns, { date: 0, description: 1, balance: 4 });
  assert.deepEqual(g.mapping.amount, { mode: "split", debit: 2, credit: 3 });
  assert.equal(g.mapping.dateFormat, "DMY");

  const r = S.normaliseStatement(GRID, g.mapping);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.lines.map((l) => [l.day, l.amount, l.balance]), [
    ["2026-10-02", 1050, 11050],
    ["2026-10-02", -21, 11029],
    ["2026-10-05", -500, 10529],
  ]);
  assert.equal(r.lines[2].chequeNo, "000777");
  assert.equal(r.lines[0].lineNo, 6, "line numbers are the rows the person sees in their file");
  assert.equal(r.skipped, 2, "the opening note and the total row are not transactions");
  assert.equal(r.opening, 10000, "opening = first balance - first amount");
  assert.equal(r.closing, 10529);
  assert.deepEqual(r.continuity, { ok: true, checked: true, breaks: [] });
});

test("a single signed column, credit-card style (credits negative) can be inverted", () => {
  const rows = [["Transaction Date", "Description", "Amount"], ["18 Jun 2022", "PAYMENT RECEIVED", "-500.00"], ["19 Jun 2022", "SHOP", "120.00"]];
  const g = S.guessMapping(rows);
  assert.deepEqual(g.mapping.amount, { mode: "signed", column: 2, invert: false });
  const asIs = S.normaliseStatement(rows, g.mapping);
  assert.deepEqual(asIs.lines.map((l) => l.amount), [-500, 120]);
  const inverted = S.normaliseStatement(rows, { ...g.mapping, amount: { ...g.mapping.amount, invert: true } });
  assert.deepEqual(inverted.lines.map((l) => l.amount), [500, -120]);
});

test("a Dr/Cr marker column, and a marker written after the amount", () => {
  const withFlag = [["Date", "Narration", "Amount", "Dr/Cr"], ["05/10/2026", "A", "100.00", "CR"], ["06/10/2026", "B", "30.00", "DR"]];
  const g = S.guessMapping(withFlag);
  assert.equal(g.mapping.amount.mode, "drcr");
  assert.deepEqual(S.normaliseStatement(withFlag, g.mapping).lines.map((l) => l.amount), [100, -30]);

  const inline = [["Date", "Details", "Amount"], ["05/10/2026", "A", "100.00 CR"], ["06/10/2026", "B", "30.00 DR"]];
  const g2 = S.guessMapping(inline);
  assert.deepEqual(S.normaliseStatement(inline, g2.mapping).lines.map((l) => l.amount), [100, -30]);
});

test("a newest-first file is put in date order and its balances still chain", () => {
  const rows = [
    ["Date", "Description", "Debit", "Credit", "Balance"],
    ["05/10/2026", "C", "500.00", "", "10,529.00"],
    ["02/10/2026", "B", "21.00", "", "11,029.00"],
    ["02/10/2026", "A", "", "1,050.00", "11,050.00"],
  ];
  const g = S.guessMapping(rows);
  const r = S.normaliseStatement(rows, g.mapping);
  assert.equal(r.order, "descending");
  assert.deepEqual(r.lines.map((l) => l.description), ["A", "B", "C"]);
  assert.equal(r.opening, 10000);
  assert.equal(r.continuity.ok, true);
});

test("a broken running balance is reported at the line where it breaks", () => {
  const rows = [["Date", "Description", "Debit", "Credit", "Balance"], ["01/10/2026", "A", "", "100.00", "1,100.00"], ["02/10/2026", "B", "", "50.00", "1,500.00"]];
  const r = S.normaliseStatement(rows, S.guessMapping(rows).mapping);
  assert.equal(r.continuity.ok, false);
  assert.deepEqual(r.continuity.breaks, [{ lineNo: 3, expected: 1150, found: 1500 }]);
});

test("bad rows are reported, not silently dropped; footers are skipped quietly", () => {
  const rows = [
    ["Date", "Description", "Debit", "Credit"],
    ["31/02/2026", "IMPOSSIBLE DATE", "", "10.00"],
    ["05/10/2026", "BOTH", "5.00", "5.00"],
    ["06/10/2026", "OK", "", "7.00"],
    ["Closing balance", "", "", ""],
  ];
  const r = S.normaliseStatement(rows, S.guessMapping(rows).mapping);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.issues.map((i) => i.lineNo), [2, 3]);
  assert.match(r.issues[0].message, /could not be read/);
  assert.match(r.issues[1].message, /Both a debit and a credit/);
});

test("the mapping is validated: no date column, or no amount column, says so", () => {
  const rows = [["a", "b"], ["1", "2"]];
  assert.match(S.normaliseStatement(rows, { headerRow: 0, columns: {}, amount: { mode: "signed", column: 1 } }).issues[0].message, /date column/);
  assert.match(S.normaliseStatement(rows, { headerRow: 0, columns: { date: 0 }, amount: { mode: "split" } }).issues[0].message, /amount column/);
  // one of the two is enough: a statement can list deposits only
  assert.equal(S.normaliseStatement([["a", "b"], ["05/10/2026", "100"]], { headerRow: 0, columns: { date: 0 }, amount: { mode: "split", credit: 1 } }).lines.length, 1);
});

test("a file with no header row can still be read when the mapping names the columns", () => {
  const rows = [["05/10/2026", "SHOP", "-20.00"], ["06/10/2026", "SALARY", "900.00"]];
  const r = S.normaliseStatement(rows, { headerRow: -1, columns: { date: 0, description: 1 }, amount: { mode: "signed", column: 2 } });
  assert.deepEqual(r.lines.map((l) => [l.day, l.amount]), [["2026-10-05", -20], ["2026-10-06", 900]]);
  assert.equal(r.opening, null, "no balance column, no opening balance to read");
});

test("several description columns are joined; a cheque column wins over the narration", () => {
  const rows = [["Date", "Details", "More", "Cheque No", "Credit"], ["05/10/2026", "DEPOSIT", "AL NOOR", "000555", "100"]];
  const g = S.guessMapping(rows);
  const mapping = { ...g.mapping, columns: { ...g.mapping.columns, description: [1, 2] } };
  const l = S.normaliseStatement(rows, mapping).lines[0];
  assert.equal(l.description, "DEPOSIT AL NOOR");
  assert.equal(l.chequeNo, "000555");
});

test("two identical lines on one day both survive, and a re-import is recognised line for line", () => {
  const rows = [["Date", "Description", "Debit", "Credit"], ["05/10/2026", "SMS FEE", "25.00", ""], ["05/10/2026", "SMS FEE", "25.00", ""], ["06/10/2026", "SMS FEE", "25.00", ""]];
  const lines = S.normaliseStatement(rows, S.guessMapping(rows).mapping).lines;
  const a = S.withFingerprints(lines);
  assert.deepEqual(a.map((l) => l.occurrence), [1, 2, 1]);
  assert.equal(a[0].fingerprint, a[1].fingerprint);
  assert.notEqual(a[0].fingerprint, a[2].fingerprint, "a different day is a different line");
  const again = S.withFingerprints(S.normaliseStatement(rows, S.guessMapping(rows).mapping).lines);
  assert.deepEqual(again.map((l) => [l.fingerprint, l.occurrence]), a.map((l) => [l.fingerprint, l.occurrence]));
  // text spacing and case do not make a different line
  assert.equal(S.fingerprint({ day: "2026-10-05", amount: -25, description: "SMS  fee", reference: "" }), S.fingerprint({ day: "2026-10-05", amount: -25, description: "sms fee ", reference: "" }));
});

const MT940 = `{1:F01BANKAEAAAXXX0000000000}{2:I940BANKAEAAXXXXN}{4:
:20:STMT20261005
:25:AE070331234567890123456
:28C:00123/001
:60F:C261001AED10000,00
:61:2610021002C1050,00NTRFNONREF//BANKREF1
:86:TRANSFER FROM AL NOOR GROCERY RV-2026-0001
:61:2610021002D21,00NCHGNONREF
:86:BANK CHARGES
INCL VAT
:61:2610051005D500,00NCHQ000777//BREF2
:86:CHEQUE PAID 000777
:62F:C261005AED10529,00
-}`;

test("MT940: opening and closing balances, signs, narrative continuation lines and the cheque number", () => {
  const [st] = S.parseMt940(MT940);
  assert.equal(st.account, "AE070331234567890123456");
  assert.deepEqual(st.opening, { day: "2026-10-01", currency: "AED", amount: 10000 });
  assert.deepEqual(st.closing, { day: "2026-10-05", currency: "AED", amount: 10529 });
  assert.equal(st.lines.length, 3);
  const r = S.mt940Lines(st);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.lines.map((l) => [l.day, l.amount, l.balance]), [["2026-10-02", 1050, 11050], ["2026-10-02", -21, 11029], ["2026-10-05", -500, 10529]]);
  assert.equal(r.lines[1].description, "BANK CHARGES INCL VAT");
  assert.equal(r.lines[2].chequeNo, "000777");
  assert.equal(r.opening, 10000);
  assert.equal(r.closing, 10529);
  assert.equal(r.continuity.ok, true);
});

test("MT940: a closing balance that does not follow from the lines is flagged", () => {
  const broken = MT940.replace("C261005AED10529,00", "C261005AED10999,00");
  const r = S.mt940Lines(S.parseMt940(broken)[0]);
  assert.equal(r.continuity.ok, false);
});

test("a gross amount from a statement splits into net + VAT that adds back exactly, or says it cannot", () => {
  assert.deepEqual(S.splitGross(21, 5), { net: 20, vat: 1, exact: true });
  assert.deepEqual(S.splitGross(10, 5), { net: 9.52, vat: 0.48, exact: true });
  assert.deepEqual(S.splitGross(100, 0), { net: 100, vat: 0, exact: true });
  // every gross from 0.01 to 300.00 either splits exactly or is within one fils
  let inexact = 0;
  for (let g = 1; g <= 30000; g += 1) {
    const { net, vat, exact } = S.splitGross(g / 100, 5);
    assert.equal(S.cents(net) + S.cents(vat), g, `net + vat must equal the gross ${g / 100}`);
    if (!exact) {
      inexact += 1;
      assert.ok(Math.abs(vat - Math.round(net * 5) / 100) <= 0.0100001, `VAT for ${g / 100} is within a fils of the rate`);
    }
  }
  assert.ok(inexact > 0 && inexact < 30000 / 15, `some grosses (${inexact}) have no exact split, and not many`);
});
