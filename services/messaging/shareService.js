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
    const link = await ShareLink.findOne({ publicId: parsed.publicId });
    if (!link || !secretMatches(parsed.secret, link.secretHash)) throw notFound();
    const company = link.snapshot?.company?.companyName || null;
    if (link.revokedAt) throw new AppError("This link has been withdrawn.", 410, "SHARE_REVOKED", { company });
    if (link.expiresAt <= new Date()) throw new AppError("This link has expired.", 410, "SHARE_EXPIRED", { company });
    return link;
  }

  // Every raw fetch, person or mail scanner. It proves nothing about a person, so it only counts.
  static async recordFetch(link) {
    await ShareLink.updateOne({ _id: link._id }, { $inc: { fetchCount: 1 }, $set: { lastFetchAt: new Date() } });
  }

  // The page sends this once it has really loaded: that is a person (or a browser, at least). The
  // first one is stamped on the link, the send and the invoice.
  static async recordView(token, req) {
    const link = await this.resolve(token);
    const now = new Date();
    const view = { at: now, ip: coarseIp(req.headers?.["x-forwarded-for"]?.split(",")[0].trim() || req.ip), ua: String(req.get?.("user-agent") || "").slice(0, 120) };
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
