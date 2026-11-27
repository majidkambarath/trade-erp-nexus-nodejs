// The FTA Audit File's layout (utils/ftaAuditFile.js, pure). node --test utils/__tests__/ftaAuditFile.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const faf = require("../ftaAuditFile");

test("an empty period is still a whole file: four tables, zero totals, no-date for a date it was not given", () => {
  const { text } = faf.build({});
  assert.deepEqual(text.split("\r\n"), [
    "CompInfoStart", ",,,,,,,31-12-9999,31-12-9999,31-12-9999,,FAFv1.0.0", "CompInfoEnd",
    "PurcDataStart", "PurcDataEnd,0.00,0.00,0",
    "SuppDataStart", "SuppDataEnd,0.00,0.00,0",
    "GLDataStart", "GLDataEnd,0.00,0.00,0,AED",
    "",
  ]);
});

test("rows carry the appendix's columns in order, sorted by date, with totals", () => {
  const purchase = (day, invoiceNo, lineNo, amountAED, vatAED, extra = {}) => ({ party: "Gulf Mills", trn: "100555444300003", day, invoiceNo, lineNo, description: "Rice", amountAED, vatAED, kind: "standard", ...extra });
  const { text, totals } = faf.build({
    purchases: [purchase("2026-11-20", "B-2", 1, 100, 5), purchase("2026-11-02", "B-1", 2, -40, -2), purchase("2026-11-02", "B-1", 1, 1000, 50, { currency: "USD", amountFCY: 272.29, vatFCY: 13.61 })],
    supplies: [{ party: "Al Noor", day: "2026-11-05", invoiceNo: "SO-1", lineNo: 1, description: "Rice", amountAED: 0.1, vatAED: 0, kind: "zero_rated", country: "OM" }],
    ledger: [{ day: "2026-11-05", accountId: "1100", accountName: "Debtors", description: "Sale", name: "Al Noor", transactionId: "SO-1", sourceDocumentId: "SO-1", sourceType: "Sales invoice", debit: 0.1, credit: 0, balance: 0.1 }],
  });
  const lines = text.split("\r\n");
  const at = lines.indexOf("PurcDataStart");
  assert.equal(lines[at + 1], "Gulf Mills,100555444300003,02-11-2026,B-1,,1,Rice,1000.00,50.00,SR,USD,272.29,13.61");
  assert.equal(lines[at + 2], "Gulf Mills,100555444300003,02-11-2026,B-1,,2,Rice,-40.00,-2.00,SR,XXX,0.00,0.00");
  assert.equal(lines[at + 4], "PurcDataEnd,1060.00,53.00,3");
  assert.ok(lines.includes("Al Noor,,05-11-2026,SO-1,1,Rice,0.10,0.00,ZR,OM,XXX,0.00,0.00"));
  assert.ok(lines.includes("05-11-2026,1100,Debtors,Sale,Al Noor,SO-1,SO-1,Sales invoice,0.10,0.00,0.10"));
  assert.ok(lines.includes("GLDataEnd,0.10,0.00,1,AED"));
  assert.deepEqual(totals.purchases, { amount: 1060, vat: 53, count: 3 });
});

test("text cannot break the file or run in a spreadsheet, and is cut to the appendix's lengths", () => {
  assert.equal(faf.text('Al Noor, "A" LLC\r\nDeira x'), "Al Noor; 'A' LLC Deira x");
  assert.equal(faf.text("=HYPERLINK(x)"), "HYPERLINK(x)");
  assert.equal(faf.text("@cmd"), "cmd");
  assert.equal(faf.text("-A1+B1"), "A1+B1");
  assert.equal(faf.text("-"), "-");
  assert.equal(faf.text("-5"), "-5");
  assert.equal(faf.text("x".repeat(120), 100).length, 100);
  assert.equal(faf.text(null), "");
});

test("amounts have two places and never a negative zero; dates are DD-MM-YYYY", () => {
  assert.equal(faf.amount(1.005), "1.01");
  assert.equal(faf.amount(-0.001), "0.00");
  assert.equal(faf.amount(undefined), "0.00");
  assert.equal(faf.date("2026-01-09"), "09-01-2026");
  assert.equal(faf.date("rubbish"), "31-12-9999");
});

test("tax codes are the FTA's, with ours for out of scope and blank for no treatment", () => {
  assert.deepEqual(["standard", "zero_rated", "exempt", "reverse_charge", "out_of_scope", "", "unclassified"].map(faf.taxCodeFor), ["SR", "ZR", "EX", "RC", "OS", "", ""]);
});
