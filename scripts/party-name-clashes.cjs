// READ-ONLY. Lists customers (and vendors) that share a name with another of their kind in one organisation.
//
// A party's ledger accounts are found by NAME ("Customer - <name>", services/financial/partyAccounts.js) in the
// statement, credit control, ageing, the party balances and the IFRS notes, so two customers with one name share ONE
// account: invoices of both post to it and both read the same balance. Since 18 Nov 2026 a second party of the same
// name is refused (DUPLICATE_PARTY_NAME, PartyMasterService.assertUniqueName); this script finds the pairs made
// before that. It writes nothing: untangling a shared account (renaming one party and moving its postings) is a
// decision per case, made with the books in front of you. Rename the party that should NOT keep the account first
// (Customers screen); its ledger account is renamed with it only when no account of the new name exists.
//
// Usage:  node scripts/party-name-clashes.cjs [organisationCode]   (every organisation when none is named)
// Reads MONGO_URI (and MONGO_DB_NAME, default ERP) from .env, as the other scripts here do.

require("dotenv").config();
const mongoose = require("mongoose");

const ORG = process.argv[2] || null;
const KINDS = [
  { collection: "customers", field: "customerName", code: "customerId", prefix: "Customer - " },
  { collection: "vendors", field: "vendorName", code: "vendorId", prefix: "Vendor - " },
];
const key = (s) => String(s || "").trim().toLowerCase();

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || "ERP" });
  const db = mongoose.connection.db;
  console.log("READ-ONLY: nothing below is written to the database.\n");
  let found = 0;
  for (const k of KINDS) {
    const rows = await db.collection(k.collection)
      .find(ORG ? { companyId: ORG } : {}, { projection: { companyId: 1, [k.field]: 1, [k.code]: 1 } })
      .toArray();
    const groups = new Map();
    for (const r of rows) {
      const g = `${r.companyId}\u0000${key(r[k.field])}`;
      if (!key(r[k.field])) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      found += 1;
      const org = list[0].companyId;
      const names = [...new Set(list.map((r) => String(r[k.field]).trim()))];
      const accounts = await db.collection("ledgeraccounts")
        .find({ companyId: org, accountName: { $in: names.map((n) => `${k.prefix}${n}`) } }, { projection: { accountCode: 1, accountName: 1, currentBalance: 1 } })
        .toArray();
      console.log(`[${org}] ${k.collection.slice(0, -1)} "${names.join('" / "')}" - ${list.length} records:`);
      for (const r of list) console.log(`    ${r[k.code] || "(no code)"}  ${r._id}  "${r[k.field]}"`);
      for (const a of accounts) console.log(`    shared account ${a.accountCode} "${a.accountName}" balance ${a.currentBalance ?? 0}`);
      console.log("");
    }
  }
  console.log(found ? `${found} name(s) shared.` : "No shared names.");
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
