// READ-ONLY. Says what an Indian organisation still has to enter before its documents carry CGST / SGST / IGST and its GST returns
// are complete. Nothing is written.
//
//   1. the company's own state (Settings > Business rules > Tax identity, or the first two digits of its GSTIN)
//   2. each customer's and vendor's state (the form, or the first two digits of its GSTIN)
//   3. the HSN / SAC code on each item that has been sold or bought
//   4. approved documents already made without the split (they stay as they are; they are listed apart in the returns)
//
// Usage:  node scripts/gst-readiness.cjs <organisationCode>
// Reads MONGO_URI (and MONGO_DB_NAME, default ERP) from .env, as the other scripts here do.

require("dotenv").config();
const mongoose = require("mongoose");
const { stateCodeOfGstin, isStateCode } = require("../utils/gstStates");

const ORG = process.argv[2];
if (!ORG) {
  console.error("Usage: node scripts/gst-readiness.cjs <organisationCode>");
  process.exit(1);
}

const list = (rows, show, max = 15) => {
  rows.slice(0, max).forEach((r) => console.log(`    ${show(r)}`));
  if (rows.length > max) console.log(`    ... and ${rows.length - max} more`);
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || "ERP" });
  const db = mongoose.connection.db;
  console.log("READ-ONLY: nothing below is written to the database.\n");

  const org = await db.collection("organisations").findOne({ code: ORG });
  if (!org) throw new Error(`No organisation with code "${ORG}"`);
  console.log(`Organisation: ${org.legalName} (${ORG}), country ${org.country}`);
  if (org.country !== "IN") console.log("  Not an Indian organisation: GST splitting does not apply to it.");

  // 1. the company
  const settings = await db.collection("companysettings").findOne({ companyId: ORG });
  const profile = settings?.profile || {};
  const own = isStateCode(profile.stateCode) ? profile.stateCode : stateCodeOfGstin(profile.trn);
  console.log(`\n1. Company state: ${own ? `${own} (${isStateCode(profile.stateCode) ? "entered" : "from the GSTIN"})` : "NOT SET - no document is split until it is"}`);
  console.log(`   GSTIN: ${profile.trn || "NOT SET"}`);

  // 2. parties
  for (const [collection, name, trnField] of [["customers", "customerName", "trnNumber"], ["vendors", "vendorName", "trnNO"]]) {
    const rows = await db.collection(collection).find({ companyId: ORG }).project({ [name]: 1, stateCode: 1, vat: 1, [trnField]: 1, country: 1 }).toArray();
    const missing = rows.filter((r) => !(isStateCode(r.stateCode) || stateCodeOfGstin(r.vat?.trn || r[trnField])));
    console.log(`\n2. ${collection}: ${rows.length} in all, ${missing.length} with no state${missing.length ? " (treated as the company's own state: CGST + SGST)" : ""}`);
    list(missing, (r) => `${r[name]}${r.country && r.country !== "IN" ? ` [country ${r.country}]` : ""}`);
  }

  // 3. items
  const used = await db.collection("transactions").aggregate([
    { $match: { companyId: ORG, status: "APPROVED", type: { $in: ["sales_order", "purchase_order"] } } },
    { $unwind: "$items" },
    { $group: { _id: "$items.itemId" } },
  ]).toArray();
  const ids = used.map((u) => u._id).filter(Boolean).map((id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id));
  const items = await db.collection("stocks").find({ companyId: ORG, _id: { $in: ids } }).project({ itemName: 1, sku: 1, hsnCode: 1, itemType: 1 }).toArray();
  const noHsn = items.filter((i) => !i.hsnCode);
  console.log(`\n3. Items on approved documents: ${items.length}, ${noHsn.length} with no HSN / SAC code`);
  list(noHsn, (i) => `${i.sku}  ${i.itemName}${i.itemType === "service" ? " (service: SAC)" : ""}`);

  // 4. documents without the split
  const docs = await db.collection("transactions").aggregate([
    { $match: { companyId: ORG, status: "APPROVED", isOpening: { $ne: true }, type: { $in: ["sales_order", "sales_return", "purchase_order", "purchase_return"] } } },
    { $group: { _id: { split: { $cond: [{ $ifNull: ["$gstType", false] }, "with", "without"] } }, count: { $sum: 1 }, tax: { $sum: "$pricing.lineVat" } } },
  ]).toArray();
  const get = (k) => docs.find((d) => d._id.split === k) || { count: 0, tax: 0 };
  console.log(`\n4. Approved documents: ${get("with").count} with the CGST / SGST / IGST split, ${get("without").count} without (tax ${Math.round(get("without").tax * 100) / 100})`);
  if (get("without").count) console.log("   Those stay as they are: their tax is in the ledger as one amount and the returns list them apart.");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
