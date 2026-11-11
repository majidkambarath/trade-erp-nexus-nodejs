// Return ONE organisation to the state scripts/setup/garageClient.js leaves it in: every document,
// voucher, ledger entry, movement, job card, claim, party and NUMBER COUNTER gone, with the chart of
// accounts, labour items, bays, service menu, roles, tax codes and settings untouched.
//
// It exists because a demo dataset has to be removable before a client enters real work, and the
// product cannot remove one: JobCardService.remove refuses anything past DRAFT ("cancel it instead"),
// InsuranceClaimService.remove the same, and a statutory number (SO, SR, DN, CN) is never recycled -
// so a faithful document-by-document reversal is impossible AND would leave the counters where they
// are, making the client's first real invoice SO-2026-0047. This is the blunt instrument that is
// correct for demo data and WRONG for real books. Read the refusals below before running it.
//
//   node scripts/demo/wipeOrgData.js --env=.env.golden-arrow --org=golden-arrow          (shows the plan)
//   node scripts/demo/wipeOrgData.js --env=.env.golden-arrow --org=golden-arrow --yes    (does it)
//
// Flags:
//   --env=<file>          env file, relative to the repo root (default .env)
//   --org=<code>          REQUIRED, no default - this deletes data, so it is never implied
//   --expect-host=<host>  refuse unless MONGO_URI names this host
//   --no-backup           skip the scripts/backup/export.js dump taken first
//   --out=<dir>           where that dump goes (default backups/)
//   --yes                 actually delete
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ENV_FILE = arg("env", ".env");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ENV_FILE) });

const CODE = arg("org", null);
const EXPECT_HOST = arg("expect-host", null);
const OUT = arg("out", null);

// Collections whose rows are part of the SET-UP, not of trading. Everything else that carries this
// organisation's companyId is deleted. An allowlist, not a delete-list, on purpose: a collection
// nobody thought of (a new document type, payment logs, share links) must default to being REMOVED
// rather than quietly surviving a wipe and showing up in the client's books later.
const KEEP = new Set([
  // the chart and how it posts
  "accountgroups", "ledgeraccounts", "companysettings", "fiscalyears", "currencies", "taxcodes",
  "vouchertypes",
  // masters the setup script created. `stocks` is here so the wholesale loop SKIPS it - it is then
  // handled on its own below, because it is the one collection that is part setup and part demo.
  "bays", "garageservices", "uoms", "categories", "stocks",
  // who can sign in
  "admins", "roles", "branches", "authsessions",
  // the organisation's own settings
  "messagingsettings",
  // the signed-in person's own AI chats - theirs, not trading data
  "assistantconversations", "assistantmessages", "assistantusagedays",
]);

// `stocks` is the one collection that is PART setup and PART demo: the setup created exactly these
// seven service items, and a demo adds parts beside them. Anything else in stocks is demo data.
const SETUP_SKUS = ["LAB-MECH", "LAB-ELEC", "LAB-AC", "LAB-BODY", "LAB-SERV", "SUB-WORK", "SHOP-SUP"];

// `ledgeraccounts` is the same kind of mixture. The chart proper is setup; a PARTY account is made on
// demand by services/financial/partyAccounts.js the first time a customer or vendor is saved, and is
// named after them. Deleting the parties without these leaves the chart carrying an account for every
// person who no longer exists - 18 of them after one demo run. The pattern is the one
// openingBalanceService.js uses to refuse them as opening-balance targets.
const PARTY_ACCOUNT = /^(Customer|Vendor|Customer Advance|Advance to Vendor) - /i;

// What garageClient.js leaves behind, so "did the wipe work" has an answer rather than a feeling.
const EXPECTED = {
  // 41 from utils/defaultChart.js + the 13 workshop accounts garageClient.js adds. NOT 55: that was
  // measured once after a test customer had already caused a "Customer - ..." party account to be
  // made, which is exactly the kind of row this script now removes.
  ledgeraccounts: 54, accountgroups: 19, stocks: 7, bays: 5, garageservices: 7,
  roles: 3, taxcodes: 5, uoms: 5, vouchertypes: 35, fiscalyears: 1, branches: 1,
};

const hostOf = (uri) => {
  const m = /@([^/?]+)/.exec(String(uri || ""));
  return m ? m[1] : "(could not read the host)";
};

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error(`MONGO_URI is not set. Is ${ENV_FILE} there, and does it have one?`);
  if (!CODE) throw new Error("--org=<code> is required. This deletes data, so the organisation is never implied.");
  if (process.env.NODE_ENV === "test") throw new Error("refusing to run with NODE_ENV=test");
  const host = hostOf(uri);
  if (EXPECT_HOST && !host.includes(EXPECT_HOST)) {
    throw new Error(`MONGO_URI names ${host}, not ${EXPECT_HOST}. Refusing to touch the wrong cluster.`);
  }

  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    const Organisation = require("../../models/core/organisationModel");
    const org = await Organisation.findOne({ code: CODE }).lean();
    if (!org) throw new Error(`no organisation "${CODE}" on this cluster`);

    const db = mongoose.connection.db;
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();

    // What is actually there, so the plan below is this database's truth and not this file's guess.
    const rows = [];
    for (const name of names) {
      const n = await db.collection(name).countDocuments({ companyId: CODE }).catch(() => 0);
      if (n) rows.push({ name, n });
    }

    const wipe = rows.filter((r) => !KEEP.has(r.name));
    const keep = rows.filter((r) => KEEP.has(r.name));
    const demoStock = await db.collection("stocks").countDocuments({ companyId: CODE, sku: { $nin: SETUP_SKUS } });
    const partyAccounts = await db.collection("ledgeraccounts").countDocuments({ companyId: CODE, accountName: PARTY_ACCOUNT });

    console.log("");
    console.log("  Wipe an organisation's trading data");
    console.log(`  env file     ${ENV_FILE}`);
    console.log(`  cluster      ${host}`);
    console.log(`  organisation ${CODE}  (${org.legalName})`);
    console.log("");
    console.log("  WILL BE DELETED");
    if (!wipe.length) console.log("    (nothing - this organisation has no trading data)");
    for (const r of wipe) console.log(`    ${r.name.padEnd(26)} ${String(r.n).padStart(6)}`);
    if (demoStock) console.log(`    ${"stocks (demo parts only)".padEnd(26)} ${String(demoStock).padStart(6)}`);
    if (partyAccounts) console.log(`    ${"ledgeraccounts (parties)".padEnd(26)} ${String(partyAccounts).padStart(6)}`);
    console.log("");
    console.log("  WILL BE KEPT");
    for (const r of keep) {
      const extra = r.name === "stocks" ? `  (${SETUP_SKUS.length} setup service items)` : "";
      console.log(`    ${r.name.padEnd(26)} ${String(r.n).padStart(6)}${extra}`);
    }
    console.log("");

    if (!flag("yes")) {
      console.log("  Nothing was deleted. Add --yes to go ahead.");
      console.log("");
      return;
    }

    // A copy first. export.js reads one organisation only - every read runs inside runWithTenant, so
    // the tenant plugin writes the filter and the script cannot widen it. It loads .env by absolute
    // path and dotenv does not override, so MONGO_URI passed here wins.
    if (!flag("no-backup")) {
      console.log("  Taking a backup first...");
      const args = [path.resolve(__dirname, "..", "backup", "export.js"), "--org", CODE];
      if (OUT) args.push("--out", OUT);
      execFileSync(process.execPath, args, {
        stdio: "inherit",
        env: { ...process.env, MONGO_URI: uri },
      });
      console.log("");
    } else {
      console.log("  --no-backup: no copy was taken.");
    }

    console.log("  Deleting...");
    let total = 0;
    for (const r of wipe) {
      const res = await db.collection(r.name).deleteMany({ companyId: CODE });
      total += res.deletedCount;
      console.log(`    ${r.name.padEnd(26)} ${String(res.deletedCount).padStart(6)} removed`);
    }
    if (demoStock) {
      const res = await db.collection("stocks").deleteMany({ companyId: CODE, sku: { $nin: SETUP_SKUS } });
      total += res.deletedCount;
      console.log(`    ${"stocks (demo parts)".padEnd(26)} ${String(res.deletedCount).padStart(6)} removed`);
    }
    if (partyAccounts) {
      const res = await db.collection("ledgeraccounts").deleteMany({ companyId: CODE, accountName: PARTY_ACCOUNT });
      total += res.deletedCount;
      console.log(`    ${"ledgeraccounts (parties)".padEnd(26)} ${String(res.deletedCount).padStart(6)} removed`);
    }
    console.log(`    ${"".padEnd(26)} ${String(total).padStart(6)} rows in all`);

    // Did it work? Measured, not assumed.
    console.log("");
    console.log("  Back to the post-setup state?");
    let wrong = 0;
    for (const [name, want] of Object.entries(EXPECTED)) {
      const got = await db.collection(name).countDocuments({ companyId: CODE }).catch(() => 0);
      const ok = got === want;
      if (!ok) wrong += 1;
      console.log(`    ${name.padEnd(20)} ${String(got).padStart(4)}  want ${String(want).padStart(4)}  ${ok ? "ok" : "<-- DIFFERS"}`);
    }
    for (const name of ["transactions", "vouchers", "ledgerentries", "customers", "numberseries", "issuednumbers"]) {
      const got = await db.collection(name).countDocuments({ companyId: CODE }).catch(() => 0);
      if (got) wrong += 1;
      console.log(`    ${name.padEnd(20)} ${String(got).padStart(4)}  want    0  ${got ? "<-- DIFFERS" : "ok"}`);
    }
    console.log("");
    if (wrong) {
      console.log(`  ${wrong} count(s) differ. A figure ABOVE the expected one usually means the setup script`);
      console.log("  was re-run and made something twice; BELOW it means the wipe took too much. Compare");
      console.log("  against scripts/setup/README.md before seeding on top of this.");
    } else {
      console.log("  Clean. The next document issued will be number 0001 of its series.");
    }
    console.log("");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("");
  console.error(`  wipe failed: ${error.message}`);
  console.error("");
  process.exit(1);
});
