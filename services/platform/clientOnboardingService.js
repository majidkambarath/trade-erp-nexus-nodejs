// The new-client onboarding form, end to end: a developer makes a private link for a client, the client fills the form
// in at that link (saved as they go, files uploaded beside it) and sends it, and the developer makes the organisation
// from what they wrote (PlatformOrganisationService.create with `onboardingId`), which applies the company's letterhead
// and tax identity on the way.
//
// Two kinds of caller, kept apart:
//   - the console (a platform token; services/platform/*): may read everything, including the files;
//   - the client (no session; routes/core/clientOnboardingRoutes.js): holds only the secret link, and may read and
//     change only the form that link names, only while it is still open. It is never shown a file's bytes back.
//
// Unknown, malformed and wrong-secret links all answer the same 404; only someone holding a link whose secret verifies
// learns it was withdrawn or ran out.
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { OnboardingRequest } = require("../../models/platform/onboardingRequestModel");
const OnboardingFile = require("../../models/platform/onboardingFileModel");
const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");
const rules = require("../../utils/clientOnboarding");
const plans = require("../../utils/plans");
const currencies = require("../../utils/currencyCatalog");
const { newToken, parseToken, secretMatches } = require("../../utils/shareToken");
const { runWithTenant } = require("../../utils/tenantContext");

const DAY = 24 * 3600 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;
const WRITABLE = ["invited", "in_progress"];
const LIVE = ["invited", "in_progress", "submitted"];
const STALE_CLAIM_MS = 10 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const notFound = () =>
  new AppError("This link does not work. It may have been typed wrongly, or replaced by a newer one. Ask the person who sent it to you for a new link.", 404, "ONBOARDING_NOT_FOUND");
const consoleNotFound = () => new AppError("That onboarding form was not found", 404, "ONBOARDING_NOT_FOUND");

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, max) : "");
const days = (value, fallback = DEFAULT_DAYS) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new AppError(`A link is valid for 1 to ${MAX_DAYS} days`, 400, "ONBOARDING_DAYS_INVALID");
  return n;
};
const isId = (id) => typeof id === "string" && mongoose.Types.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id);
const safeName = (n) => path.basename(String(n || "file")).replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "file";
const currencyCodes = () => currencies.list().map((c) => c.code);

// The state the screens show: the stored status, except that a link left open past its day reads "expired".
const stateOf = (doc, now = new Date()) => (LIVE.includes(doc.status) && doc.expiresAt && new Date(doc.expiresAt) <= now ? "expired" : doc.status);

const fileMeta = (f) => ({ id: String(f._id), kind: f.kind, name: f.name, size: f.size, mimeType: f.mimeType, uploadedAt: f.uploadedAt });

// Where the client's page lives: the same base as a customer's document link (PUBLIC_APP_URL, else a trusted origin).
const urlFor = (token, req) => `${require("../messaging/shareService").baseUrl(req)}/onboard/${token}`;

// The platform's own log, through the one recorder the console already uses (loaded lazily: that service loads this one).
const record = (entry) => require("./platformOrganisationService").record(entry);
const historyPush = (action, by, note = "") => ({ history: { $each: [{ at: new Date(), by: by || "", action, note }], $slice: -50 } });

// A password for an account made from the form: 12 characters, letters and digits, from a real random source.
function newPassword() {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const bytes = crypto.randomBytes(24);
  const chars = [digits[bytes[0] % digits.length], digits[bytes[1] % digits.length], ...Array.from({ length: 10 }, (_, i) => letters[bytes[i + 2] % letters.length])];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[12 + (i % 12)] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

class ClientOnboardingService {
  static stateOf = stateOf;

  // ---- what each side is shown

  /** The console's view: everything but the secret. `full` adds the answers, what is missing, what was applied and the history. */
  static view(doc, { full = false } = {}) {
    const answers = rules.normaliseAnswers(doc.answers);
    const out = {
      id: String(doc._id),
      clientName: doc.clientName,
      contactName: doc.contactName,
      contactEmail: doc.contactEmail,
      contactPhone: doc.contactPhone,
      note: doc.note,
      planCode: doc.planCode,
      status: doc.status,
      state: stateOf(doc),
      expiresAt: doc.expiresAt,
      openedAt: doc.openedAt,
      lastSeenAt: doc.lastSeenAt,
      views: doc.views || 0,
      savedAt: doc.savedAt,
      submittedAt: doc.submittedAt,
      revokedAt: doc.revokedAt,
      organisationCode: doc.organisationCode,
      organisationCreatedAt: doc.organisationCreatedAt,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      progress: rules.progressOf(answers),
      files: (doc.files || []).map(fileMeta),
    };
    if (full) {
      out.answers = answers;
      out.issues = rules.issuesOf(answers, { currencies: currencyCodes() });
      out.applied = doc.applied || null;
      out.usersCreated = doc.usersCreated || [];
      out.history = doc.history || [];
    }
    return out;
  }

  /** The client's view: their own answers and files, and the lists the form chooses from. Nothing about the developer. */
  static publicView(doc) {
    const answers = rules.normaliseAnswers(doc.answers);
    return {
      clientName: doc.clientName,
      status: doc.status,
      state: stateOf(doc),
      expiresAt: doc.expiresAt,
      savedAt: doc.savedAt,
      submittedAt: doc.submittedAt,
      organisationReady: doc.status === "created",
      answers,
      issues: rules.issuesOf(answers, { currencies: currencyCodes() }),
      files: (doc.files || []).map(fileMeta),
      options: {
        currencies: currencies.list().map((c) => ({ code: c.code, name: c.name })),
        modules: rules.MODULE_CHOICES,
        roles: rules.ROLE_CHOICES,
        fileKinds: rules.FILE_KINDS,
        limits: rules.LIMITS,
      },
      support: process.env.SUPPORT_CONTACT || process.env.SUPPORT_EMAIL || null,
    };
  }

  // ---- the console

  static async list({ status } = {}) {
    const q = {};
    if (status && ["invited", "in_progress", "submitted", "created", "revoked"].includes(status)) q.status = status;
    const rows = await OnboardingRequest.find(q).sort({ updatedAt: -1 }).limit(200).lean();
    return rows.map((r) => this.view(r));
  }

  static async get(id) {
    if (!isId(id)) throw consoleNotFound();
    const doc = await OnboardingRequest.findById(id).lean();
    if (!doc) throw consoleNotFound();
    return doc;
  }

  static async detail(id) {
    return this.view(await this.get(id), { full: true });
  }

  /** A new form for a client: -> { request, url, token }. The link is returned ONCE; only its hash is kept. */
  static async createInvite(input = {}, ctx = {}, req = null) {
    const clientName = text(input.clientName, 120);
    if (clientName.length < 2) throw new AppError("Enter the client's name", 400, "CLIENT_NAME_REQUIRED");
    const contactEmail = text(input.contactEmail, 254).toLowerCase();
    if (contactEmail && !EMAIL.test(contactEmail)) throw new AppError("That email address does not look right", 400, "INVALID_EMAIL");
    const planCode = plans.PLANS[text(input.planCode, 40)] ? text(input.planCode, 40) : "standard";
    const valid = days(input.days);
    const contactName = text(input.contactName, 80);
    const contactPhone = text(input.contactPhone, 25);
    // What the developer already knows is written into the form for the client, who corrects it if it is wrong.
    const answers = rules.normaliseAnswers({ company: { legalName: clientName }, people: { admin: { name: contactName, email: contactEmail, mobile: contactPhone } } });
    const by = ctx.by?.email || "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const t = newToken();
      try {
        const doc = await OnboardingRequest.create({
          publicId: t.publicId, secretHash: t.secretHash,
          clientName, contactName, contactEmail, contactPhone, note: text(input.note, 1000), planCode,
          expiresAt: new Date(Date.now() + valid * DAY), answers, createdBy: by,
          history: [{ at: new Date(), by, action: "created" }],
        });
        await record({ ...ctx, action: "ONBOARDING_LINK_CREATED", summary: `Onboarding form made for ${clientName} (${doc._id}), valid for ${valid} days` });
        return { request: this.view(doc.toObject(), { full: true }), token: t.token, url: urlFor(t.token, req) };
      } catch (err) {
        if (err?.code !== 11000) throw err; // a selector collision: draw another
      }
    }
    throw new AppError("Could not make a link. Try again.", 500, "ONBOARDING_MINT_FAILED");
  }

  /** A fresh link for the same form (the old one stops working). Also how a withdrawn form is opened again. */
  static async newLink(id, input = {}, ctx = {}, req = null) {
    const doc = await this.get(id);
    if (doc.status === "created") throw new AppError("The organisation has already been made from this form", 409, "ONBOARDING_DONE");
    const valid = days(input.days);
    const t = newToken();
    const status = doc.status === "revoked" ? (doc.savedAt ? "in_progress" : "invited") : doc.status;
    await OnboardingRequest.updateOne(
      { _id: doc._id },
      { $set: { publicId: t.publicId, secretHash: t.secretHash, status, revokedAt: null, expiresAt: new Date(Date.now() + valid * DAY) }, $push: historyPush("new link", ctx.by?.email) }
    );
    await record({ ...ctx, action: "ONBOARDING_LINK_RENEWED", summary: `New onboarding link for ${doc.clientName} (${doc._id}); the old one no longer works` });
    return { request: await this.detail(id), token: t.token, url: urlFor(t.token, req) };
  }

  static async revoke(id, ctx = {}) {
    const doc = await this.get(id);
    if (doc.status === "created") throw new AppError("The organisation has already been made from this form", 409, "ONBOARDING_DONE");
    await OnboardingRequest.updateOne({ _id: doc._id }, { $set: { status: "revoked", revokedAt: new Date() }, $push: historyPush("withdrawn", ctx.by?.email) });
    await record({ ...ctx, action: "ONBOARDING_REVOKED", summary: `Onboarding form for ${doc.clientName} (${doc._id}) withdrawn` });
    return this.detail(id);
  }

  /** A sent form opened again, so the client can change it. */
  static async reopen(id, ctx = {}) {
    const doc = await this.get(id);
    if (doc.status !== "submitted") throw new AppError("Only a form the client has sent can be opened again", 409, "ONBOARDING_NOT_SUBMITTED");
    await OnboardingRequest.updateOne({ _id: doc._id, status: "submitted" }, { $set: { status: "in_progress" }, $push: historyPush("opened again", ctx.by?.email) });
    await record({ ...ctx, action: "ONBOARDING_REOPENED", summary: `Onboarding form for ${doc.clientName} (${doc._id}) opened again for changes` });
    return this.detail(id);
  }

  static async extend(id, input = {}, ctx = {}) {
    const doc = await this.get(id);
    if (!LIVE.includes(doc.status)) throw new AppError("Only an open form can be given more time", 409, "ONBOARDING_NOT_OPEN");
    const more = days(input.days);
    const from = Math.max(new Date(doc.expiresAt).getTime(), Date.now());
    await OnboardingRequest.updateOne({ _id: doc._id }, { $set: { expiresAt: new Date(from + more * DAY) }, $push: historyPush(`given ${more} more days`, ctx.by?.email) });
    await record({ ...ctx, action: "ONBOARDING_EXTENDED", summary: `Onboarding form for ${doc.clientName} (${doc._id}) given ${more} more days` });
    return this.detail(id);
  }

  /** A file the client uploaded, with its bytes, for the developer to download. */
  static async file(id, fileId) {
    const doc = await this.get(id);
    if (!isId(fileId) || !(doc.files || []).some((f) => String(f._id) === fileId)) throw new AppError("That file was not found", 404, "FILE_NOT_FOUND");
    // not lean: a lean read hands back the driver's Binary, and the route wants the bytes as a Buffer
    const stored = await OnboardingFile.findOne({ _id: fileId, requestId: doc._id }).select("+data");
    if (!stored) throw new AppError("That file was not found", 404, "FILE_NOT_FOUND");
    return { name: stored.name, mimeType: stored.mimeType, size: stored.size, data: Buffer.from(stored.data) };
  }

  /** The developer removes a file (once it has been imported, say). Allowed whatever the form's state. */
  static async deleteFile(id, fileId, ctx = {}) {
    const doc = await this.get(id);
    const meta = (doc.files || []).find((f) => String(f._id) === fileId);
    if (!isId(fileId) || !meta) throw new AppError("That file was not found", 404, "FILE_NOT_FOUND");
    await OnboardingRequest.updateOne({ _id: doc._id }, { $pull: { files: { _id: meta._id } }, $push: historyPush(`file removed: ${meta.name}`, ctx.by?.email) });
    await OnboardingFile.deleteOne({ _id: meta._id, requestId: doc._id });
    await record({ ...ctx, action: "ONBOARDING_FILE_REMOVED", summary: `File ${meta.name} removed from the onboarding form for ${doc.clientName} (${doc._id})` });
    return this.detail(id);
  }

  // ---- making the organisation from the form (called by PlatformOrganisationService.create)

  /**
   * Take the form for creation, so two developers pressing Create cannot make two organisations. A claim older than ten
   * minutes is treated as abandoned (a server that stopped half way). -> the request.
   */
  static async claim(id) {
    if (!isId(String(id || ""))) throw consoleNotFound();
    const stale = new Date(Date.now() - STALE_CLAIM_MS);
    const doc = await OnboardingRequest.findOneAndUpdate(
      { _id: id, status: { $in: LIVE }, $or: [{ creatingAt: null }, { creatingAt: { $lt: stale } }] },
      { $set: { creatingAt: new Date() } },
      { new: true }
    ).lean();
    if (doc) return doc;
    const found = await OnboardingRequest.findById(id).select("status organisationCode").lean();
    if (!found) throw consoleNotFound();
    if (found.status === "created") throw new AppError(`An organisation (${found.organisationCode}) has already been made from this form`, 409, "ONBOARDING_ALREADY_USED");
    if (found.status === "revoked") throw new AppError("This form has been withdrawn. Make a new link first, or create the organisation without it.", 409, "ONBOARDING_REVOKED");
    throw new AppError("Somebody is making the organisation from this form right now", 409, "ONBOARDING_BUSY");
  }

  /** Give the form back when making the organisation failed. */
  static async release(id) {
    await OnboardingRequest.updateOne({ _id: id, status: { $ne: "created" } }, { $set: { creatingAt: null } });
  }

  /**
   * Write what the client gave into the new organisation: the letterhead (CompanyProfileService) and the tax identity and
   * the year's first month (AccountConfigService). Each is checked by its own service; a refusal is reported, never
   * thrown - the organisation exists by now. -> { profile, settings } with { state, fields | message } each.
   */
  static async applyTo(code, doc) {
    const CompanyProfileService = require("../core/companyProfileService");
    const AccountConfigService = require("../financial/accountConfigService");
    const applied = { profile: null, settings: null };
    await runWithTenant({ companyId: code, branchId: "main" }, async () => {
      const patch = rules.toProfilePatch(doc.answers);
      if (Object.keys(patch).length) {
        try {
          await CompanyProfileService.update(patch);
          applied.profile = { state: "done", fields: Object.keys(patch) };
        } catch (error) {
          applied.profile = { state: "failed", message: error.message };
        }
      }
      const settings = rules.toSettingsPatch(doc.answers);
      if (settings) {
        try {
          await AccountConfigService.updateSettings(settings, null);
          applied.settings = { state: "done", fields: [...Object.keys(settings.profile || {}), ...(settings.fiscalYearStartMonth ? ["fiscalYearStartMonth"] : [])] };
        } catch (error) {
          applied.settings = { state: "failed", message: error.message };
        }
      }
    });
    return applied;
  }

  static async markCreated(id, code, applied, ctx = {}) {
    await OnboardingRequest.updateOne(
      { _id: id },
      { $set: { status: "created", organisationCode: code, organisationCreatedAt: new Date(), creatingAt: null, applied }, $push: historyPush(`organisation ${code} made`, ctx.by?.email) }
    );
  }

  /**
   * The client's other people, as accounts in their organisation: each with a new password shown ONCE in the answer and
   * stored nowhere readable, each told to change it at first sign-in. A person already made (by this or by hand) is
   * skipped; a refusal (the plan's user limit, an email already in use, a role this organisation does not offer) is
   * reported per person and the rest carry on. -> { created: [{ name, email, role, password }], failed: [...], skipped }.
   */
  static async createUsers(id, ctx = {}) {
    const doc = await this.get(id);
    if (doc.status !== "created" || !doc.organisationCode) throw new AppError("Make the organisation from this form first", 409, "ONBOARDING_NO_ORGANISATION");
    const Orgs = require("./platformOrganisationService");
    const { people } = rules.normaliseAnswers(doc.answers);
    const done = new Set((doc.usersCreated || []).map((u) => String(u.email).toLowerCase()));
    const created = [];
    const failed = [];
    let skipped = 0;
    for (const u of people.users) {
      if (!u.email || done.has(u.email)) {
        skipped += 1;
        continue;
      }
      const password = newPassword();
      try {
        await Orgs.createUser(doc.organisationCode, { name: u.name, email: u.email, role: u.role, password }, ctx);
        created.push({ name: u.name, email: u.email, role: u.role, password });
        done.add(u.email);
        await OnboardingRequest.updateOne({ _id: doc._id }, { $push: { usersCreated: { email: u.email, name: u.name, role: u.role, at: new Date() } } });
      } catch (error) {
        failed.push({ name: u.name, email: u.email, role: u.role, message: error.message, code: error.code || null });
      }
    }
    return { created, failed, skipped };
  }

  // ---- the client, holding only the link

  /** The form the link names, or the same 404 for anything that is not a valid, matching link. */
  static async resolve(token) {
    const parsed = parseToken(token);
    if (!parsed) throw notFound();
    const doc = await OnboardingRequest.findOne({ publicId: parsed.publicId }).select("+secretHash");
    if (!doc || !secretMatches(parsed.secret, doc.secretHash)) throw notFound();
    if (doc.status === "revoked") throw new AppError("This form has been withdrawn. Ask the person who sent it for a new link.", 410, "ONBOARDING_REVOKED");
    if (stateOf(doc) === "expired") throw new AppError("This link has run out. Ask the person who sent it for a new one: what you wrote is kept.", 410, "ONBOARDING_EXPIRED");
    return doc;
  }

  static assertWritable(doc) {
    if (doc.status === "created") throw new AppError("Your organisation has already been set up from this form.", 409, "ONBOARDING_DONE");
    if (doc.status === "submitted") throw new AppError("This form has been sent. To change something, ask the person who sent it to open it again.", 409, "ONBOARDING_SUBMITTED");
    if (doc.creatingAt && Date.now() - new Date(doc.creatingAt).getTime() < STALE_CLAIM_MS) throw new AppError("Your organisation is being set up from this form right now.", 409, "ONBOARDING_LOCKED");
  }

  // One update for any write by the client: only while the form is open and nobody is making the organisation from it.
  static writableFilter(doc) {
    return { _id: doc._id, status: { $in: WRITABLE }, $or: [{ creatingAt: null }, { creatingAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } }] };
  }

  static locked() {
    return new AppError("This form can no longer be changed. Open the link again to see where it stands.", 409, "ONBOARDING_LOCKED");
  }

  static async open(token) {
    const doc = await this.resolve(token);
    const now = new Date();
    await OnboardingRequest.updateOne({ _id: doc._id }, { $inc: { views: 1 }, $set: { lastSeenAt: now, ...(doc.openedAt ? {} : { openedAt: now }) } });
    return this.publicView(doc.toObject());
  }

  /** Save what the client has written so far (the whole form, cleaned). -> { savedAt, progress }. */
  static async save(token, body = {}) {
    const doc = await this.resolve(token);
    this.assertWritable(doc);
    const answers = rules.normaliseAnswers(body?.answers);
    const now = new Date();
    const r = await OnboardingRequest.updateOne(this.writableFilter(doc), { $set: { answers, savedAt: now, lastSeenAt: now, status: "in_progress" } });
    if (!r.matchedCount) throw this.locked();
    return { savedAt: now, progress: rules.progressOf(answers), issues: rules.issuesOf(answers, { currencies: currencyCodes() }) };
  }

  /** One file into one slot. -> the file's description (never its bytes). */
  static async upload(token, { kind, file } = {}) {
    const doc = await this.resolve(token);
    this.assertWritable(doc);
    const slot = typeof kind === "string" ? kind : "";
    if (!rules.FILE_KINDS[slot]) throw new AppError("Choose what the file is", 400, "FILE_KIND_INVALID");
    if (!file?.buffer?.length) throw new AppError("No file was received", 400, "NO_FILE");
    if (file.size > rules.LIMITS.fileBytes) throw new AppError(`A file may be at most ${rules.LIMITS.fileBytes / 1024 / 1024} MB`, 413, "FILE_TOO_LARGE");
    if (!rules.fileAllowed(slot, file.originalname)) {
      throw new AppError(`This slot takes ${rules.FILE_KINDS[slot].join(", ")} files`, 415, "FILE_TYPE_NOT_ALLOWED", { allowed: rules.FILE_KINDS[slot] });
    }
    const { mime } = require("../core/attachmentService").validate(file); // the bytes must be what the ending says
    const files = doc.files || [];
    if (files.length >= rules.LIMITS.files) throw new AppError(`At most ${rules.LIMITS.files} files can be added. Remove one first.`, 409, "ONBOARDING_TOO_MANY_FILES");
    const used = files.reduce((s, f) => s + (f.size || 0), 0);
    if (used + file.size > rules.LIMITS.totalBytes) throw new AppError(`The files may add up to at most ${rules.LIMITS.totalBytes / 1024 / 1024} MB. Remove one first.`, 413, "ONBOARDING_FILES_TOO_LARGE");

    const name = safeName(file.originalname);
    const stored = await OnboardingFile.create({ requestId: doc._id, kind: slot, name, mimeType: mime, size: file.size, data: file.buffer });
    const meta = { _id: stored._id, kind: slot, name, size: file.size, mimeType: mime, uploadedAt: new Date() };
    // the count is held by the update itself, so two uploads at once cannot both slip past it
    const r = await OnboardingRequest.updateOne(
      { ...this.writableFilter(doc), [`files.${rules.LIMITS.files - 1}`]: { $exists: false } },
      { $push: { files: meta }, $set: { lastSeenAt: new Date(), status: "in_progress" } }
    );
    if (!r.matchedCount) {
      await OnboardingFile.deleteOne({ _id: stored._id });
      throw this.locked();
    }
    return fileMeta(meta);
  }

  static async removeFile(token, fileId) {
    const doc = await this.resolve(token);
    this.assertWritable(doc);
    const meta = isId(fileId) ? (doc.files || []).find((f) => String(f._id) === fileId) : null;
    if (!meta) throw new AppError("That file was not found", 404, "FILE_NOT_FOUND");
    const r = await OnboardingRequest.updateOne({ ...this.writableFilter(doc), "files._id": meta._id }, { $pull: { files: { _id: meta._id } } });
    if (!r.matchedCount) throw this.locked();
    await OnboardingFile.deleteOne({ _id: meta._id, requestId: doc._id });
    return { removed: fileId };
  }

  /**
   * Send the form: what is written is saved and judged together, so a submit can never pass on answers older than the ones
   * on screen. Refused with every missing answer at once (422 ONBOARDING_INCOMPLETE, details.issues).
   */
  static async submit(token, body = {}) {
    const doc = await this.resolve(token);
    this.assertWritable(doc);
    const answers = rules.normaliseAnswers(body?.answers !== undefined ? body.answers : doc.answers);
    const issues = rules.issuesOf(answers, { currencies: currencyCodes() });
    if (issues.length) {
      // keep what they wrote even though it cannot be sent yet
      await OnboardingRequest.updateOne(this.writableFilter(doc), { $set: { answers, savedAt: new Date(), status: "in_progress" } });
      throw new AppError(issues.length === 1 ? "One answer is still missing" : `${issues.length} answers are still missing`, 422, "ONBOARDING_INCOMPLETE", { issues });
    }
    const now = new Date();
    const r = await OnboardingRequest.updateOne(this.writableFilter(doc), {
      $set: { answers, savedAt: now, submittedAt: now, lastSeenAt: now, status: "submitted" },
      $push: historyPush("sent by the client", "client"),
    });
    if (!r.matchedCount) throw this.locked();
    await record({ by: { email: "client" }, action: "ONBOARDING_SUBMITTED", summary: `${doc.clientName} sent their onboarding form (${doc._id})` });
    this.tellDeveloper(doc).catch((error) => logger.warn(`onboarding: could not tell the developer: ${error.message}`));
    return { submittedAt: now };
  }

  // The developer who made the link hears that it came back. Never awaited by the client's request: a mail problem must
  // not stop a form being sent.
  static async tellDeveloper(doc) {
    if (!doc.createdBy || !EMAIL.test(doc.createdBy)) return;
    const mailer = require("../core/systemMailer");
    const base = require("../messaging/shareService").baseUrl(null);
    const link = `${base}/platform/onboarding/${doc._id}`;
    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    await mailer.send({
      to: doc.createdBy,
      subject: `${doc.clientName} sent their onboarding form`,
      text: `${doc.clientName} has filled in and sent their onboarding form.\n\nReview it and create their organisation in the developer console:\n${link}\n`,
      html: `<p><strong>${esc(doc.clientName)}</strong> has filled in and sent their onboarding form.</p><p>Review it and create their organisation in the developer console:<br><a href="${esc(link)}">${esc(link)}</a></p>`,
    });
  }
}

module.exports = ClientOnboardingService;
