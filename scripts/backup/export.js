// Take a copy of ONE organisation's data, or of everything, as NDJSON: one file per collection.
//
// Why this exists and not just mongodump. Every client shares one database, tagged by companyId, so an Atlas
// snapshot is all of them at once: restoring it to put one client's month back would roll the OTHER client
// back too. That blast radius is the thing to avoid the day there is more than one paying client.
//
// Why it cannot leak. Every read runs inside runWithTenant, so utils/tenantPlugin.js itself puts the
// companyId on the query. The script does not write the filter and so cannot get it wrong: asked for one
// organisation it is incapable of reading another's rows, which is a stronger promise than a --query I typed.
// branchView is left null, which the plugin reads as every branch, so a client's branches all come out.
//
//   node scripts/backup/export.js --org gulf-foods
//   node scripts/backup/export.js --all --out D:/backups
//
// Rows are Extended JSON (one per line), so an ObjectId stays an ObjectId and a date stays a date. Plain
// JSON.stringify would hand them back as strings and the restore would be subtly wrong everywhere.
//
// WHAT IS NOT IN HERE: the attachment FILES. They are on the server's disk (services/core/attachmentService.js
// writes under uploads/attachments), not in the database. The manifest counts them and lists their keys, so a
// restore can at least say what is missing. Copy that directory separately.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const fs = require("fs");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const { runWithTenant } = require("../../utils/tenantContext");

// Every model file, so mongoose.models is complete before we ask which are tenanted. Same walk as
// utils/__tests__/tenantGuard.test.js: a model nobody required is a collection nobody would back up.
(function loadModels(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) loadModels(p);
    else if (p.endsWith(".js")) require(path.resolve(p));
  }
})(path.resolve(__dirname, "..", "..", "models"));

const Organisation = require("../../models/core/organisationModel");

function parseArgs(argv) {
  const out = { orgs: [], all: false, outDir: path.resolve(__dirname, "..", "..", "backups") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--org") out.orgs.push(String(argv[(i += 1)] || "").trim());
    else if (a === "--out") out.outDir = path.resolve(String(argv[(i += 1)] || ""));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.all && out.orgs.length === 0) throw new Error("name an organisation with --org <code>, or --all");
  if (out.orgs.some((c) => !c)) throw new Error("--org needs a code");
  return out;
}

const tenantedModels = () =>
  mongoose
    .modelNames()
    .map((n) => mongoose.model(n))
    .filter((m) => m.schema.options.tenantScoped)
    .sort((a, b) => a.modelName.localeCompare(b.modelName));

// One organisation, one directory. The Organisation row itself comes from the registry, which is deliberately
// NOT tenanted (its code IS the companyId), so it is read by code outside any scope.
async function exportOrganisation(code, dir) {
  const org = await Organisation.findOne({ code }).lean();
  if (!org) throw new Error(`no organisation with code "${code}"`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "_organisation.json"), EJSON.stringify(org, undefined, 2), "utf8");

  const counts = {};
  const attachmentKeys = [];
  await runWithTenant({ companyId: code, branchId: "main" }, async () => {
    for (const Model of tenantedModels()) {
      const file = path.join(dir, `${Model.modelName}.ndjson`);
      const handle = fs.openSync(file, "w");
      let n = 0;
      try {
        // a cursor, not find().lean(): a 512 MB instance must not hold a whole ledger in memory
        for await (const doc of Model.find({}).lean().cursor()) {
          fs.writeSync(handle, `${EJSON.stringify(doc)}\n`);
          n += 1;
          if (Model.modelName === "Attachment" && doc.key) attachmentKeys.push(doc.key);
        }
      } finally {
        fs.closeSync(handle);
      }
      if (n === 0) fs.unlinkSync(file); // an empty file says nothing; the manifest records the zero
      counts[Model.modelName] = n;
    }
  });

  const manifest = {
    organisation: code,
    legalName: org.legalName || null,
    takenAt: new Date().toISOString(),
    database: mongoose.connection.name,
    format: "ndjson-ejson",
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    attachments: {
      count: attachmentKeys.length,
      note: "these files are on the server's disk under uploads/attachments and are NOT in this backup",
      keys: attachmentKeys,
    },
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

// The console's own people and its log belong to no organisation, so they are their own file and only with
// --all. It carries password hashes and encrypted two-factor secrets: treat the directory as a secret.
async function exportPlatform(dir) {
  const out = {};
  for (const name of ["PlatformUser", "PlatformAudit"]) {
    if (!mongoose.modelNames().includes(name)) continue;
    const rows = await mongoose.model(name).find({}).lean();
    fs.writeFileSync(path.join(dir, `${name}.ndjson`), rows.map((r) => `${EJSON.stringify(r)}\n`).join(""), "utf8");
    out[name] = rows.length;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(args.outDir, stamp);
  fs.mkdirSync(root, { recursive: true });

  const codes = args.all ? (await Organisation.find().select("code").lean()).map((o) => o.code) : args.orgs;
  if (codes.length === 0) throw new Error("there are no organisations to export");

  const done = [];
  for (const code of codes) {
    const m = await exportOrganisation(code, path.join(root, code));
    done.push(m);
    console.log(`  ${code.padEnd(24)} ${String(m.rows).padStart(8)} rows${m.attachments.count ? `, ${m.attachments.count} attachment files NOT included` : ""}`);
  }
  if (args.all) {
    const p = await exportPlatform(root);
    console.log(`  (console)${" ".repeat(16)} ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }

  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), database: mongoose.connection.name, organisations: done.map((m) => ({ organisation: m.organisation, rows: m.rows, attachments: m.attachments.count })) }, null, 2),
    "utf8"
  );
  console.log(`\nWritten to ${root}`);
  console.log("Restore with: node scripts/backup/import.js --from <that directory>/<org code> --confirm");
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`export refused: ${err.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
