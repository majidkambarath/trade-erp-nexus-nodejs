// Files on a lead or a deal: the signed quotation, the site photo, the specification sheet - the things that otherwise live
// in somebody's email and are lost when they leave.
//
// The storage, the type whitelist, the magic-byte check, the size limit and the download headers are AttachmentService's:
// this is only the CRM's own door onto it. It is a separate door on purpose. The existing attachment routes
// (/accounting/attachments) answer to finance, sales, purchase and inventory permissions, and an organisation that bought
// only the CRM holds none of them; widening those routes would hand a CRM-only person every voucher's and invoice's files.
// So the CRM has its own routes, gated on crm.*, and this service refuses to touch any file that is not owned by a lead or
// a deal - an id from another module's attachment is a 404, never a download.
//
// A lead or a deal holds no list of its files (unlike a voucher): the Attachment row names its owner, and that is the only
// link, so there is nothing to keep in step and nothing to orphan when the record goes.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Attachment = require("../../models/modules/financial/attachmentModel");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const AttachmentService = require("../core/attachmentService");
const rules = require("../../utils/crm");
const logger = require("../../utils/logger");
const { getTenant } = require("../../utils/tenant");

const fail = (message, status, code) => new AppError(message, status, code);

/** The kinds of record that may hold a file, the model that finds one (in the branch being worked in) and what to call it. */
const OWNERS = {
  lead: { model: () => Lead, label: "lead" },
  opportunity: { model: () => Opportunity, label: "deal" },
};
const KINDS = Object.keys(OWNERS);

/** A courtesy limit, not a quota: enough for any real deal, and a loop that uploads forever stops somewhere. */
const MAX_PER_RECORD = 25;

class CrmAttachmentService {
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

  /** The record a file would hang off, or a 404: another branch's lead and a deal that is not there look the same. */
  static async ownerOf(kind, id) {
    const owner = OWNERS[kind];
    if (!owner) throw fail("Files can be kept on a lead or a deal", 400, "ATTACHMENT_OWNER_INVALID");
    if (!rules.isId(id)) throw fail(`${owner.label[0].toUpperCase()}${owner.label.slice(1)} not found`, 404, `${kind.toUpperCase()}_NOT_FOUND`);
    const doc = await owner.model().findById(rules.text(id, 24)).select("_id").lean();
    if (!doc) throw fail(`${owner.label[0].toUpperCase()}${owner.label.slice(1)} not found`, 404, `${kind.toUpperCase()}_NOT_FOUND`);
    return doc;
  }

  static async list(kind, id, req) {
    await this.ownerOf(kind, id);
    const rows = await AttachmentService.listFor(kind, new mongoose.Types.ObjectId(rules.text(id, 24)), req);
    return rows.map((a) => this.present(a));
  }

  static async add(kind, id, file, { by, label, req } = {}) {
    await this.ownerOf(kind, id);
    if (!file || !file.buffer) throw fail("Choose a file to attach", 400, "FILE_REQUIRED");
    const ownerId = new mongoose.Types.ObjectId(rules.text(id, 24));
    const held = await Attachment.countDocuments({ ownerType: kind, ownerId });
    if (held >= MAX_PER_RECORD) {
      throw fail(`A ${OWNERS[kind].label} can hold ${MAX_PER_RECORD} files: remove one first`, 409, "ATTACHMENT_LIMIT");
    }
    const a = await AttachmentService.save(file, {
      uploadedBy: by,
      label: rules.text(label, 120) || undefined,
      req,
      owner: { type: kind, id: ownerId },
    });
    return this.present(a);
  }

  /**
   * The file behind an id, only when it belongs to a lead or a deal that this branch can see. A voucher's or an invoice's
   * attachment id is a 404 here whatever the caller guesses, and so is a file whose lead has since gone.
   */
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

  /**
   * Every file of a lead or a deal that has just been deleted. Called after the record's own transaction has committed,
   * never inside it (the bytes may be in Cloudinary, and a transaction retries): a failure here is logged and leaves a
   * file behind, which is tidier than a record nobody can delete.
   */
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
      logger.warn(`[crm] could not clear the files of ${kind} ${id}: ${e?.message || e}`);
      return 0;
    }
  }
}

module.exports = CrmAttachmentService;
module.exports.MAX_PER_RECORD = MAX_PER_RECORD;
