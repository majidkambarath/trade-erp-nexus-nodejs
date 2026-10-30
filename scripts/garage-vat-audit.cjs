// READ-ONLY. Lists every APPROVED document with a line that carries no tax treatment at all (no
// taxCodeId, no vatPercent, no vatAmount) - the garage module's D01 defect (Garage-Test-Report.xlsx):
// the job-card form never sent a tax code, and nothing defaulted one before this fix landed.
//
// This script makes NO writes. An approved, posted document is never silently re-priced in this
// codebase - its ledger entries would then disagree with what it says - so the fix for a document
// already on the books is the ordinary accounting instrument: a credit note for the untaxed total,
// and a fresh, correctly-taxed invoice in its place. This script is the list to work from.
//
// Usage:  node scripts/garage-vat-audit.cjs [organisationCode]
// Reads MONGO_URI from .env, same as every other script here. Defaults to al-manara-garage, the
// organisation the QA report was run against.

require("dotenv").config();
const mongoose = require("mongoose");

const ORG = process.argv[2] || "al-manara-garage";
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function untaxedLines(items) {
  return (items || []).filter(
    (l) => !l.taxCodeId && !(Number(l.vatPercent) > 0) && !(Number(l.vatAmount) > 0)
  );
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || "ERP" });
  const db = mongoose.connection.db;

  const code = await db.collection("taxcodes").findOne({ companyId: ORG, isDefault: true, isActive: true, kind: "standard" });
  const rate = code ? Number(code.ratePercent) || 0 : null;
  console.log(`Organisation: ${ORG}`);
  console.log(rate != null ? `Default standard tax code: "${code.name}" at ${rate}%` : "No default standard tax code found - cannot compute what each line should have charged.");
  console.log("READ-ONLY: nothing below is written to the database.\n");

  const docs = await db
    .collection("transactions")
    .find({ companyId: ORG, status: "APPROVED" })
    .sort({ date: 1, transactionNo: 1 })
    .toArray();

  let totalLines = 0;
  let totalNet = 0;
  let totalVatOwed = 0;
  const affected = [];

  for (const doc of docs) {
    const bad = untaxedLines(doc.items);
    if (!bad.length) continue;
    affected.push(doc);
    const paid = Number(doc.paidAmount) || 0;
    console.log(
      `${doc.transactionNo}  (${doc.type}, dated ${new Date(doc.date).toISOString().slice(0, 10)}, ` +
        `total ${r2(doc.totalAmount)}, paid ${r2(paid)}${paid > 0 ? " - ALREADY PAID" : ""})`
    );
    for (const l of bad) {
      totalLines += 1;
      const net = Number(l.taxableAmount ?? l.lineTotal ?? l.price * l.qty) || 0;
      const vat = rate != null ? r2((net * rate) / 100) : null;
      totalNet += net;
      if (vat != null) totalVatOwed += vat;
      console.log(
        `    ${String(l.itemCode || "").padEnd(10)} ${String(l.description || "").slice(0, 40).padEnd(40)} ` +
          `qty ${String(l.qty).padStart(6)}  net ${String(r2(net)).padStart(10)}  ` +
          `should be VAT ${vat != null ? String(vat).padStart(8) : "?".padStart(8)}  ` +
          `corrected total ${vat != null ? String(r2(net + vat)).padStart(10) : "?"}`
      );
    }
    console.log("");
  }

  console.log("---");
  console.log(`${affected.length} document(s), ${totalLines} line(s) with no tax treatment.`);
  console.log(`Net value involved: ${r2(totalNet)}.`);
  if (rate != null) console.log(`VAT that should have been charged, at ${rate}%: ${r2(totalVatOwed)}.`);
  console.log(
    "\nNext step for each document above: raise a credit note for its current total, then re-enter it " +
      "as a new invoice (the garage line grid now carries a tax-code column, so the new one will price " +
      "correctly). Do this before finalising any VAT return that would otherwise be missing this VAT."
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
