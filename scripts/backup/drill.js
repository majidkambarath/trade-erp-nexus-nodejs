// A backup drill: prove a backup can actually be put back. One organisation is exported, restored into a THROWAWAY
// database, and the copy is compared with the source - every collection's row count, and the ledger's debits and credits
// per account, which is what the books are - then the throwaway database is dropped. Nothing is written to the source.
//
//   node scripts/backup/drill.js --org gulf-foods
//   node scripts/backup/drill.js --org default --db erp_test_x     (a source database other than the one in MONGO_URI)
//
// It prints one line to paste into docs/BACKUP_AND_DR.md's drill log, and exits 1 if anything differs. Run against a live
// database, rows written while the drill runs show as differences: run it when nobody is working, or read the counts.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), quiet: true });
const { MongoClient } = require("mongodb");

function parseArgs(argv) {
  const out = { org: null, db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--org") out.org = String(argv[(i += 1)] || "").trim();
    else if (a === "--db") out.db = String(argv[(i += 1)] || "").trim();
    else if (a === "--keep") out.keep = true; // leave the restored copy, to look at it
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.org) throw new Error("name the organisation with --org <code>");
  return out;
}

const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`${script} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout;
};

// What the books are, for one organisation: per account, the debits and credits of the entries that stand.
async function ledgerTotals(db, org) {
  const rows = await db.collection("ledgerentries").aggregate([
    { $match: { companyId: org, isReversed: { $ne: true } } },
    { $group: { _id: { $toString: "$accountId" }, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
  ]).toArray();
  const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return Object.fromEntries(rows.map((r) => [r._id, { debit: round(r.debit), credit: round(r.credit) }]));
}

async function drill({ org, db: sourceDb = null, keep = false } = {}) {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  const started = Date.now();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "zarvia-drill-"));
  const target = `erp_test_drill_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  // (connected only after the export and the restore have run: they run synchronously, and a connection left idle that long
  // misses its heartbeats)
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    run("export.js", ["--org", org, "--out", out, ...(sourceDb ? ["--db", sourceDb] : [])]);
    const stamp = fs.readdirSync(out).find((d) => fs.statSync(path.join(out, d)).isDirectory());
    const dir = path.join(out, stamp, org);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    run("import.js", ["--from", dir, "--confirm", "--db", target]); // verifies every file's checksum first
    await client.connect();

    const source = client.db(sourceDb || manifest.database);
    const copy = client.db(target);
    const differences = [];
    // every collection of the copy against the same collection of the source, row for row for this organisation, and the
    // whole against what the export recorded
    let restoredRows = 0;
    for (const { name } of await copy.listCollections({}, { nameOnly: true }).toArray()) {
      if (name === "organisations") continue;
      const [want, got] = await Promise.all([source.collection(name).countDocuments({ companyId: org }), copy.collection(name).countDocuments({ companyId: org })]);
      restoredRows += got;
      if (want !== got) differences.push(`${name}: ${want} rows in the source, ${got} in the copy`);
    }
    if (restoredRows !== manifest.rows) differences.push(`the copy holds ${restoredRows} rows and the export recorded ${manifest.rows}`);
    const [a, b] = await Promise.all([ledgerTotals(source, org), ledgerTotals(copy, org)]);
    const accounts = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const id of accounts) {
      if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) differences.push(`account ${id}: source ${JSON.stringify(a[id])}, copy ${JSON.stringify(b[id])}`);
    }
    const sum = (t, k) => Math.round(Object.values(t).reduce((s, r) => s + r[k], 0) * 100) / 100;
    const debit = sum(b, "debit");
    const credit = sum(b, "credit");
    if (debit !== credit) differences.push(`the restored ledger does not balance: debits ${debit}, credits ${credit}`);

    const result = {
      ok: differences.length === 0,
      organisation: org,
      rows: manifest.rows,
      files: Object.keys(manifest.sha256 || {}).length,
      accounts: accounts.size,
      debit,
      credit,
      seconds: Math.round((Date.now() - started) / 1000),
      differences,
      logLine: `| ${new Date().toISOString().slice(0, 10)} | ${org} | ${manifest.rows} rows, ${Object.keys(manifest.sha256 || {}).length} files checked | ledger ${debit} / ${credit} | ${differences.length ? `FAILED: ${differences.length} differences` : "passed"} | ${Math.round((Date.now() - started) / 1000)} s |`,
    };
    return result;
  } finally {
    if (!keep) await client.db(target).dropDatabase().catch(() => {});
    await client.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
}

module.exports = { drill };

if (require.main === module) {
  drill(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(JSON.stringify({ ...r, logLine: undefined }, null, 2));
      console.log(`\nFor docs/BACKUP_AND_DR.md:\n${r.logLine}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`drill failed: ${err.message}`);
      process.exit(1);
    });
}
