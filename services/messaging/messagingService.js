// Sending a document to the customer: the email pipeline, the WhatsApp hand-off, the retry pass.
// Copies the house pattern of services/einvoice/einvoiceService.js (a log row per send, a retry date, a
// background pass) with the differences the design review found:
//   - the log row is written BEFORE the provider is called, so the worst case is a row with no result,
//     never an email with no row;
//   - a double click is caught by an idempotency key per press of the button, not by a unique index on
//     the document (an invoice may legitimately be emailed many times);
//   - the first attempt is synchronous, because a person is watching a spinner;
//   - SENT means the provider accepted the message. Nothing here says delivered.
const crypto = require("crypto");
const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const { DocumentSend, MessagingSettings, ShareLink } = require("../../models/modules/messagingModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const UsageService = require("../core/usageService");
const { ProviderError } = require("../../utils/providerError");
const { renderDocumentEmail, DOC_LABEL, fmtDay, fmtMoney } = require("../../utils/emailTemplates");
const { toWaNumber, waMeUrl } = require("../../utils/phone");
const Settings = require("./settingsService");
const DocumentSource = require("./documentSource");
const ShareService = require("./shareService");
const { PROVIDERS } = require("./providers");

const SOURCE_MODELS = { Transaction }; // the documents that carry a lastSend summary
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = { to: 10, cc: 5, bcc: 5 };
const DUPLICATE_WINDOW_MS = 60 * 1000;
const STUCK_MS = 10 * 60 * 1000;
const KEEP_BYTES_MS = 24 * 3600 * 1000;
const BACKOFF_MS = (attempt) => Math.min(60000 * 2 ** Math.max(attempt - 1, 0), 3600 * 1000); // 1m, 2m, 4m ... capped at 1h
const HTTP_FOR = { INVALID_ADDRESS: 400, FROM_NOT_VERIFIED: 422, PROVIDER_QUOTA: 429, PROVIDER_RATE_LIMIT: 503, PROVIDER_BUSY: 503, PROVIDER_UNAVAILABLE: 503, PROVIDER_UNREACHABLE: 503, PROVIDER_TIMEOUT: 503 };

// "a@x.ae, b@y.ae; c@z.ae", a JSON array or a real array -> unique lowercase addresses.
function parseList(value) {
  let list = value;
  if (typeof list === "string") {
    const t = list.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch (_) { list = t.split(/[,;\s]+/); }
    } else list = t.split(/[,;\s]+/);
  }
  return [...new Set((Array.isArray(list) ? list : []).map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
}

function checkRecipients({ to, cc, bcc }) {
  if (!to.length) throw new AppError("Who should it go to? Add an email address.", 422, "NO_RECIPIENT");
  const invalid = [...to, ...cc, ...bcc].filter((e) => !EMAIL.test(e));
  if (invalid.length) throw new AppError(`${invalid.join(", ")} ${invalid.length === 1 ? "does" : "do"} not look like an email address`, 400, "INVALID_EMAIL", { invalid });
  if (to.length > MAX.to || cc.length > MAX.cc || bcc.length > MAX.bcc) throw new AppError(`Too many recipients: at most ${MAX.to} to, ${MAX.cc} cc and ${MAX.bcc} bcc`, 400, "TOO_MANY_RECIPIENTS");
}

const oneLine = (v, max) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const flag = (v, fallback) => (v === undefined || v === null || v === "" ? fallback : v === true || v === "true" || v === "1");

// A key per press of the button, from the header. An old client with none gets one worked out from what
// is being sent, bucketed to 30 seconds so a double click collapses and nothing else does.
function idempotencyKeyFor(req, parts) {
  const given = String(req.get?.("Idempotency-Key") || "").trim();
  if (/^[A-Za-z0-9._:-]{8,128}$/.test(given)) return given;
  return `auto-${crypto.createHash("sha256").update([...parts, Math.floor(Date.now() / 30000)].join("|")).digest("hex").slice(0, 40)}`;
}

// The send as the screens read it: no bytes, no provider payload.
const present = (row) => {
  const o = typeof row.toObject === "function" ? row.toObject() : { ...row };
  delete o.pending;
  delete o.providerResponse;
  return o;
};

const push = (row, status, note) => row.history.push({ status, at: new Date(), note });

// The summary a document carries, so a list can say "Emailed 6 Oct" without a join.
async function writeLastSend(row) {
  const Model = SOURCE_MODELS[row.sourceType];
  if (!Model) return;
  const lastSend = {
    sendId: row._id, channel: row.channel, status: row.status, provider: row.provider,
    at: row.sentAt || row.failedAt || row.createdAt,
    to: row.channel === "whatsapp" ? row.phone : (row.to || []).join(", "),
    openedAt: row.openedAt || null, error: row.lastError || null,
  };
  await Model.updateOne({ _id: row.sourceId }, { $set: { lastSend } }).catch((e) => console.error("[messaging] lastSend not written:", e.message));
}

// A provider answer becomes an HTTP status the screen can act on; only a fault of ours is a 500.
function toAppError(err, row) {
  const code = err.code || "SEND_FAILED";
  const status = HTTP_FOR[code] ?? (code === "SEND_FAILED" || code === "SEND_PREPARE_FAILED" ? 500 : 502);
  return new AppError(err.message, status, code, { sendId: row._id, retryable: row.retryable, nextRetryAt: row.nextRetryAt });
}

// Creates the log row, or - if this press of the button already did - returns it. 11000 means the
// unique {companyId, idempotencyKey} index let exactly one caller win.
async function claim(fields) {
  try {
    return { row: await DocumentSend.create(fields), duplicate: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const row = await DocumentSend.findOne({ companyId: fields.companyId, idempotencyKey: fields.idempotencyKey });
    if (!row) throw err;
    return { row, duplicate: true };
  }
}

// The WhatsApp message: the facts, the person's own line if there is room, and the link. Kept short,
// because a very long link breaks on some phones. The link is never cut; the person's line is.
const WA_MAX = 400;
function whatsappText(doc, url, note) {
  const label = (DOC_LABEL[doc.docType] || "document").toLowerCase();
  const money = fmtMoney(doc.total, doc.currency);
  const base = `Dear ${doc.contactPerson || doc.partyName || "customer"}, ${label} ${doc.documentNo}${doc.company?.companyName ? ` from ${doc.company.companyName}` : ""}${money ? ` for ${money}` : ""}.${doc.dueDate ? ` Due ${fmtDay(doc.dueDate)}.` : ""}`;
  const tail = `
View it here: ${url}`;
  const room = Math.max(0, WA_MAX - base.length - tail.length - 1);
  return `${base}${note && room > 0 ? `
${note.slice(0, room)}` : ""}${tail}`;
}

// Each row with the state of its link, so the history can say opened and offer to withdraw it.
async function withShares(rows) {
  const ids = rows.map((r) => r.shareLinkId).filter(Boolean);
  if (!ids.length) return rows;
  const links = await ShareLink.find({ _id: { $in: ids } }).select("publicId expiresAt revokedAt fetchCount viewCount firstViewedAt lastViewedAt").lean();
  const byId = new Map(links.map((l) => [String(l._id), l]));
  return rows.map((r) => (r.shareLinkId ? { ...r, share: byId.get(String(r.shareLinkId)) || null } : r));
}

const senderOf = (req) => ({ by: String(req.admin?.id || "system"), byName: req.admin?.name || req.admin?.email || "system", email: req.admin?.email || "" });

class MessagingService {
  // Email a document. `file` is the PDF the browser drew (multer memory storage), or null for a
  // link-only email. A provider failure still leaves its row, and throws so the person sees why.
  static async send(input, file, req) {
    const { companyId, branchId } = getTenant(req);
    const { by, byName, email } = senderOf(req);
    const settings = await Settings.load(companyId, { withSecrets: true });
    if (!settings.enabled) throw new AppError("Sending is switched off. Ask a manager to switch it on in Settings, under Sending.", 422, "MESSAGING_DISABLED");
    const bad = (await Settings.readiness(req, settings)).checks.filter((c) => c.blocking && !c.ok);
    if (bad.length) throw new AppError(`Sending is not set up yet: ${bad.map((c) => c.label).join("; ")}`, 422, "MESSAGING_NOT_CONFIGURED", { missing: bad.map((c) => c.key) });
    const apiKey = Settings.keyOf(settings);
    const doc = await DocumentSource.load(input.docType, input.sourceId, req);

    const given = parseList(input.to);
    const to = given.length ? given : doc.recipients.slice(0, 1);
    const cc = parseList(input.cc);
    const bcc = parseList(input.bcc);
    if (settings.bccSelf && email && !bcc.includes(email.toLowerCase())) bcc.push(email.toLowerCase());
    checkRecipients({ to, cc, bcc });

    const includeLink = settings.shareEnabled && flag(input.includeShareLink, true);
    const attach = settings.attachPdf && file ? file : null;
    if (!attach && !includeLink) throw new AppError("Attach the PDF or include the link: an email with neither carries no document.", 400, "PDF_REQUIRED");

    const used = await DocumentSend.countDocuments({ companyId, channel: "email", createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } });
    if (used >= settings.dailyLimit) throw new AppError(`The limit of ${settings.dailyLimit} emails a day has been reached. It frees up as the day passes.`, 429, "SEND_LIMIT_REACHED");

    const sha = attach ? crypto.createHash("sha256").update(attach.buffer).digest("hex") : "";
    const key = idempotencyKeyFor(req, [companyId, doc.docType, String(doc.sourceId), "email", [...to].sort().join(","), sha]);
    const same = await DocumentSend.findOne({ companyId, idempotencyKey: key });
    if (same) return { send: present(same), share: null, duplicate: true };
    if (!flag(input.force, false)) {
      const recent = await DocumentSend.findOne({
        companyId, sourceType: doc.sourceType, sourceId: doc.sourceId, channel: "email", status: { $in: ["QUEUED", "SENT"] },
        createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }, to: { $all: to, $size: to.length },
      });
      if (recent) throw new AppError("This was already sent a moment ago. Send it again?", 409, "DUPLICATE_SEND", { sendId: recent._id, sentAt: recent.sentAt || recent.createdAt });
    }

    const note = String(input.note ?? "").trim().slice(0, 1000);
    const { row, duplicate } = await claim({
      companyId, branchId, docType: doc.docType, sourceType: doc.sourceType, sourceId: doc.sourceId, documentNo: doc.documentNo,
      partyId: doc.partyId, partyName: doc.partyName, channel: "email", status: "QUEUED", to, cc, bcc, note,
      attachment: attach ? { fileName: oneLine(attach.originalname, 120) || `${doc.documentNo}.pdf`, bytes: attach.size, sha256: sha, mimeType: "application/pdf" } : undefined,
      provider: settings.provider, idempotencyKey: key, sentBy: by, sentByName: byName, history: [{ status: "QUEUED", at: new Date() }],
    });
    if (duplicate) return { send: present(row), share: null, duplicate: true };

    let share = null;
    try {
      if (includeLink) share = await ShareService.mint({ doc, days: settings.shareLinkDays, by, req });
      const mail = renderDocumentEmail({
        docType: doc.docType, documentNo: doc.documentNo, date: doc.date, dueDate: doc.dueDate, total: doc.total, currency: doc.currency,
        partyName: doc.partyName, contactPerson: doc.contactPerson, company: doc.company, shareUrl: share?.url, shareExpiresAt: share?.expiresAt,
        note, signature: settings.signature, hasAttachment: Boolean(attach),
      });
      row.subject = oneLine(input.subject, 200) || mail.subject;
      // The preview is kept in the log, and the text part carries the link: take the link out of it.
      row.bodyPreview = (share ? mail.text.split(share.url).join("[document link]") : mail.text).slice(0, 400);
      row.shareLinkId = share?.link._id;
      row.pending = { html: mail.html, text: mail.text, bytes: attach?.buffer };
      await row.save();
    } catch (err) {
      row.status = "FAILED";
      row.lastError = err.message;
      row.lastErrorCode = "SEND_PREPARE_FAILED";
      row.retryable = false;
      row.failedAt = new Date();
      push(row, "FAILED", err.message);
      await row.save().catch(() => {});
      await writeLastSend(row);
      throw err;
    }

    await this.attempt(row, settings, apiKey, { throwOnFail: true });
    return { send: present(row), share: share ? { url: share.url, expiresAt: share.expiresAt } : null, duplicate: false };
  }

  // One delivery attempt. A person waiting gets the failure thrown; the background pass swallows it,
  // because the row already holds everything that happened.
  static async attempt(row, settings, apiKey, { throwOnFail = false } = {}) {
    row.attempts += 1;
    row.status = "QUEUED";
    row.provider = settings.provider;
    const message = {
      from: Settings.fromLine(settings), to: row.to, cc: row.cc, bcc: row.bcc, replyTo: settings.replyTo || undefined,
      subject: row.subject, html: row.pending.html, text: row.pending.text,
      attachments: row.pending.bytes ? [{ filename: row.attachment.fileName, content: row.pending.bytes, contentType: "application/pdf" }] : [],
      idempotencyKey: String(row._id), // the row's own id: a retry sends the identical message under the same key
    };
    try {
      const r = await PROVIDERS[settings.provider].send(message, { apiKey, ...Settings.optionsOf(settings) });
      row.status = "SENT";
      row.sentAt = new Date();
      row.providerMessageId = r.messageId || null;
      row.providerResponse = r.raw ?? null;
      row.lastError = null;
      row.lastErrorCode = null;
      row.retryable = false;
      row.nextRetryAt = null;
      row.set("pending", undefined); // settled: the bytes and the link-bearing HTML are not kept
      push(row, "SENT");
    } catch (err) {
      const known = err instanceof ProviderError;
      row.status = "FAILED";
      row.failedAt = new Date();
      row.lastError = err.message;
      row.lastErrorCode = err.code || "SEND_FAILED";
      row.retryable = known ? err.retryable : false;
      row.nextRetryAt = row.retryable && row.attempts < settings.retryMax ? new Date(Date.now() + (err.retryAfterMs ?? BACKOFF_MS(row.attempts))) : null;
      // A refusal needs a person and a fresh send, so nothing is kept. A temporary failure keeps the
      // message so a later retry, or a press of Retry, sends exactly the same one.
      if (!row.retryable) row.set("pending", undefined);
      push(row, "FAILED", err.message);
      if (row.lastErrorCode === "PROVIDER_AUTH") await MessagingSettings.updateOne({ companyId: row.companyId }, { $set: { lastAuthFailureAt: new Date() } });
    }
    await row.save();
    await writeLastSend(row);
    if (row.status === "FAILED" && throwOnFail) throw toAppError({ message: row.lastError, code: row.lastErrorCode, retryable: row.retryable }, row);
    return row;
  }

  // The Retry button: only for a failure that was temporary, and only while the message is still held.
  static async retry(id, req) {
    const { companyId } = getTenant(req);
    const settings = await Settings.load(companyId, { withSecrets: true });
    if (!settings.enabled) throw new AppError("Sending is switched off. Ask a manager to switch it on in Settings, under Sending.", 422, "MESSAGING_DISABLED");
    const apiKey = Settings.keyOf(settings);
    const row = await DocumentSend.findOne({ _id: id, companyId }).select("+pending");
    if (!row) throw new AppError("That send was not found", 404, "SEND_NOT_FOUND");
    if (row.channel !== "email" || row.status !== "FAILED" || !row.retryable) {
      throw new AppError("Only an email that failed for a temporary reason can be retried. Send it again from the document.", 409, "RETRY_NOT_POSSIBLE");
    }
    if (!row.pending?.html) throw new AppError("The message is no longer held. Open the document and send it again.", 409, "ATTACHMENT_GONE");
    const locked = await DocumentSend.findOneAndUpdate({ _id: id, status: "FAILED" }, { $set: { status: "QUEUED", nextRetryAt: null } }, { new: true }).select("+pending");
    if (!locked) throw new AppError("That send is already being retried", 409, "RETRY_NOT_POSSIBLE");
    await this.attempt(locked, settings, apiKey, { throwOnFail: true });
    return present(locked);
  }

  // WhatsApp: nothing is sent from here. The server writes the message and the link, records that it
  // was handed over, and the browser opens WhatsApp with the text ready. A person presses send, so the
  // log says HANDED_OFF and nothing else: no claim is made about what happened next.
  static async handoff(input, req) {
    const { companyId, branchId } = getTenant(req);
    const { by, byName } = senderOf(req);
    const settings = await Settings.load(companyId);
    if (!settings.shareEnabled) throw new AppError("WhatsApp carries the document link, and links are switched off in Settings, under Sending.", 422, "SHARE_DISABLED");
    const doc = await DocumentSource.load(input.docType, input.sourceId, req);

    const typed = String(input.phone ?? "").trim();
    const phone = toWaNumber(typed || doc.phone);
    if (!phone) {
      throw typed
        ? new AppError("That does not look like a phone number. Include the country code, for example +971 50 111 2222.", 400, "INVALID_PHONE")
        : new AppError("This customer has no phone number saved. Type the WhatsApp number to send to.", 422, "NO_PHONE");
    }
    const key = idempotencyKeyFor(req, [companyId, doc.docType, String(doc.sourceId), "whatsapp", phone]);
    const same = await DocumentSend.findOne({ companyId, idempotencyKey: key });
    if (same) return { send: present(same), waUrl: null, share: null, duplicate: true };

    const share = await ShareService.mint({ doc, days: settings.shareLinkDays, by, req });
    const text = whatsappText(doc, share.url, String(input.note ?? "").trim());
    const { row, duplicate } = await claim({
      companyId, branchId, docType: doc.docType, sourceType: doc.sourceType, sourceId: doc.sourceId, documentNo: doc.documentNo,
      partyId: doc.partyId, partyName: doc.partyName, channel: "whatsapp", status: "HANDED_OFF", phone,
      note: String(input.note ?? "").trim().slice(0, 300), bodyPreview: text.split(share.url).join("[document link]").slice(0, 400),
      shareLinkId: share.link._id, provider: "whatsapp", idempotencyKey: key, sentBy: by, sentByName: byName,
      sentAt: new Date(), history: [{ status: "HANDED_OFF", at: new Date() }],
    });
    if (duplicate) {
      // two requests at once both minted a link; the loser's is not referenced by anything
      ShareService.revoke(share.link._id, { by: "system", reason: "duplicate request" }, req).catch(() => {});
      return { send: present(row), waUrl: null, share: null, duplicate: true };
    }
    await writeLastSend(row);
    return { send: present(row), waUrl: waMeUrl(phone, text), share: { url: share.url, expiresAt: share.expiresAt }, duplicate: false };
  }

  static async list(req, q = {}) {
    const { companyId } = getTenant(req);
    const f = { companyId };
    for (const k of ["docType", "sourceType", "channel", "status"]) if (q[k]) f[k] = String(q[k]);
    for (const k of ["sourceId", "partyId"]) if (q[k] && mongoose.isValidObjectId(q[k])) f[k] = q[k];
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
    const [rows, total] = await Promise.all([
      DocumentSend.find(f).select("-providerResponse").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      DocumentSend.countDocuments(f),
    ]);
    return { rows: await withShares(rows), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }

  static async get(id, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("That send was not found", 404, "SEND_NOT_FOUND");
    const row = await DocumentSend.findOne({ _id: id, companyId }).lean();
    if (!row) throw new AppError("That send was not found", 404, "SEND_NOT_FOUND");
    return (await withShares([row]))[0];
  }

  // The background pass, once a minute from server.js: retry what failed for a temporary reason, call
  // an interrupted send what it is, and wipe any message that has been held too long.
  static async processDue(now = new Date()) {
    const due = { status: "FAILED", retryable: true, nextRetryAt: { $lte: now } };
    // Listing which organisations have something to retry is the one cross-organisation read; each one's
    // work then runs inside its own scope.
    const owing = await runUnscoped("background job: lists the organisations that have sends waiting to be retried", () => DocumentSend.distinct("companyId", due));
    const live = await UsageService.liveCodes({ feature: "messaging", now });
    for (const companyId of owing) {
      if (!live.has(companyId)) continue; // suspended, expired or without the feature: nothing is sent for it
      await runWithTenant({ companyId }, async () => {
        const settings = await Settings.load(companyId, { withSecrets: true });
        if (!settings.enabled) return; // switched off: leave them for when it is switched on
        let apiKey;
        try {
          apiKey = Settings.keyOf(settings);
        } catch (err) {
          console.error("[messaging] cannot retry, the key is unreadable:", err.message);
          return;
        }
        for (const { _id } of await DocumentSend.find({ companyId, ...due }).select("_id").limit(25).lean()) {
          // claimed by a status-matched update, so a hand retry and this pass cannot both send it
          const row = await DocumentSend.findOneAndUpdate({ _id, status: "FAILED", nextRetryAt: { $lte: now } }, { $set: { status: "QUEUED", nextRetryAt: null } }, { new: true }).select("+pending");
          if (!row) continue;
          try {
            await this.attempt(row, settings, apiKey);
          } catch (err) {
            console.error("[messaging] retry failed:", err.message);
          }
        }
      });
    }

    // The two sweeps below look across every organisation by design: they repair rows, they never read one
    // organisation's content out to another.
    await runUnscoped("background job: sweeps interrupted and stale held messages across all organisations", () => this.sweep(now));
  }

  static async sweep(now) {

    // QUEUED and untouched for ten minutes: the process died between calling the provider and writing
    // the answer. The one case where we genuinely do not know, and the log says so.
    const stuck = await DocumentSend.find({ status: "QUEUED", channel: "email", updatedAt: { $lt: new Date(now - STUCK_MS) } }).select("+pending").limit(50);
    for (const row of stuck) {
      row.status = "FAILED";
      row.lastErrorCode = "SEND_INTERRUPTED";
      row.lastError = "The send was interrupted. It may or may not have gone out: check with the customer before sending it again.";
      row.retryable = false;
      row.failedAt = now;
      row.set("pending", undefined);
      push(row, "FAILED", row.lastError);
      await row.save();
      await writeLastSend(row);
    }

    // A held message is never kept past a day, whatever state it is in.
    await DocumentSend.updateMany({ pending: { $exists: true }, updatedAt: { $lt: new Date(now - KEEP_BYTES_MS) } }, { $unset: { pending: 1 } });
  }
}

MessagingService.parseList = parseList;
module.exports = MessagingService;
