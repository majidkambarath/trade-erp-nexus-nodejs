// Put one organisation's exported rows back, into a database where that organisation does not exist.
//
// This is the half that makes the other half a backup rather than a hope. An export nobody has restored is
// not a backup, so the procedure below is meant to be REHEARSED on a throwaway database before it is needed.
//
//   node scripts/backup/import.js --from backups/<stamp>/gulf-foods --confirm
//
// It REFUSES to write into an organisation that already holds anything. A restore is not a merge: putting
// rows back on top of live ones would duplicate what survived and leave the books neither one thing nor the
// other. So a restore goes into a DATABASE OF ITS OWN - point MONGO_URI at an empty one, check the books
// there, and only then decide what to do with the live one.
//
// There is deliberately no "restore it under another code beside the original": every row keeps its own _id
// so that the references between them (a voucher to its ledger rows, a line to its item) still resolve.
// Minting new ids would mean rewriting every one of those references, and a restore that gets one wrong is
// worse than no restore. Admin.email is globally unique too, so a second copy of the same people cannot
// coexist with the first whatever their organisation is called.
//
// It writes through the raw driver on purpose, bypassing utils/tenantPlugin.js, because the rows already
// carry their companyId and must go back EXACTLY as they were - _id included, so every reference between
// them still resolves. Every row is checked against the organisation being restored before anything is
// written, so the bypass cannot be used to smuggle rows into a different organisation.
//
// WHAT IT CANNOT PUT BACK: the attachment files (see the manifest's attachments.keys). Copy those into
// uploads/attachments separately, or the rows will point at files that are not there.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const fs = require("fs");
const mongoose = require("mongoose");
const { EJSON } = require("bson");

(function loadModels(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) loadModels(p);
    else if (p.endsWith(".js")) require(path.resolve(p));
  }
})(path.resolve(__dirname, "..", "..", "models"));

const Organisation = require("../../models/core/organisationModel");

function parseArgs(argv) {
  const out = { from: null, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm") out.confirm = true;
    else if (a === "--from") out.from = path.resolve(String(argv[(i += 1)] || ""));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.from) throw new Error("--from <directory> is required (one organisation's directory of an export)");
  if (!out.confirm) throw new Error("add --confirm: this writes to the database named by MONGO_URI");
  return out;
}

const readNdjson = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => EJSON.parse(l));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.from, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest.json in ${args.from}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const organisation = manifest.organisation;

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`restoring "${organisation}" into database ${mongoose.connection.name}`);
  console.log(`taken ${manifest.takenAt} from ${manifest.database}, ${manifest.rows} rows`);

  // Refuse onto anything that already exists. Checked BEFORE a single write, across every collection the
  // export covers, so a half-restore is not a state this script can produce.
  if (await Organisation.exists({ code: organisation })) throw new Error(`organisation "${organisation}" already exists here: point MONGO_URI at an empty database`);
  const models = mongoose.modelNames().map((n) => mongoose.model(n)).filter((m) => m.schema.options.tenantScoped);
  for (const Model of models) {
    const n = await Model.collection.countDocuments({ companyId: organisation });
    if (n > 0) throw new Error(`${Model.modelName} already holds ${n} rows for "${organisation}": a restore is not a merge`);
  }

  // The registry row first: without it authenticateToken refuses every account of the organisation.
  const orgPath = path.join(args.from, "_organisation.json");
  if (!fs.existsSync(orgPath)) throw new Error(`no _organisation.json in ${args.from}`);
  await Organisation.collection.insertOne(EJSON.parse(fs.readFileSync(orgPath, "utf8")));

  const written = {};
  for (const Model of models) {
    const file = path.join(args.from, `${Model.modelName}.ndjson`);
    if (!fs.existsSync(file)) { written[Model.modelName] = 0; continue; }
    const rows = readNdjson(file);
    // every row must belong to the organisation this export says it is; one that does not means the wrong
    // directory was passed, and that is a refusal, not something to filter out quietly
    const stray = rows.find((r) => r.companyId !== organisation);
    if (stray) throw new Error(`${Model.modelName}: a row carries companyId "${stray.companyId}", not "${organisation}" - wrong directory?`);
    // ordered: true on purpose - stop at the first row that will not go in rather than write round it and
    // leave a restore that is missing rows the count check only notices at the end
    if (rows.length) await Model.collection.insertMany(rows, { ordered: true });
    written[Model.modelName] = rows.length;
  }

  const total = Object.values(written).reduce((a, b) => a + b, 0);
  const expected = manifest.rows;
  for (const [name, n] of Object.entries(written)) if (n) console.log(`  ${name.padEnd(28)} ${String(n).padStart(8)}`);
  console.log(`\n${total} rows written (the export recorded ${expected})`);
  if (total !== expected) throw new Error("the row count does not match the manifest: do not use this restore");
  if (manifest.attachments?.count) {
    console.log(`\n${manifest.attachments.count} attachment FILES are not in this backup, and are not restored.`);
    console.log("The rows above still name the assets of the organisation this backup came FROM: for a copy");
    console.log("that is fine to read, but deleting a file here would delete the original's. Keys: manifest.json.");
  }
  console.log("\nNow check it by hand: sign in, open the trial balance, and confirm it balances.");
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`import refused: ${err.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
