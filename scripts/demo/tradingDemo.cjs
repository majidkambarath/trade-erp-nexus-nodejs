// A believable foodstuff trading company, 13 months of it ending TODAY, written into a demonstration
// organisation through the product's own HTTP API. It is the company the sales kit's demo script
// (trade erp/docs/sales-kit/demo-script.md, demo-company.md) is written for.
//
//   E=owner@example.com P='owner password' node scripts/demo/tradingDemo.cjs --env=.env --org=test --yes
//
// The backend must be RUNNING (BASE, default http://localhost:3000/api/v1) and pointed at the cluster
// the env file names. Flags:
//   --env=<file>          env file relative to the repo root (default .env), read for MONGO_URI
//   --org=<code>          REQUIRED. The organisation must be marked demo: true, and have no trading yet
//                         (run scripts/demo/demoReset.js first for a second run)
//   --expect-host=<host>  refuse unless MONGO_URI names this host
//   --phase=a,b           run only some phases: prep, setup, people, trading, story, bank, vat, finish
//   --yes                 actually write (without it the plan is printed and nothing is touched)
// Environment: E / P = the organisation owner's sign-in; DEMO_PASSWORD = the password given to the
// demo people (default below); BASE = the API.
//
// Why HTTP and not the services in process (as workshopDemo.js does): the second-approver story needs
// a different person to approve, and every rule a click-through hits (period lock, credit control,
// approval limits) stays in force - a seeder that bypassed them would hide the very failures a
// demo is likely to meet.
const path = require("path");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", arg("env", ".env")) });

const lib = require("./trading/lib.cjs");
const { setup, COMPANY } = require("./trading/setup.cjs");

const CODE = arg("org", null);
const ONLY = (arg("phase", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const runs = (p) => !ONLY.length || ONLY.includes(p);
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "Demo@Sahara2026";
const hostOf = (uri) => { const m = /@([^/?]+)/.exec(String(uri || "")); return m ? m[1] : "(unknown)"; };
const log = (...a) => console.log(`  [${new Date().toISOString().slice(11, 19)}]`, ...a);

// The three people the script uses (Act 5), besides the owner who gives the demo.
const PEOPLE = [
  { name: "Fatima Hassan", email: "fatima@saharagate.example.com", role: "accountant" },
  { name: "Ravi Menon", email: "ravi@saharagate.example.com", role: "sales" },
  { name: "Auditor", email: "auditor@saharagate.example.com", role: "viewer" },
];

// "Today" and the first day of the month thirteen months back, as plain days.
function dates() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 13, 1));
  return { today, start };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set: is the env file there?");
  if (!CODE) throw new Error("--org=<code> is required; this script never creates an organisation.");
  if (process.env.NODE_ENV === "test") throw new Error("refusing to run with NODE_ENV=test");
  if (!process.env.E || !process.env.P) throw new Error("Set E and P to the organisation owner's email and password.");
  const host = hostOf(uri);
  const expect = arg("expect-host", null);
  if (expect && !host.includes(expect)) throw new Error(`MONGO_URI names ${host}, not ${expect}. Refusing.`);

  const { today, start } = dates();
  console.log("");
  console.log("  Seed Sahara Gate: 13 months of trading");
  console.log(`  cluster      ${host}`);
  console.log(`  organisation ${CODE}`);
  console.log(`  api          ${lib.BASE}`);
  console.log(`  dates        ${lib.iso(start)} .. ${lib.iso(today)}`);
  console.log(`  phases       ${ONLY.length ? ONLY.join(", ") : "all"}`);
  console.log("");
  if (!flag("yes")) { console.log("  Nothing was written. Add --yes to go ahead.\n"); return; }

  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    const Organisation = require("../../models/core/organisationModel");
    const org = await Organisation.findOne({ code: CODE }).lean();
    if (!org) throw new Error(`no organisation "${CODE}" on this cluster`);
    if (org.demo !== true) throw new Error(`organisation "${CODE}" is not marked as a demonstration company (demo: true). Refusing to write.`);
    require("../../utils/orgLocale").warm(org);
    const { runWithTenant } = require("../../utils/tenantContext");

    const owner = lib.client(process.env.E, process.env.P);
    const ctx = {
      api: owner.api, START: lib.iso(start), TODAY: lib.iso(today), today, start, ids: {}, log, org,
      peopleApis: {}, R: lib.rng(0x5a4a1a), DEMO_PASSWORD,
    };

    // A second run on an organisation that already trades would double everything, so it is refused.
    const Transaction = require("../../models/modules/transactionModel");
    const trading = await runWithTenant({ companyId: CODE, branchId: "main" }, () => Transaction.countDocuments());
    if (trading > 0 && runs("setup")) throw new Error(`"${CODE}" already holds ${trading} trade documents. Run scripts/demo/demoReset.js first.`);

    if (runs("prep")) {
      console.log("  prep...");
      const OrganisationService = require("../../services/core/organisationService");
      await OrganisationService.update(CODE, { planCode: "premium", legalName: COMPANY });
      log("plan set to premium, legal name", COMPANY);
    }
    if (runs("setup")) { console.log("  setup..."); await setup(ctx); }
    if (runs("people")) { console.log("  people..."); await require("./trading/people.cjs").people(ctx, PEOPLE, mongoose); }
    else for (const p of PEOPLE) ctx.peopleApis[p.role] = lib.client(p.email, DEMO_PASSWORD);
    // Later phases may run in their own process: rebuild what setup found.
    if (!runs("setup")) await require("./trading/setup.cjs").loadIds(ctx);
    for (const [name, file] of [["trading", "trade"], ["story", "story"], ["bank", "bank"], ["vat", "vat"], ["finish", "finish"]]) {
      if (!runs(name)) continue;
      console.log(`  ${name}...`);
      await require(`./trading/${file}.cjs`)[name === "trading" ? "trade" : name](ctx);
    }
    console.log("\n  Done.\n");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`\n  seed failed: ${error.message}\n`);
  process.exit(1);
});
