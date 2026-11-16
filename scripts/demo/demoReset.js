// Return ONE demonstration organisation to a clean, freshly provisioned state, for any industry:
// every document, voucher, ledger entry, party, item, chart account, setting and NUMBER COUNTER of
// that organisation is deleted, then OrganisationService.provision() builds the chart, tax codes,
// currency and fiscal year again. Who can sign in (admins, roles, branches) is kept, so the same
// logins work after the reset.
//
// THE GUARD THAT MATTERS: it refuses unless Organisation.demo === true. Demonstration companies sit
// on the same cluster as live clients, and this is the blunt instrument that is correct for demo
// data and catastrophic for real books. Set the flag in the developer console (organisation update
// `demo: true`) before the first run.
//
//   node scripts/demo/demoReset.js --env=.env --org=sahara-gate --dry-run     (shows the plan)
//   node scripts/demo/demoReset.js --env=.env --org=sahara-gate --yes         (does it)
//
// Flags: --env=<file> (relative to the repo root, default .env), --org=<code> (REQUIRED),
//        --expect-host=<host> (refuse unless MONGO_URI names it), --yes, --dry-run (the default
//        without --yes). No backup is taken: demo data is rebuilt, not restored.
const path = require("path");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Rows that are NOT trading data and survive a reset. An allowlist, on purpose: a collection nobody
// thought of (a new document type, share links, logs) must default to being REMOVED rather than
// surviving a reset and appearing in tomorrow's demo.
const KEEP = new Set([
  "admins", "roles", "branches", "authsessions", // who can sign in
  "messagingsettings",                           // the organisation's own sending setup
  "assistantconversations", "assistantmessages", "assistantusagedays",
]);

const hostOf = (uri) => {
  const m = /@([^/?]+)/.exec(String(uri || ""));
  return m ? m[1] : "(could not read the host)";
};

// Every refusal in one pure place so a test can pin it without a database.
function assertResettable({ org, code, uri, expectHost, nodeEnv }) {
  if (!uri) throw new Error("MONGO_URI is not set.");
  if (!code) throw new Error("--org=<code> is required. This deletes data, so the organisation is never implied.");
  if (nodeEnv === "test") throw new Error("refusing to run with NODE_ENV=test");
  const host = hostOf(uri);
  if (expectHost && !host.includes(expectHost)) {
    throw new Error(`MONGO_URI names ${host}, not ${expectHost}. Refusing to touch the wrong cluster.`);
  }
  if (!org) throw new Error(`no organisation "${code}" on this cluster`);
  if (org.demo !== true) {
    throw new Error(`organisation "${code}" is not marked as a demonstration company (demo: true), so it will not be reset.`);
  }
  return host;
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", "..", arg("env", ".env")) });
  const code = arg("org", null);
  const uri = process.env.MONGO_URI;
  const mongoose = require("mongoose");
  const Organisation = require("../../models/core/organisationModel");
  // Judge the guards that need no database first, so a missing flag never costs a connection.
  assertResettable({ org: { demo: true }, code, uri, expectHost: arg("expect-host", null), nodeEnv: process.env.NODE_ENV });
  await mongoose.connect(uri);
  try {
    const org = await Organisation.findOne({ code }).lean();
    const host = assertResettable({ org, code, uri, expectHost: arg("expect-host", null), nodeEnv: process.env.NODE_ENV });

    const db = mongoose.connection.db;
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    const rows = [];
    for (const name of names) {
      if (KEEP.has(name)) continue;
      const n = await db.collection(name).countDocuments({ companyId: code }).catch(() => 0);
      if (n) rows.push({ name, n });
    }

    console.log(`\n  Reset demonstration company ${code} (${org.legalName}) on ${host}`);
    if (!rows.length) console.log("    (nothing to delete)");
    for (const r of rows) console.log(`    ${r.name.padEnd(26)} ${String(r.n).padStart(6)}`);

    if (!flag("yes")) {
      console.log("\n  Nothing was deleted. Add --yes to go ahead.\n");
      return;
    }

    let total = 0;
    for (const r of rows) total += (await db.collection(r.name).deleteMany({ companyId: code })).deletedCount;
    console.log(`\n  Deleted ${total} rows. Provisioning again...`);

    const OrganisationService = require("../../services/core/organisationService");
    const provisioning = await OrganisationService.provision(code);
    console.log("  Provisioned:", JSON.stringify(provisioning && provisioning.provisioning ? provisioning.provisioning : provisioning));
    console.log("");
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { assertResettable, KEEP, hostOf };

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n  demoReset: ${e.message}\n`);
    process.exit(1);
  });
}
