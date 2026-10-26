// Files on a job card, a vehicle or an insurance claim: the check-in photos, a damage close-up, the surveyor's
// own pictures, a signed check-in sheet. Same door-onto-AttachmentService shape as services/crm/crmAttachmentService.js,
// for the same reason: the existing attachment routes (/accounting/attachments) answer to finance/sales/purchase/
// inventory permissions, and a garage-only person holds none of them - widening those routes would hand them every
// voucher's and invoice's files. So the garage module has its own routes, gated on garage.*, and this service
// refuses to touch any file that is not owned by one of its own three record kinds.
//
// None of the three keeps a list of its own files (unlike a job card's invoices[]): the Attachment row names its
// owner, and that is the only link, so there is nothing to keep in step and nothing to orphan when the record goes.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Attachment = require("../../models/modules/financial/attachmentModel");
const JobCard = require("../../models/modules/garage/jobCardModel");
const Vehicle = require("../../models/modules/garage/vehicleModel");
const InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
const AttachmentService = require("../core/attachmentService");
const logger = require("../../utils/logger");
const { getTenant } = require("../../utils/tenant");

const fail = (message, status, code) => new AppError(message, status, code);

const OWNERS = {
  jobcard: { model: () => JobCard, label: "job card" },
  vehicle: { model: () => Vehicle, label: "vehicle" },
  claim: { model: () => InsuranceClaim, label: "claim" },
};
const KINDS = Object.keys(OWNERS);

// A courtesy limit, not a quota: enough for any real job (a dozen check-in photos, a handful of survey photos),
// and a loop that uploads forever stops somewhere.
const MAX_PER_RECORD = 40;

class GarageAttachmentService {
  static present(a) {
    return {
      attachmentId: a._id,
      fileName: a.originalName,
      fileType: a.mimeType,
      fileSize: a.size,
      label: a.label || "",
      uploadedAt: a.createdAt,
      uploadedBy: a.uploadedBy || null,
    };
  }

  // The record a file would hang off, or a 404: another branch's job card and one that is not there look the same.
  static async ownerOf(kind, id) {
    const owner = OWNERS[kind];
    if (!owner) throw fail("Files can be kept on a job card, a vehicle or a claim", 400, "ATTACHMENT_OWNER_INVALID");
    if (!mongoose.isValidObjectId(id)) throw fail(`${owner.label[0].toUpperCase()}${owner.label.slice(1)} not found`, 404, `${kind.toUpperCase()}_NOT_FOUND`);
    const doc = await owner.model().findById(id).select("_id").lean();
    if (!doc) throw fail(`${owner.label[0].toUpperCase()}${owner.label.slice(1)} not found`, 404, `${kind.toUpperCase()}_NOT_FOUND`);
    return doc;
  }

  static async list(kind, id, req) {
    await this.ownerOf(kind, id);
    const rows = await AttachmentService.listFor(kind, new mongoose.Types.ObjectId(id), req);
    return rows.map((a) => this.present(a));
  }

  static async add(kind, id, file, { by, label, req } = {}) {
    await this.ownerOf(kind, id);
    if (!file || !file.buffer) throw fail("Choose a file to attach", 400, "FILE_REQUIRED");
    const ownerId = new mongoose.Types.ObjectId(id);
    const held = await Attachment.countDocuments({ ownerType: kind, ownerId });
    if (held >= MAX_PER_RECORD) {
      throw fail(`A ${OWNERS[kind].label} can hold ${MAX_PER_RECORD} files: remove one first`, 409, "ATTACHMENT_LIMIT");
    }
    const a = await AttachmentService.save(file, {
      uploadedBy: by,
      label: label ? String(label).slice(0, 120) : undefined,
      req,
      owner: { type: kind, id: ownerId },
    });
    return this.present(a);
  }

  // The file behind an id, only when it belongs to a job card, a vehicle or a claim this branch can see. A
  // voucher's or an invoice's attachment id is a 404 here whatever the caller guesses.
  static async find(attachmentId, req) {
    if (!mongoose.isValidObjectId(attachmentId)) throw fail("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
    const { companyId } = getTenant(req);
    const a = await Attachment.findOne({ _id: attachmentId, companyId, ownerType: { $in: KINDS } });
    if (!a) throw fail("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
    const visible = await OWNERS[a.ownerType].model().exists({ _id: a.ownerId });
    if (!visible) throw fail("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
    return a;
  }

  static async open(attachmentId, req) {
    const a = await this.find(attachmentId, req);
    return { attachment: a, stream: await AttachmentService.open(a) };
  }

  static async remove(attachmentId, req) {
    const a = await this.find(attachmentId, req);
    await AttachmentService.destroyStored(a);
    await a.deleteOne();
    return { ownerType: a.ownerType, ownerId: a.ownerId, fileName: a.originalName };
  }

  // Every file of a record that has just been deleted. Called AFTER the record's own transaction has committed,
  // never inside it (the bytes may be in Cloudinary, and a transaction retries): a failure here is logged and
  // leaves a file behind, which is tidier than a record nobody can delete.
  static async removeAll(kind, id, req) {
    if (!KINDS.includes(kind) || !mongoose.isValidObjectId(id)) return 0;
    try {
      const rows = await Attachment.find({ ownerType: kind, ownerId: id });
      for (const a of rows) {
        await AttachmentService.destroyStored(a);
        await a.deleteOne();
      }
      return rows.length;
    } catch (e) {
      logger.warn(`[garage] could not clear the files of ${kind} ${id}: ${e?.message || e}`);
      return 0;
    }
  }
}

module.exports = GarageAttachmentService;
module.exports.MAX_PER_RECORD = MAX_PER_RECORD;
