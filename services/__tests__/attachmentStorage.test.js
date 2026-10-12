// Where an attachment's bytes live, against a throwaway database and a STUBBED Cloudinary (no network, so CI
// needs no account and nothing is uploaded to a real one).
//
// Why this exists: the bytes used to be written under uploads/attachments on the server itself. A Render
// instance's disk does not survive a deploy or a restart, so the files vanished while these rows stayed, and
// a client clicked a document that was no longer anywhere. New files go to Cloudinary; the rows written
// before that still say "disk" and must still be read from disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let Att, Attachment, cloudinary, ctx, realFetch;
const store = new Map(); // the stub's "Cloudinary": publicId -> bytes
const calls = { uploads: [], signed: [], destroyed: [] };

const pdf = (n = 64) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(n, 7)]);
const file = (name, buf) => ({ originalname: name, buffer: buf, size: buf.length });
const as = (fn) => ctx.runWithTenant({ companyId: "attstore", branchId: "main" }, fn);
const read = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  ctx = require("../../utils/tenantContext");
  Att = require("../core/attachmentService");
  Attachment = require("../../models/modules/financial/attachmentModel");
  cloudinary = require("../../config/cloudinary");
  await mongoose.connection.syncIndexes();

  // The service holds the same singleton, so replacing these methods is enough: it calls them, not the network.
  cloudinary.uploader.upload_stream = (opts, cb) => {
    const chunks = [];
    return {
      end: (buf) => {
        chunks.push(buf);
        const publicId = `${opts.public_id}.${opts.format}`;
        store.set(publicId, Buffer.concat(chunks));
        calls.uploads.push({ publicId, ...opts });
        cb(null, { public_id: publicId, bytes: buf.length, type: opts.type, resource_type: opts.resource_type });
      },
    };
  };
  cloudinary.utils.private_download_url = (publicId, format, opts) => {
    calls.signed.push({ publicId, format, opts });
    return `https://stub.invalid/${encodeURIComponent(publicId)}`;
  };
  cloudinary.uploader.destroy = async (publicId, opts) => {
    calls.destroyed.push({ publicId, ...opts });
    const had = store.delete(publicId);
    return { result: had ? "ok" : "not found" };
  };
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const publicId = decodeURIComponent(String(url).replace("https://stub.invalid/", ""));
    const bytes = store.get(publicId);
    if (!bytes) return { ok: false, status: 404, body: null };
    return { ok: true, status: 200, body: new Response(bytes).body }; // a web stream, as a real fetch gives
  };
});

test.after(async () => {
  if (skip) return;
  if (realFetch) global.fetch = realFetch;
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("a new file goes to Cloudinary, private and raw, and nothing is written to the instance's disk", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "cloudinary";
  const bytes = pdf(1024);
  const row = await as(() => Att.save(file("Trade licence.pdf", bytes), { uploadedBy: "tester", label: "Licence" }));

  assert.equal(row.storage, "cloudinary");
  assert.ok(row.publicId, "the asset id is kept, or the bytes could never be found again");
  assert.equal(row.mimeType, "application/pdf");
  assert.equal(row.size, bytes.length);

  const up = calls.uploads.at(-1);
  assert.equal(up.resource_type, "raw", "a PDF or a spreadsheet must not be treated as an image to transform");
  assert.equal(up.type, "private", "a plain address must not open it");
  assert.match(up.public_id, /^erp_attachments\/attstore\/\d{4}\//, "the organisation is in the id, so a stray asset can be traced back");
  assert.match(up.public_id, /[0-9a-f]{32}$/, "and the name is random, so nothing is guessable");
  assert.equal(up.format, "pdf");

  // the whole point: the server's own disk is untouched
  assert.equal(fs.existsSync(path.join(Att.ROOT, ...row.key.split("/"))), false);
});

test("it reads back the same bytes, through a signed address that never reaches the client", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "cloudinary";
  const bytes = pdf(2048);
  const row = await as(() => Att.save(file("Statement.pdf", bytes), {}));
  const fresh = await as(() => Attachment.findById(row._id));

  assert.ok((await read(await Att.open(fresh))).equals(bytes), "the bytes come back exactly");

  const signed = calls.signed.at(-1);
  assert.equal(signed.publicId, row.publicId);
  assert.equal(signed.format, "pdf", "the extension is taken from the stored key");
  assert.equal(signed.opts.type, "private");
  assert.ok(signed.opts.expires_at > Math.floor(Date.now() / 1000), "the address is short lived");
  assert.ok(signed.opts.expires_at <= Math.floor(Date.now() / 1000) + 120);

  // a path on disk is not an answer for this row, and a caller that asks must hear so rather than get a bad one
  assert.throws(() => Att.filePath(fresh), /not on the server's disk/);
});

test("deleting takes the asset as well as the row", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "cloudinary";
  const row = await as(() => Att.save(file("Gone.pdf", pdf()), {}));
  await as(() => Att.remove(row._id, undefined));
  assert.equal(await as(() => Attachment.findById(row._id)), null, "the row is gone");
  assert.equal(calls.destroyed.at(-1).publicId, row.publicId);
  assert.equal(store.has(row.publicId), false, "and so are the bytes: no orphan left paid for");
});

test("a row that Cloudinary has lost is 410, not a broken stream", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "cloudinary";
  const row = await as(() => Att.save(file("Vanished.pdf", pdf()), {}));
  store.delete(row.publicId); // as if it were deleted behind our back
  const fresh = await as(() => Attachment.findById(row._id));
  await assert.rejects(() => Att.open(fresh), (e) => e.statusCode === 410);
});

test("an upload that fails writes no row: a record of a file nobody has is worse than a refusal", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "cloudinary";
  const good = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = (_o, cb) => ({ end: () => cb(new Error("quota exceeded")) });
  try {
    const before = await as(() => Attachment.countDocuments({}));
    await assert.rejects(() => as(() => Att.save(file("Nope.pdf", pdf()), {})), (e) => e.code === "ATTACHMENT_STORE_FAILED" && e.statusCode === 502);
    assert.equal(await as(() => Attachment.countDocuments({})), before, "nothing was recorded");
  } finally {
    cloudinary.uploader.upload_stream = good;
  }
});

test("the rows written before this still read from disk, and disk is still what an unconfigured server uses", { skip }, async () => {
  process.env.ATTACHMENT_STORAGE = "disk";
  const bytes = pdf(512);
  const row = await as(() => Att.save(file("Old.pdf", bytes), {}));
  assert.equal(row.storage, "disk");
  assert.equal(row.publicId, null);

  const full = path.join(Att.ROOT, ...row.key.split("/"));
  assert.ok(fs.existsSync(full), "it really is on disk");
  const fresh = await as(() => Attachment.findById(row._id));
  assert.ok((await read(await Att.open(fresh))).equals(bytes));

  // a row stored before the field existed has no `storage` at all: the default must read it as disk, because
  // that is where it is. Written straight to the collection so no default is applied on the way in.
  await as(() => Attachment.collection.insertOne({ companyId: "attstore", key: row.key.replace(/[0-9a-f]{8}/, "deadbeef"), originalName: "Legacy.pdf", mimeType: "application/pdf", size: 1, createdAt: new Date(), updatedAt: new Date() }));
  const legacy = await as(() => Attachment.findOne({ originalName: "Legacy.pdf" }));
  assert.equal(legacy.storage, "disk", "no storage recorded means disk, never Cloudinary");

  await as(() => Att.remove(row._id, undefined));
  assert.equal(fs.existsSync(full), false, "and deleting still removes the file");
  delete process.env.ATTACHMENT_STORAGE;
});
