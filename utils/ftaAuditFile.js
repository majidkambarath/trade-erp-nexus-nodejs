// The FTA VAT Audit File (FAF), version FAFv1.0.0. Pure: no database.
//
// Layout from the Federal Tax Authority's "Requirements Document for Tax Accounting Software" (October 2017),
// Appendix 5 and its notes:
//   - four tables, each: one header row naming its start marker, the body rows, one footer row with its end marker
//     (CompInfo, PurcData with totals, SuppData with totals, GLData with totals);
//   - fields delimited by an ASCII comma, which therefore must not appear inside a field;
//   - no value: an empty string for text, 0.00 for amounts, 0 for counts, 31-12-9999 (DD-MM-YYYY) for dates;
//   - dates as DD-MM-YYYY; the listings sorted by date.
// Nothing here rounds or decides tax: the rows are given to it already worked out (services/reports/ftaAuditFileService.js).

const FAF_VERSION = "FAFv1.0.0";
const NO_DATE = "31-12-9999";

// A tax code from Appendix 3 of the same document: SR standard rated, ZR zero rated, EX exempt, RC reverse charge.
// "OS" (outside the scope of VAT) is not in the appendix; it is ours, so an out-of-scope line is listed and labelled
// rather than dropped or passed off as one of the FTA's codes. A line with no treatment at all is left blank.
const TAX_CODES = { standard: "SR", zero_rated: "ZR", exempt: "EX", reverse_charge: "RC", out_of_scope: "OS" };
const taxCodeFor = (kind) => TAX_CODES[kind] || "";

// A text field: one line, no comma (the delimiter) and no double quote (nothing here is quoted), cut to the length the
// appendix allows. A leading character a spreadsheet would run as a formula is dropped: the file is data, often opened
// in Excel by whoever audits it.
function text(value, max) {
  let s = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ") // eslint-disable-line no-control-regex
    .replace(/,/g, ";")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[=+@]+\s*/, "").replace(/^-+(?=[A-Za-z=+@(])/, "");
  return max ? Array.from(s).slice(0, max).join("") : s;
}

// "YYYY-MM-DD" (the organisation's calendar day) -> "DD-MM-YYYY"; anything else is the no-date value.
function date(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : NO_DATE;
}

const round2 = (n) => {
  const v = Math.round((Number(n) || 0) * 100 + (Number(n) < 0 ? -1e-7 : 1e-7)) / 100;
  return v === 0 ? 0 : v; // never "-0.00"
};
const amount = (n) => round2(n).toFixed(2);
const row = (fields) => fields.join(",");
const sum = (rows, key) => round2(rows.reduce((t, r) => t + (Number(r[key]) || 0), 0));

const byDate = (a, b) =>
  String(a.day).localeCompare(String(b.day)) || String(a.invoiceNo).localeCompare(String(b.invoiceNo)) || (a.lineNo || 0) - (b.lineNo || 0);

const foreign = (r) => (r.currency ? [text(r.currency, 3), amount(r.amountFCY), amount(r.vatFCY)] : ["XXX", amount(0), amount(0)]);

/**
 * The file's text.
 *   company    { nameEn, nameAr, trn, agencyName, tan, agentName, taan, periodStart, periodEnd, createdOn, product }
 *   purchases  [{ party, trn, day, invoiceNo, permitNo, lineNo, description, amountAED, vatAED, kind, currency, amountFCY, vatFCY }]
 *   supplies   the same without permitNo, with `country` (where exported goods go)
 *   ledger     [{ day, accountId, accountName, description, name, transactionId, sourceDocumentId, sourceType, debit, credit, balance }]
 *   currency   the books' currency (the ledger's)
 * -> { text, totals }
 */
function build({ company = {}, purchases = [], supplies = [], ledger = [], currency = "AED" } = {}) {
  const lines = [];

  lines.push("CompInfoStart");
  lines.push(
    row([
      text(company.nameEn, 100), text(company.nameAr, 100), text(company.trn, 15), text(company.agencyName, 100), text(company.tan, 20),
      text(company.agentName, 100), text(company.taan, 20), date(company.periodStart), date(company.periodEnd), date(company.createdOn),
      text(company.product, 100), FAF_VERSION,
    ])
  );
  lines.push("CompInfoEnd");

  const purchaseRows = [...purchases].sort(byDate);
  lines.push("PurcDataStart");
  for (const r of purchaseRows) {
    lines.push(
      row([
        text(r.party, 100), text(r.trn, 15), date(r.day), text(r.invoiceNo, 50), text(r.permitNo, 20), String(r.lineNo || 0),
        text(r.description, 250), amount(r.amountAED), amount(r.vatAED), taxCodeFor(r.kind), ...foreign(r),
      ])
    );
  }
  const purchaseTotals = { amount: sum(purchaseRows, "amountAED"), vat: sum(purchaseRows, "vatAED"), count: purchaseRows.length };
  lines.push(row(["PurcDataEnd", amount(purchaseTotals.amount), amount(purchaseTotals.vat), String(purchaseTotals.count)]));

  const supplyRows = [...supplies].sort(byDate);
  lines.push("SuppDataStart");
  for (const r of supplyRows) {
    lines.push(
      row([
        text(r.party, 100), text(r.trn, 15), date(r.day), text(r.invoiceNo, 50), String(r.lineNo || 0), text(r.description, 250),
        amount(r.amountAED), amount(r.vatAED), taxCodeFor(r.kind), text(r.country, 50), ...foreign(r),
      ])
    );
  }
  const supplyTotals = { amount: sum(supplyRows, "amountAED"), vat: sum(supplyRows, "vatAED"), count: supplyRows.length };
  lines.push(row(["SuppDataEnd", amount(supplyTotals.amount), amount(supplyTotals.vat), String(supplyTotals.count)]));

  // the ledger comes already in date order with each row's running balance, so it is not re-sorted here
  lines.push("GLDataStart");
  for (const r of ledger) {
    lines.push(
      row([
        date(r.day), text(r.accountId, 20), text(r.accountName, 100), text(r.description, 250), text(r.name, 100), text(r.transactionId, 50),
        text(r.sourceDocumentId, 50), text(r.sourceType, 20), amount(r.debit), amount(r.credit), amount(r.balance),
      ])
    );
  }
  const ledgerTotals = { debit: sum(ledger, "debit"), credit: sum(ledger, "credit"), count: ledger.length };
  lines.push(row(["GLDataEnd", amount(ledgerTotals.debit), amount(ledgerTotals.credit), String(ledgerTotals.count), text(currency, 3)]));

  return { text: `${lines.join("\r\n")}\r\n`, totals: { purchases: purchaseTotals, supplies: supplyTotals, ledger: ledgerTotals } };
}

module.exports = { build, text, date, amount, taxCodeFor, FAF_VERSION, NO_DATE, TAX_CODES };
