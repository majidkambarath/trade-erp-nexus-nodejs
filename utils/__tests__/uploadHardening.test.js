// Pictures and logos are judged on what they declare, what they are called and what they actually contain, before anything is sent to
// storage. Driven through a real multer with a stand-in for the storage engine, so nothing is uploaded anywhere.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");
const { sniffImage, fileFilter, safeUploadName, checkedStorage, handleUploadError } = require("../../middleware/upload");
const errorHandler = require("../errorHandler");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 2, 3, 4]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.from("VP8 ")]);

test("the first bytes say what an image is", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.from("<script>alert(1)</script>")), null);
  assert.equal(sniffImage(Buffer.from("GIF89a")), null, "a kind we do not take");
  assert.equal(sniffImage(Buffer.from("RIFF....WAVE")), null, "RIFF alone is not WEBP");
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("the declared type and the ending must agree and be one of the three", () => {
  const run = (originalname, mimetype) => new Promise((resolve) => fileFilter({}, { originalname, mimetype }, (err, ok) => resolve({ err, ok })));
  return Promise.all([
    run("logo.png", "image/png").then((r) => assert.equal(r.ok, true)),
    run("PHOTO.JPG", "image/jpeg").then((r) => assert.equal(r.ok, true)),
    run("pic.jpeg", "image/jpg").then((r) => assert.equal(r.ok, true)),
    run("pic.webp", "image/webp").then((r) => assert.equal(r.ok, true)),
    run("logo.svg", "image/svg+xml").then((r) => assert.equal(r.ok, false)),
    run("logo.svg", "image/png").then((r) => assert.equal(r.ok, false, "an svg that says it is a png")),
    run("logo.png", "text/html").then((r) => assert.equal(r.ok, false)),
    run("logo.html", "image/png").then((r) => assert.equal(r.ok, false)),
    run("logo.png.html", "image/png").then((r) => assert.equal(r.ok, false)),
    run("logo", "image/png").then((r) => assert.equal(r.ok, false), "no ending at all"),
    run("logo.png", "image/jpeg").then((r) => assert.equal(r.ok, false, "a png ending on a jpeg declaration")),
  ]);
});

test("a stored name is ours: no path, no punctuation, no way to guess the next one", () => {
  const names = ["../../etc/passwd.png", "a b.c.png", "ünï.png", "x".repeat(300) + ".png", "", undefined, "..\\..\\win.png", "a/b/c.png"].map(safeUploadName);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_-]{1,40}_\d+_[0-9a-f]{12}$/, n);
  assert.notEqual(safeUploadName("a.png"), safeUploadName("a.png"), "two uploads of one name never collide");
});

// ---- through a real multer, with a stand-in for storage ----
function app() {
  const stored = [];
  const inner = {
    _handleFile(req, file, cb) {
      const chunks = [];
      file.stream.on("data", (c) => chunks.push(c));
      file.stream.on("end", () => { const buffer = Buffer.concat(chunks); stored.push({ name: file.originalname, buffer }); cb(null, { path: "https://storage.example/x", filename: "x", size: buffer.length }); });
      file.stream.on("error", cb);
    },
    _removeFile(req, file, cb) { cb(null); },
  };
  const upload = multer({ storage: checkedStorage(inner), fileFilter, limits: { fileSize: 5 * 1024 * 1024, files: 2 } });
  const a = express();
  a.post("/up", upload.single("logo"), handleUploadError, (req, res) => res.json({ ok: true, stored: stored.length }));
  a.use(errorHandler);
  return { a, stored };
}
async function send(server, { name, type, content, field = "logo" }) {
  const form = new FormData();
  form.append("note", "hello");
  form.append(field, new Blob([content], { type }), name);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/up`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("a real image goes through unchanged; a page of script named like one never reaches storage", async () => {
  const { a, stored } = app();
  const server = await new Promise((resolve) => { const s = a.listen(0, () => resolve(s)); });
  try {
    const good = await send(server, { name: "logo.png", type: "image/png", content: PNG });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(stored.length, 1);
    assert.ok(stored[0].buffer.equals(PNG), "every byte arrived, the ones that were looked at included");
    const big = Buffer.concat([JPEG, Buffer.alloc(200000, 7)]);
    const goodJpeg = await send(server, { name: "p.jpg", type: "image/jpeg", content: big });
    assert.equal(goodJpeg.status, 200);
    assert.ok(stored[1].buffer.equals(big), "a larger file arrives whole");

    for (const [name, type, content] of [
      ["logo.png", "image/png", "<script>alert(1)</script>"],
      ["logo.png", "image/png", "<svg onload='alert(1)'/>"],
      ["logo.jpg", "image/jpeg", PNG], // a png in a jpeg's clothes
      ["logo.png", "image/png", ""], // nothing at all
      ["logo.png", "image/png", "ab"], // too short to be anything
      ["logo.svg", "image/png", "<svg onload='alert(1)'/>"],
      ["logo.html", "text/html", "<script>alert(1)</script>"],
    ]) {
      const r = await send(server, { name, type, content });
      assert.equal(r.status, 400, `${name} (${type}): ${JSON.stringify(r.body)}`);
      assert.ok(["FILE_CONTENT_MISMATCH", "FILE_TYPE_NOT_ALLOWED"].includes(r.body.errorCode), r.body.errorCode);
    }
    assert.equal(stored.length, 2, "none of those was stored");
  } finally {
    server.close();
  }
});
