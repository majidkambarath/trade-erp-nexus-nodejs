// A closed fiscal year written to one sealed file, and read back (pure: no database).
//
// The file is gzip of one JSON document:
//   { format, organisation, fiscalYear: { id, code, startDay, endDay, closedAt }, createdAt, createdBy, version,
//     collections: { <Model>: { field, count, sha256, docs: [Extended JSON, canonical] } },
//     seal: { sha256, signature } }
// Every record is Extended JSON in its canonical form (ids, dates and numbers keep their exact types), so the same
// bytes come back out and a restored record is the record that was archived. Each collection carries the SHA-256 of
// its records; the seal is the SHA-256 of everything else plus a signature only this installation can make
// (utils/secretBox.js sign), so a file that was edited - even one whose hashes were recomputed - is refused.
const crypto = require("crypto");
const zlib = require("zlib");
const { EJSON } = require("bson");

const FORMAT = "zarvia-year-archive/1";
const PURPOSE = "year-archive";
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const canonical = (docs) => EJSON.serialize(docs, { relaxed: false });
const recordHash = (doc) => sha256(JSON.stringify(EJSON.serialize(doc, { relaxed: false })));

// what the seal covers: everything but the records themselves (their hashes stand in for them)
const sealBody = (a) => JSON.stringify({
  format: a.format,
  organisation: a.organisation,
  fiscalYear: a.fiscalYear,
  createdAt: a.createdAt,
  createdBy: a.createdBy,
  version: a.version,
  collections: Object.fromEntries(Object.entries(a.collections || {}).map(([k, c]) => [k, { field: c.field, count: c.count, sha256: c.sha256 }])),
});

/** Build the archive document and its gzip bytes. `collections` = { Model: { field, docs: [raw records] } }. */
function pack({ organisation, fiscalYear, createdAt, createdBy, version, collections }, sign) {
  const out = { format: FORMAT, organisation, fiscalYear, createdAt, createdBy, version, collections: {} };
  for (const [name, c] of Object.entries(collections)) {
    const docs = canonical(c.docs);
    out.collections[name] = { field: c.field, count: c.docs.length, sha256: sha256(JSON.stringify(docs)), docs };
  }
  const digest = sha256(sealBody(out));
  out.seal = { sha256: digest, signature: sign(PURPOSE, digest) };
  return { archive: out, bytes: zlib.gzipSync(Buffer.from(JSON.stringify(out), "utf8")) };
}

const refusal = (code, message) => Object.assign(new Error(message), { code, statusCode: 400, isOperational: true });

/**
 * Read and check a file: gzip, JSON, the format, every collection's hash and the seal. Throws ARCHIVE_UNREADABLE for
 * something that is not an archive at all, ARCHIVE_TAMPERED when the content does not match its seal.
 * -> the archive, with each collection's records turned back into ids, dates and numbers
 */
function unpack(buffer, verify) {
  let archive;
  try {
    archive = JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: 1024 * 1024 * 1024 }).toString("utf8"));
  } catch (_) {
    throw refusal("ARCHIVE_UNREADABLE", "This is not a year archive file (it could not be read)");
  }
  if (!archive || typeof archive !== "object" || archive.format !== FORMAT || !archive.collections || typeof archive.collections !== "object" || !archive.seal) {
    throw refusal("ARCHIVE_UNREADABLE", "This is not a year archive file made by this system");
  }
  for (const [name, c] of Object.entries(archive.collections)) {
    if (!c || !Array.isArray(c.docs) || c.docs.length !== c.count || sha256(JSON.stringify(c.docs)) !== c.sha256) {
      throw refusal("ARCHIVE_TAMPERED", `The ${name} records in this file do not match their checksum: it has been changed`);
    }
  }
  const digest = sha256(sealBody(archive));
  if (digest !== archive.seal.sha256 || !verify(PURPOSE, digest, archive.seal.signature)) {
    throw refusal("ARCHIVE_TAMPERED", "This file's seal does not match: it has been changed, or it was made by another installation");
  }
  const collections = {};
  for (const [name, c] of Object.entries(archive.collections)) collections[name] = { ...c, docs: EJSON.deserialize(c.docs, { relaxed: false }) };
  return { ...archive, collections };
}

/**
 * Compare the archived records with what the books hold now, per collection.
 *   missing - archived, gone from the books (these can be restored)
 *   changed - in both, different now
 *   added   - in the books for that year, not in the archive (made or reopened since)
 */
function compare(archived, live) {
  const now = new Map(live.map((d) => [String(d._id), d]));
  const was = new Set();
  const missing = [];
  let changed = 0;
  for (const d of archived) {
    const id = String(d._id);
    was.add(id);
    const l = now.get(id);
    if (!l) missing.push(d);
    else if (recordHash(l) !== recordHash(d)) changed += 1;
  }
  const added = live.filter((d) => !was.has(String(d._id))).length;
  return { archived: archived.length, live: live.length, missing, changed, added };
}

const fileName = (organisation, code) => `${String(organisation).replace(/[^A-Za-z0-9_-]/g, "")}-${String(code).replace(/[^A-Za-z0-9_-]/g, "")}-archive.json.gz`;

module.exports = { FORMAT, PURPOSE, pack, unpack, compare, recordHash, fileName, sha256 };
