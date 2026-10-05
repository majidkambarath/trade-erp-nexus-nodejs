const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Attachment = require("../../models/modules/financial/attachmentModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const ROOT = path.resolve(__dirname, "..", "..", "uploads", "attachments");
const MAX_BYTES = 10 * 1024 * 1024;

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
  static async save(file, { uploadedBy, label, req } = {}) {
    const { ext, mime } = this.validate(file);
    const { companyId } = getTenant(req);
    const year = String(new Date().getFullYear());
    const key = path.posix.join(year, `${crypto.randomBytes(16).toString("hex")}${ext}`);
    const full = path.join(ROOT, ...key.split("/"));
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, file.buffer, { flag: "wx" });
    return Attachment.create({
      companyId,
      key,
      originalName: safeName(file.originalname),
      mimeType: mime,
      size: file.buffer.length,
      uploadedBy: uploadedBy ? String(uploadedBy) : null,
      label,
    });
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

  // Resolve a path for streaming, refusing anything that would escape the upload root.
  static filePath(a) {
    const full = path.resolve(ROOT, ...a.key.split("/"));
    if (!full.startsWith(ROOT + path.sep)) throw new AppError("Invalid attachment path", 400);
    return full;
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
    await fs.promises.rm(this.filePath(a), { force: true });
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
        await fs.promises.rm(this.filePath(a), { force: true });
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
