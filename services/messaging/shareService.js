// The secret links to documents: minting one, reading one with no login, withdrawing it.
//
// The public reader is the only door in this app that opens without a session, so it is built to say
// as little as possible. It reads ONE collection and returns the frozen snapshot, never a live record.
// Unknown, malformed and wrong-secret links all answer the same 404. Only someone holding a link whose
// secret verifies can learn it was withdrawn or has run out, and that is exactly who needs to be told.
const { ShareLink, DocumentSend } = require("../../models/modules/messagingModels");
const Transaction = require("../../models/modules/transactionModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const { newToken, parseToken, secretMatches } = require("../../utils/shareToken");
const { coarseIp } = require("../../middleware/rateLimit");
const { isAllowedOrigin, normalizeOrigin } = require("../../utils/allowedOrigins");

const DAY = 24 * 3600 * 1000;
const DEFAULT_BASE = "https://zarvia.onrender.com";
const SOURCE_MODELS = { Transaction }; // grows with the documents that carry a lastSend

const notFound = () => new AppError("This link does not work. It may have been typed wrongly, or the document has been withdrawn. Ask the sender to send it again.", 404, "SHARE_NOT_FOUND");

class ShareService {
  // Where the customer's page lives. PUBLIC_APP_URL decides it wherever it is set (production). Without
  // it, the link points at the frontend THIS request came from, as long as that origin is one the API
  // already trusts - so a link minted from the dev server opens on the dev server, instead of sending the
  // sender to a deployed build that may not carry the page yet. A forged Origin header can only name an
  // origin we already trust, so it buys an attacker nothing.
  static baseUrl(req) {
    const configured = normalizeOrigin(process.env.PUBLIC_APP_URL);
    if (configured) return configured;
    const origin = normalizeOrigin(req?.get?.("origin") || req?.headers?.origin);
    if (isAllowedOrigin(origin)) return origin;
    return DEFAULT_BASE;
  }

  static urlFor(token, req) {
    return `${this.baseUrl(req)}/d/${token}`;
  }

  // The token is returned ONCE, here. Only its hash is stored, so a lost link is minted again, never
  // recovered.
  static async mint({ doc, days, by, req }) {
    const { companyId } = getTenant(req);
    const expiresAt = new Date(Date.now() + days * DAY);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const t = newToken();
      try {
        const link = await ShareLink.create({
          companyId, publicId: t.publicId, secretHash: t.secretHash,
          docType: doc.docType, sourceType: doc.sourceType, sourceId: doc.sourceId, documentNo: doc.documentNo, partyId: doc.partyId,
          snapshot: doc.snapshot, expiresAt, createdBy: by,
        });
        return { link, token: t.token, url: this.urlFor(t.token, req), expiresAt };
      } catch (err) {
        if (err?.code !== 11000) throw err; // a selector collision: draw another
      }
    }
    throw new AppError("Could not create a link. Try again.", 500, "SHARE_MINT_FAILED");
  }

  // The public read. Throws the same 404 for everything that is not a valid, matching link.
  static async resolve(token) {
    const parsed = parseToken(token);
    if (!parsed) throw notFound();
    // The one lookup that has no organisation to scope by: a customer's browser knows only the secret link.
    // It finds the row by its selector, then everything after runs AS the organisation the row names.
    const link = await runUnscoped("public share link reader: finds the row by its secret selector, the organisation is read from the row", () =>
      ShareLink.findOne({ publicId: parsed.publicId })
    );
    if (!link || !secretMatches(parsed.secret, link.secretHash)) throw notFound();
    const company = link.snapshot?.company?.companyName || null;
    if (link.revokedAt) throw new AppError("This link has been withdrawn.", 410, "SHARE_REVOKED", { company });
    if (link.expiresAt <= new Date()) throw new AppError("This link has expired.", 410, "SHARE_EXPIRED", { company });
    return link;
  }

  // Every raw fetch, person or mail scanner. It proves nothing about a person, so it only counts.
  static async recordFetch(link) {
    await runWithTenant({ companyId: link.companyId }, () =>
      ShareLink.updateOne({ _id: link._id }, { $inc: { fetchCount: 1 }, $set: { lastFetchAt: new Date() } })
    );
  }

  // The page sends this once it has really loaded: that is a person (or a browser, at least). The
  // first one is stamped on the link, the send and the invoice.
  static async recordView(token, req) {
    const link = await this.resolve(token);
    return runWithTenant({ companyId: link.companyId, branchId: link.branchId }, () => this._recordView(link, req));
  }

  static async _recordView(link, req) {
    const now = new Date();
    const view = { at: now, ip: coarseIp(req.ip) /* what Express made of the proxy chain (server.js: trust proxy), not a header the visitor wrote */, ua: String(req.get?.("user-agent") || "").slice(0, 120) };
    await ShareLink.updateOne(
      { _id: link._id },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: now }, $push: { views: { $each: [view], $slice: -20 } } }
    );
    // Conditional, so two opens at once cannot overwrite the first.
    const first = await ShareLink.updateOne({ _id: link._id, firstViewedAt: null }, { $set: { firstViewedAt: now } });
    if (first.modifiedCount) {
      const send = await DocumentSend.findOneAndUpdate({ shareLinkId: link._id, openedAt: null }, { $set: { openedAt: now } }, { new: true });
      const Model = SOURCE_MODELS[link.sourceType];
      if (send && Model) await Model.updateOne({ _id: link.sourceId, "lastSend.sendId": send._id }, { $set: { "lastSend.openedAt": now } });
    }
  }

  // The customer approves or declines the estimate they were sent. THE ONLY WRITE A STRANGER CAN MAKE
  // IN THIS API, so read the rules it keeps before changing it:
  //
  //  - the secret is the whole credential, so `resolve` has already run and a revoked or expired link
  //    was refused before we got here;
  //  - the link must BE an estimate. Any other docType answers the same 404 as a made-up token: a
  //    tax-invoice link must not become a way to approve work;
  //  - **no figure is read from the request.** The body carries line ids, a name and a note. Prices,
  //    quantities and totals stay exactly as the workshop priced them;
  //  - a named line must have been ON THE SNAPSHOT the customer was actually shown, and is checked
  //    again against the live card by utils/garage.js checkApproval. Two gates, because this one is
  //    worth two;
  //  - everything runs AS the organisation named on the row, never one from the request.
  static async recordEstimateDecision(link, body, req) {
    if (link.docType !== "job_estimate" || link.sourceType !== "JobCard") throw notFound();
    // Required lazily: the garage service pulls in a good part of the trade engine, and this file is
    // loaded by the messaging pipeline at start-up.
    const JobCardService = require("../garage/jobCardService");
    const AuditService = require("../core/auditService");
    return runWithTenant({ companyId: link.companyId, branchId: link.branchId }, async () => {
      const shown = new Set((link.snapshot?.job?.lines || []).map((l) => String(l._id)));
      const asked = Array.isArray(body?.lineIds) ? body.lineIds.map((v) => String(v)) : [];
      if (asked.some((id) => !shown.has(id))) {
        throw new AppError("That is not an item on this estimate.", 400, "LINE_NOT_ON_ESTIMATE");
      }
      const outcome = body?.outcome === "approved" ? "approved" : "declined";
      const { card, already, declined } = await JobCardService.recordCustomerDecision(
        link.sourceId,
        { outcome, name: body?.name, note: body?.note, lineIds: asked },
        { linkId: link.publicId, ip: coarseIp(req?.ip) }
      );
      if (!already) {
        const who = String(body?.name || "").slice(0, 120);
        // No userId and no username: nobody was signed in, and the trail should say so plainly. The
        // link is named by its publicId, never by the token, which is the credential itself.
        await AuditService.log({
          req,
          action: declined ? "GARAGE_ESTIMATE_DECLINED_ONLINE" : "GARAGE_ESTIMATE_APPROVED_ONLINE",
          entity: "JobCard",
          entityId: link.sourceId,
          summary: `${who} ${declined ? "declined" : "approved"} the estimate for job ${card.jobNo || ""} at the link sent to them (${link.publicId})`,
          after: { outcome, lines: asked.length || "all", status: card.status },
        });
      }
      return { outcome, already: Boolean(already), status: card.status, jobNo: card.jobNo || "" };
    });
  }

  // One inspection photograph, fetched by the customer's page. The authenticated attachment doors all
  // answer to a permission a customer could never hold, so this is its own narrow door, and it opens
  // for EXACTLY the files named in the snapshot's inspection and nothing else: an attachment id that
  // was not shown to this customer - a check-in photo, another job's file, another organisation's -
  // answers the same 404 as a made-up one. The id is therefore not a capability; the snapshot is.
  static async openEstimatePhoto(link, attachmentId) {
    if (link.docType !== "job_estimate") throw notFound();
    const allowed = new Set(
      (link.snapshot?.job?.inspection || []).flatMap((i) => (i.photos || []).map((p) => String(p)))
    );
    if (!allowed.has(String(attachmentId))) throw notFound();
    const Attachment = require("../../models/modules/financial/attachmentModel");
    const AttachmentService = require("../core/attachmentService");
    return runWithTenant({ companyId: link.companyId, branchId: link.branchId }, async () => {
      const a = await Attachment.findOne({ _id: attachmentId, ownerType: "jobcard", ownerId: link.sourceId });
      if (!a) throw notFound();
      return { attachment: a, stream: await AttachmentService.open(a) };
    });
  }

  static async list(req, { sourceType, sourceId }) {
    const { companyId } = getTenant(req);
    const rows = await ShareLink.find({ companyId, sourceType, sourceId })
      .select("-secretHash -snapshot -views")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return rows;
  }

  static async revoke(id, { by, reason } = {}, req) {
    const { companyId } = getTenant(req);
    const link = await ShareLink.findOne({ _id: id, companyId });
    if (!link) throw new AppError("Link not found", 404, "SHARE_NOT_FOUND");
    if (link.revokedAt) throw new AppError("This link was already withdrawn", 409, "ALREADY_REVOKED");
    link.revokedAt = new Date();
    link.revokedBy = by || null;
    link.revokeReason = String(reason || "").slice(0, 200) || null;
    await link.save();
    return link;
  }

  // The document stopped being what was sent (a quotation revised, an order deleted, a note cancelled).
  // Fire and forget: failing to withdraw a link must never fail the business action that caused it.
  static revokeFor(sourceType, sourceId, reason) {
    return ShareLink.updateMany(
      { sourceType, sourceId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: "system", revokeReason: reason } }
    ).catch((err) => console.error("[messaging] could not withdraw links:", err.message));
  }
}

module.exports = ShareService;
