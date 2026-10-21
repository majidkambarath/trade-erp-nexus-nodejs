const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const mongoose = require("mongoose");
const Attachment = require("../../models/modules/financial/attachmentModel");
const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");
const cloudinary = require("../../config/cloudinary");
const { getTenant } = require("../../utils/tenant");

const ROOT = path.resolve(__dirname, "..", "..", "uploads", "attachments");
const MAX_BYTES = 10 * 1024 * 1024;

// Where NEW files go. Cloudinary when it is configured, because the server's own disk does not survive a
// deploy: files written there were lost while their rows stayed, so a client opened a document that was gone.
// ATTACHMENT_STORAGE=disk asks for the old behaviour - the tests use it, and so does a laptop with no account.
// An existing row is read from its own `storage`, never from this.
function storageChoice() {
  const asked = String(process.env.ATTACHMENT_STORAGE || "").trim().toLowerCase();
  if (asked === "disk" || asked === "cloudinary") return asked;
  const configured = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
  return configured ? "cloudinary" : "disk";
}

// raw + private: Cloudinary keeps the bytes as they are (it must not treat a PDF or a spreadsheet as an
// image to transform) and will not serve them without a signature.
const RAW_PRIVATE = { resource_type: "raw", type: "private" };

const uploadPrivate = (buffer, publicId, format) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ ...RAW_PRIVATE, public_id: publicId, format }, (err, result) => (err ? reject(err) : resolve(result)));
    stream.end(buffer);
  });

// Whitelist by extension, and the content must look like the type it claims (magic bytes), so a
// renamed executable is refused. csv/txt have no signature and are checked as text.
const TYPES = {
  ".pdf": { mime: "application/pdf", magic: [Buffer.from("%PDF")] },
  ".png": { mime: "image/png", magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47])] },
  ".jpg": { mime: "image/jpeg", magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  ".jpeg": { mime: "image/jpeg", magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  ".webp": { mime: "image/webp", magic: [Buffer.from("RIFF")] },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [Buffer.from("PK")] },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [Buffer.from("PK")] },
  ".xls": { mime: "application/vnd.ms-excel", magic: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])] },
  ".doc": { mime: "application/msword", magic: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])] },
  ".csv": { mime: "text/csv", text: true },
  ".txt": { mime: "text/plain", text: true },
};

const OWNER_MODELS = { transaction: "Transaction", voucher: "Voucher", account: "LedgerAccount", customer: "Customer", vendor: "Vendor" };
// A customer's or vendor's files are its KYC documents: the file hangs off a row of `documents`.
const PARTY_OWNERS = ["customer", "vendor"];

const safeName = (n) =>
  path.basename(String(n || "file")).replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "file";

const looksLikeText = (buf) => {
  const sample = buf.subarray(0, 2048);
  return !sample.includes(0);
};

class AttachmentService {
  static get ROOT() {
    return ROOT;
  }

  static validate(file) {
    if (!file?.buffer?.length) throw new AppError("No file received", 400, "NO_FILE");
    if (file.size > MAX_BYTES) throw new AppError("File too large (10 MB maximum)", 413, "FILE_TOO_LARGE");
    const ext = path.extname(safeName(file.originalname)).toLowerCase();
    const type = TYPES[ext];
    if (!type) {
      throw new AppError(`File type ${ext || "(none)"} is not allowed`, 415, "FILE_TYPE_NOT_ALLOWED");
    }
    const okMagic = type.text ? looksLikeText(file.buffer) : type.magic.some((m) => file.buffer.subarray(0, m.length).equals(m));
    if (!okMagic) throw new AppError("File content does not match its extension", 415, "FILE_CONTENT_MISMATCH");
    return { ext, mime: type.mime };
  }

  // file: { originalname, buffer, size } (multer memory storage)
  // `owner` ({ type, id }) writes the owner with the row, for a caller that links nothing afterwards (the CRM's leads and deals
  // hold no list of files; the owner is the only link). Everything else about a save is unchanged.
  static async save(file, { uploadedBy, label, req, owner } = {}) {
    const { ext, mime } = this.validate(file);
    const { companyId } = getTenant(req);
    const year = String(new Date().getFullYear());
    const key = path.posix.join(year, `${crypto.randomBytes(16).toString("hex")}${ext}`);
    const row = {
      companyId,
      key,
      originalName: safeName(file.originalname),
      mimeType: mime,
      size: file.buffer.length,
      uploadedBy: uploadedBy ? String(uploadedBy) : null,
      label,
      ...(owner?.type && owner?.id ? { ownerType: owner.type, ownerId: owner.id } : {}),
    };

    if (storageChoice() === "cloudinary") {
      // the organisation is in the id so a stray asset can be traced back; the name is 128 random bits
      const publicId = `erp_attachments/${companyId}/${year}/${path.basename(key, ext)}`;
      let stored;
      try {
        stored = await uploadPrivate(file.buffer, publicId, ext.slice(1));
      } catch (err) {
        // the row is written only once the bytes are safe: a record of a file nobody has is worse than a refusal
        throw new AppError(`The file could not be stored: ${err?.message || "upload failed"}`, 502, "ATTACHMENT_STORE_FAILED");
      }
      return Attachment.create({ ...row, storage: "cloudinary", publicId: stored.public_id });
    }

    const full = path.join(ROOT, ...key.split("/"));
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, file.buffer, { flag: "wx" });
    return Attachment.create({ ...row, storage: "disk" });
  }

  static toRef(a) {
    return {
      attachmentId: a._id,
      fileName: a.originalName,
      url: `/api/v1/accounting/attachments/${a._id}`,
      fileType: a.mimeType,
      fileSize: a.size,
    };
  }

  static async get(id, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid attachment id", 400);
    const a = await Attachment.findOne({ _id: id, companyId });
    if (!a) throw new AppError("Attachment not found", 404);
    return a;
  }

  // Resolve a path for streaming, refusing anything that would escape the upload root. Disk rows only: a
  // caller that reaches here with a Cloudinary row is looking in the wrong place and should hear so.
  static filePath(a) {
    if (a.storage === "cloudinary") throw new AppError("That file is not on the server's disk", 500, "ATTACHMENT_NOT_ON_DISK");
    const full = path.resolve(ROOT, ...a.key.split("/"));
    if (!full.startsWith(ROOT + path.sep)) throw new AppError("Invalid attachment path", 400);
    return full;
  }

  // The bytes, wherever this row says they are. The signed address lives for a minute and never reaches the
  // client: the file is read here and piped, so a download stays behind get()'s organisation check and keeps
  // the nosniff and attachment headers the route sets.
  static async open(a) {
    if (a.storage === "cloudinary") {
      if (!a.publicId) throw new AppError("File is missing on the server", 410);
      const url = cloudinary.utils.private_download_url(a.publicId, path.extname(a.key).slice(1), {
        ...RAW_PRIVATE,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new AppError("File is missing on the server", 410);
      return Readable.fromWeb(res.body);
    }
    const full = this.filePath(a);
    if (!fs.existsSync(full)) throw new AppError("File is missing on the server", 410);
    return fs.createReadStream(full);
  }

  // Delete the bytes. The caller removes the row either way: a file left behind is tidier than a record
  // nobody can get rid of, so a failure here is logged, not raised.
  static async destroyStored(a) {
    if (a.storage === "cloudinary") {
      if (!a.publicId) return;
      try {
        await cloudinary.uploader.destroy(a.publicId, { ...RAW_PRIVATE, invalidate: true });
      } catch (err) {
        logger.warn(`[attachments] could not delete ${a.publicId}: ${err?.message || err}`);
      }
      return;
    }
    await fs.promises.rm(this.filePath(a), { force: true });
  }

  // Attach a stored file to a document (pushes a reference onto the owner's attachments array).
  static async link(id, { ownerType, ownerId, label }, req) {
    const modelName = OWNER_MODELS[ownerType];
    if (!modelName) throw new AppError("ownerType must be transaction, voucher, account, customer or vendor", 400);
    if (!mongoose.isValidObjectId(ownerId)) throw new AppError("Invalid ownerId", 400);
    const a = await this.get(id, req);
    if (a.ownerId) throw new AppError("Attachment is already linked", 409, "ALREADY_LINKED");

    const Owner = mongoose.model(modelName);
    const owner = await Owner.findById(ownerId).select("_id");
    if (!owner) throw new AppError(`${ownerType} not found`, 404);

    const ref = this.toRef(a);
    // Each owner stores the reference in its own shape.
    const push =
      ownerType === "voucher"
        ? { attachments: { fileName: ref.fileName, filePath: ref.url, fileType: ref.fileType, fileSize: ref.fileSize } }
        : ownerType === "account"
        ? { documents: { ...ref, label: label || a.label, uploadedAt: new Date() } }
        : { attachments: { ...ref, uploadedBy: a.uploadedBy, uploadedAt: new Date() } };
    if (PARTY_OWNERS.includes(ownerType)) {
      // a document row that already names this file (the party form saves them together) is left as it is
      await Owner.updateOne(
        { _id: ownerId, "documents.attachmentId": { $ne: a._id } },
        { $push: { documents: { attachmentId: a._id, typeName: label || a.label || "", fileName: ref.fileName, isVerified: false } } }
      );
    } else {
      await Owner.updateOne({ _id: ownerId }, { $push: push });
    }

    a.ownerType = ownerType;
    a.ownerId = ownerId;
    if (label) a.label = label;
    await a.save();
    return ref;
  }

  static async remove(id, req) {
    const a = await this.get(id, req);
    if (a.ownerId) {
      const Owner = mongoose.model(OWNER_MODELS[a.ownerType]);
      const pull =
        a.ownerType === "voucher"
          ? { attachments: { filePath: this.toRef(a).url } }
          : a.ownerType === "account"
          ? { documents: { attachmentId: a._id } }
          : { attachments: { attachmentId: a._id } };
      if (PARTY_OWNERS.includes(a.ownerType)) {
        // the document row stays (number, dates); only its file goes
        await Owner.updateOne(
          { _id: a.ownerId },
          { $set: { "documents.$[d].attachmentId": null, "documents.$[d].fileName": "" } },
          { arrayFilters: [{ "d.attachmentId": a._id }] }
        );
      } else {
        await Owner.updateOne({ _id: a.ownerId }, { $pull: pull });
      }
    }
    await this.destroyStored(a);
    await a.deleteOne();
  }

  // The party form uploads a file first (unlinked) and names it in a document row; saving the party
  // then claims it. `documents` is the party's saved rows. Files already linked to this party that no
  // row names any more are deleted; a file linked to something else is refused.
  static async syncPartyFiles(ownerType, ownerId, documents = [], req) {
    if (!PARTY_OWNERS.includes(ownerType)) throw new AppError("ownerType must be customer or vendor", 400);
    const { companyId } = getTenant(req);
    const wanted = new Set(documents.map((d) => d.attachmentId && String(d.attachmentId)).filter(Boolean));
    const files = await Attachment.find({ companyId, $or: [{ _id: { $in: [...wanted] } }, { ownerType, ownerId }] });
    for (const a of files) {
      const named = wanted.has(String(a._id));
      if (named && !a.ownerId) {
        a.ownerType = ownerType;
        a.ownerId = ownerId;
        await a.save();
      } else if (named && (a.ownerType !== ownerType || String(a.ownerId) !== String(ownerId))) {
        throw new AppError("A document file belongs to another record", 409, "ATTACHMENT_IN_USE");
      } else if (!named && a.ownerType === ownerType && String(a.ownerId) === String(ownerId)) {
        await this.destroyStored(a);
        await a.deleteOne();
      }
    }
  }

  // Before saving a party: every file its document rows name must exist and be free, or already its own.
  static async assertPartyFiles(ownerType, ownerId, documents = [], req) {
    const { companyId } = getTenant(req);
    const ids = [...new Set(documents.map((d) => d.attachmentId && String(d.attachmentId)).filter(Boolean))];
    if (!ids.length) return;
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("Invalid attachment id", 400, "ATTACHMENT_NOT_FOUND");
    const found = await Attachment.find({ companyId, _id: { $in: ids } }).select("ownerType ownerId").lean();
    if (found.length !== ids.length) throw new AppError("A document file could not be found. Upload it again.", 404, "ATTACHMENT_NOT_FOUND");
    for (const a of found) {
      if (a.ownerId && (a.ownerType !== ownerType || String(a.ownerId) !== String(ownerId))) {
        throw new AppError("A document file belongs to another record", 409, "ATTACHMENT_IN_USE");
      }
    }
  }

  static async listFor(ownerType, ownerId, req) {
    const { companyId } = getTenant(req);
    return Attachment.find({ companyId, ownerType, ownerId }).sort({ createdAt: -1 }).lean();
  }
}

module.exports = AttachmentService;
module.exports.ALLOWED_EXTENSIONS = Object.keys(TYPES);
module.exports.MAX_BYTES = MAX_BYTES;
