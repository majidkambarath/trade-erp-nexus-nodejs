// Payment reminders: an email to a customer whose invoice is about to fall due, falls due today, or is overdue.
// What is owed and when is utils/paymentReminders.js (pure); this is the part that reads the books and sends.
//
// THREE RULES THAT MATTER:
//   - Reviewed by a person BY DEFAULT. `reminders.mode` is "off", "review" (a list a person sends from) or "automatic" (the same list sent
//     once a day by itself, from the chosen hour). Switching to automatic starts the NEXT day, so nobody wakes to a hundred emails
//     they never saw.
//   - EXACTLY ONCE. The claim is the DocumentSend row itself, written BEFORE the provider is called, under the idempotency key
//     `reminder:<invoice>:<step>` on the existing unique index. Two servers, a retry, or a person pressing Send while the job runs
//     cannot send one step of one invoice twice. A refusal that would fail every send (the key, the sender, the quota) gives the
//     claim back and stops the pass, so tomorrow's run is not blocked by today's setup fault.
//   - It never TALKS for a person: no PDF (it is drawn only in the browser), the invoice is the link, and nothing says "delivered".
const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const { DocumentSend, MessagingSettings } = require("../../models/modules/messagingModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");
const { todayInOrg, addDays, diffDays, toExpiryDay } = require("../../utils/documentExpiry");
const { termDays } = require("../../utils/paymentState");
const rules = require("../../utils/paymentReminders");
const { renderDocumentEmail } = require("../../utils/emailTemplates");
const Settings = require("./settingsService");
const DocumentSource = require("./documentSource");
const ShareService = require("./shareService");
const MessagingService = require("./messagingService");
const NotificationService = require("../core/notificationService");
const AuditService = require("../core/auditService");

const MAX_SCAN = 5000; // open invoices read in one pass: more than this and the rest wait for the next pass, oldest first
const MAX_MANUAL = 50; // one press of "Send"
const MAX_AUTOMATIC = 25; // one automatic pass
const CHECK_EVERY_MS = 30 * 60 * 1000; // the notice check reads every open invoice: not on every five-minute tick
const KIND_READY = "payment_reminders_ready";
const KIND_BLOCKED = "payment_reminders_blocked";

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

class PaymentReminderService {
  static lastCheck = new Map(); // organisation -> when its notice check last ran (in memory: a restart runs it once at once)

  /** The settings as the screens and the planner read them: complete, with the allowance beside it. */
  static async settings() {
    const { companyId } = getTenant();
    const held = await MessagingSettings.findOne({ companyId }).select("reminders dailyLimit enabled provider").lean();
    return { ...rules.settingsOf(held?.reminders), messagingOn: Boolean(held?.enabled), provider: held?.provider || "console", dailyLimit: held?.dailyLimit || 200 };
  }

  /** `PUT /messaging/reminders/settings`. Only the `reminders` paths are written, so the Sending form can never overwrite them. */
  static async updateSettings(data = {}) {
    const { companyId } = getTenant();
    let changes;
    try {
      changes = rules.validateSettings(data);
    } catch (e) {
      throw new AppError(e.message, 400, "INVALID_REMINDER_SETTINGS", { field: e.field });
    }
    const before = await this.settings();
    if (changes.mode === "automatic" && !before.messagingOn) {
      throw new AppError("Automatic reminders need sending switched on first. Do that in Settings, under Sending.", 422, "MESSAGING_NOT_READY");
    }
    const set = {};
    for (const [k, v] of Object.entries(changes)) set[`reminders.${k}`] = v;
    // Turning automatic ON starts tomorrow: the first run must not surprise anybody with a day's worth of emails they never reviewed.
    if (changes.mode === "automatic" && before.mode !== "automatic") set["reminders.lastAutoRunDay"] = todayInOrg();
    if (Object.keys(set).length) await MessagingSettings.updateOne({ companyId }, { $set: set }, { upsert: true });
    return { before, after: await this.settings() };
  }

  /**
   * What is owed a reminder now. `ids` narrows it to some invoices (the send re-plans the ones it was asked for rather than trusting the
   * screen). -> { settings, today, rows, skipped { noEmail, optedOut }, truncated }
   */
  static async plan({ now = new Date(), ids } = {}) {
    const settings = await this.settings();
    const today = todayInOrg(now);
    const match = { type: "sales_order", status: "APPROVED", isOpening: { $ne: true }, outstandingAmount: { $gt: 0.005 } };
    if (ids) match._id = { $in: ids.filter((i) => mongoose.isValidObjectId(i)) };
    const invoices = await Transaction.find(match)
      .select("transactionNo invoiceNumber date dueDate partyId totalAmount outstandingAmount fx lastReminder")
      .sort({ date: 1 })
      .limit(MAX_SCAN + 1)
      .lean();
    const truncated = invoices.length > MAX_SCAN;
    if (truncated) invoices.length = MAX_SCAN;
    const out = { settings, today, rows: [], skipped: { noEmail: 0, optedOut: 0 }, truncated };
    if (!invoices.length) return out;

    const [customers, sent] = await Promise.all([
      Customer.find({ _id: { $in: [...new Set(invoices.map((i) => String(i.partyId)))] } }).select("customerName email contacts contactPerson paymentTerms remindersOff").lean(),
      DocumentSend.find({ purpose: "reminder", sourceId: { $in: invoices.map((i) => i._id) }, reminderStep: { $type: "string" } }).select("sourceId reminderStep").lean(),
    ]);
    const customerOf = new Map(customers.map((c) => [String(c._id), c]));
    const usedOf = new Map();
    for (const s of sent) {
      const key = String(s.sourceId);
      if (!usedOf.has(key)) usedOf.set(key, new Set());
      usedOf.get(key).add(s.reminderStep);
    }

    for (const tx of invoices) {
      const customer = customerOf.get(String(tx.partyId));
      if (!customer) continue;
      const issued = toExpiryDay(tx.date);
      const dueDay = tx.dueDate ? toExpiryDay(tx.dueDate) : issued ? addDays(issued, termDays(customer.paymentTerms)) : null;
      if (!dueDay) continue;
      const offset = rules.offsetOf(today, dueDay);
      const plan = rules.planStep({ offset, steps: settings.steps, catchUpDays: settings.catchUpDays, used: usedOf.get(String(tx._id)) || new Set(), daysSinceIssue: diffDays(issued, today) });
      if (!plan) continue;
      if (customer.remindersOff === true) { out.skipped.optedOut += 1; continue; }
      const to = DocumentSource.recipientsOf(customer)[0];
      if (!to) { out.skipped.noEmail += 1; continue; }
      const foreign = tx.fx?.currency ? tx.fx : null;
      out.rows.push({
        invoiceId: String(tx._id),
        documentNo: tx.invoiceNumber || tx.transactionNo,
        partyId: String(customer._id),
        partyName: customer.customerName,
        to,
        currency: foreign ? foreign.currency : orgLocale.baseCurrency(),
        total: money(foreign ? foreign.totalAmount : tx.totalAmount),
        outstanding: money(foreign ? foreign.outstandingAmount : tx.outstandingAmount),
        date: issued,
        dueDay,
        daysLate: offset, // negative before the due date
        step: plan.step,
        stepKey: plan.key,
        stage: plan.stage,
        lastReminder: tx.lastReminder || null,
      });
    }
    out.rows.sort((a, b) => b.daysLate - a.daysLate || a.documentNo.localeCompare(b.documentNo));
    return out;
  }

  /** The emails sent in the last day by anything, against the organisation's limit: what a reminder may still use. */
  static async allowance(settings) {
    const { companyId } = getTenant();
    const CrmEmailService = require("../crm/crmEmailService");
    const used = await CrmEmailService.sentInLastDay(companyId);
    return { used, limit: settings.dailyLimit, room: rules.room({ dailyLimit: settings.dailyLimit, used }) };
  }

  /** `GET /messaging/reminders/due`: the list a person reviews. */
  static async due({ now = new Date() } = {}) {
    const plan = await this.plan({ now });
    return { ...plan, allowance: await this.allowance(plan.settings) };
  }

  /**
   * Send the reminders a person (or the automatic pass) chose. `items` are `{ invoiceId, step }`; each is RE-PLANNED here, and sent only
   * if it is still owed that very step (it may have been paid, sent by a colleague a moment ago, or have moved on a step since the screen
   * was drawn). -> { sent[], failed[], skipped[], stopped }
   */
  static async sendMany({ items, req = {}, by = "system", byName = "automatic", auto = false, now = new Date() } = {}) {
    const { companyId } = getTenant(req);
    const cap = auto ? MAX_AUTOMATIC : MAX_MANUAL;
    const asked = (Array.isArray(items) ? items : []).filter((i) => i && mongoose.isValidObjectId(i.invoiceId) && Number.isInteger(Number(i.step))).slice(0, cap);
    const result = { sent: [], failed: [], skipped: [], stopped: null };
    if (!asked.length) return result;

    const settings = await Settings.load(companyId, { withSecrets: true });
    if (!settings.enabled) throw new AppError("Sending is switched off. Ask a manager to switch it on in Settings, under Sending.", 422, "MESSAGING_DISABLED");
    const bad = (await Settings.readiness(req, settings)).checks.filter((c) => c.blocking && !c.ok);
    if (bad.length) throw new AppError(`Sending is not set up yet: ${bad.map((c) => c.label).join("; ")}`, 422, "MESSAGING_NOT_CONFIGURED", { missing: bad.map((c) => c.key) });
    const apiKey = Settings.keyOf(settings);

    const plan = await this.plan({ now, ids: asked.map((i) => i.invoiceId) });
    const byInvoice = new Map(plan.rows.map((r) => [r.invoiceId, r]));
    let { room } = await this.allowance({ dailyLimit: settings.dailyLimit });

    for (const item of asked) {
      const row = byInvoice.get(String(item.invoiceId));
      if (!row || row.step !== Number(item.step)) { result.skipped.push({ invoiceId: String(item.invoiceId), reason: "NOT_DUE" }); continue; }
      if (room <= 0) { result.skipped.push({ invoiceId: row.invoiceId, documentNo: row.documentNo, reason: "ALLOWANCE" }); result.stopped = result.stopped || "ALLOWANCE"; continue; }
      const done = await this.sendOne(row, { settings, apiKey, by, byName, req, auto });
      if (done.result === "duplicate") { result.skipped.push({ invoiceId: row.invoiceId, documentNo: row.documentNo, reason: "ALREADY_SENT" }); continue; }
      room -= 1;
      if (done.result === "failed") {
        result.failed.push({ invoiceId: row.invoiceId, documentNo: row.documentNo, code: done.code, message: done.message });
        if (done.orgWide) { result.stopped = done.code; break; } // every further send would fail the same way
        continue;
      }
      result.sent.push({ invoiceId: row.invoiceId, documentNo: row.documentNo, to: row.to, step: row.stepKey, sendId: String(done.sendId), recordedOnly: settings.provider === "console" });
    }
    return result;
  }

  /** One reminder: claim it, build it, send it. Never throws for a provider answer: the row holds what happened. */
  static async sendOne(row, { settings, apiKey, by, byName, req, auto }) {
    const { companyId, branchId } = getTenant(req);
    const { claim, present, checkRecipients, oneLine } = MessagingService.internals;
    let doc;
    try {
      doc = await DocumentSource.load("tax_invoice", row.invoiceId, req);
      checkRecipients({ to: [row.to], cc: [], bcc: [] });
    } catch (e) {
      return { result: "failed", code: e.code || "NOT_SENDABLE", message: e.message };
    }
    const { row: log, duplicate } = await claim({
      companyId, branchId, docType: "tax_invoice", sourceType: "Transaction", sourceId: doc.sourceId, documentNo: doc.documentNo,
      partyId: doc.partyId, partyName: doc.partyName, channel: "email", status: "QUEUED", to: [row.to], cc: [], bcc: [],
      purpose: "reminder", reminderStep: row.stepKey, provider: settings.provider,
      idempotencyKey: rules.claimKey(row.invoiceId, row.step), sentBy: by, sentByName: byName, history: [{ status: "QUEUED", at: new Date() }],
    });
    if (duplicate) return { result: "duplicate" };

    try {
      const share = settings.shareEnabled ? await ShareService.mint({ doc, days: settings.shareLinkDays, by, req }) : null;
      const mail = renderDocumentEmail({
        ...doc, currency: row.currency, total: row.total, dueDate: row.dueDay, shareUrl: share?.url, shareExpiresAt: share?.expiresAt,
        signature: settings.signature, hasAttachment: false,
        reminder: { stage: row.stage, days: Math.abs(row.daysLate), outstanding: row.outstanding },
      });
      log.subject = oneLine(mail.subject, 200);
      log.bodyPreview = (share ? mail.text.split(share.url).join("[document link]") : mail.text).slice(0, 400);
      log.shareLinkId = share?.link._id;
      log.pending = { html: mail.html, text: mail.text };
      await log.save();
    } catch (err) {
      log.status = "FAILED";
      log.lastError = err.message;
      log.lastErrorCode = "SEND_PREPARE_FAILED";
      log.retryable = false;
      log.failedAt = new Date();
      MessagingService.internals.push(log, "FAILED", err.message);
      await log.save().catch(() => {});
      await MessagingService.internals.writeLastSend(log);
      return { result: "failed", code: "SEND_PREPARE_FAILED", message: err.message };
    }

    await MessagingService.attempt(log, settings, apiKey); // swallows a provider failure: the row holds it
    if (log.status === "FAILED" && rules.isOrgWide(log.lastErrorCode)) {
      // Not this invoice's fault: give the claim back (the row stays as the record) so the same step can go once the setup is fixed.
      await DocumentSend.updateOne({ _id: log._id }, { $set: { idempotencyKey: `released:${log._id}`, reminderStep: null } });
      return { result: "failed", code: log.lastErrorCode, message: log.lastError, orgWide: true, sendId: log._id };
    }
    if (log.status === "FAILED") return { result: "failed", code: log.lastErrorCode, message: log.lastError, sendId: log._id };
    await AuditService.log({
      req, action: "PAYMENT_REMINDER_SENT", entity: "Transaction", entityId: doc.sourceId,
      summary: `Payment reminder (${row.stage === "overdue" ? `${Math.abs(row.daysLate)} days overdue` : row.stage === "due" ? "due today" : `due in ${Math.abs(row.daysLate)} days`}) for ${doc.documentNo} sent to ${row.to}${auto ? " automatically" : ""}`,
      after: { sendId: String(log._id), step: row.stepKey, to: row.to, outstanding: row.outstanding, currency: row.currency, auto: Boolean(auto) },
    });
    return { result: "sent", sendId: log._id, present: present(log) };
  }

  /**
   * The automatic pass: only in automatic mode, only from the chosen hour, once a calendar day (the day is claimed with a compare-and-set,
   * so two servers cannot both run it). A pass that cannot send because setup is missing gives the day back, so a fix made at noon still
   * sends that afternoon. -> { ran, sent, failed, error? }
   */
  static async runAutomatic({ now = new Date() } = {}) {
    const { companyId } = getTenant();
    const settings = await this.settings();
    const today = todayInOrg(now);
    if (!rules.automaticDue({ settings, today, hour: rules.hourIn(orgLocale.timezone(), now) })) return { ran: false };
    const claimed = await MessagingSettings.updateOne({ companyId, "reminders.mode": "automatic", "reminders.lastAutoRunDay": { $ne: today } }, { $set: { "reminders.lastAutoRunDay": today } });
    if (claimed.modifiedCount !== 1) return { ran: false };
    try {
      const plan = await this.plan({ now });
      const items = plan.rows.slice(0, MAX_AUTOMATIC).map((r) => ({ invoiceId: r.invoiceId, step: r.step }));
      const out = await this.sendMany({ items, auto: true, now });
      return { ran: true, sent: out.sent.length, failed: out.failed.length, stopped: out.stopped };
    } catch (error) {
      if (error instanceof AppError) {
        await MessagingSettings.updateOne({ companyId }, { $set: { "reminders.lastAutoRunDay": settings.lastAutoRunDay } }); // try again later today
        return { ran: true, sent: 0, failed: 0, error: { code: error.errorCode || error.code, message: error.message } };
      }
      throw error;
    }
  }

  /**
   * The scheduled check (notificationChecksService.CHECKS): in review mode, one notice saying how many are ready; in automatic mode, run
   * the pass and warn only when it could not send. Both notices close themselves. Held to once every 30 minutes per organisation.
   */
  static async check(now = new Date()) {
    const { companyId } = getTenant();
    const last = this.lastCheck.get(companyId);
    if (last && now.getTime() - last < CHECK_EVERY_MS && now.getTime() >= last) return { skipped: "ran recently" };
    this.lastCheck.set(companyId, now.getTime());

    const settings = await this.settings();
    const ready = [];
    const blocked = [];
    if (settings.mode === "review") {
      const plan = await this.plan({ now });
      if (plan.rows.length) {
        ready.push(KIND_READY);
        await NotificationService.raise({
          kind: KIND_READY, severity: "info", dedupeKey: KIND_READY, permission: "sales.send", link: "/payment-reminders", now,
          title: plan.rows.length === 1 ? "1 payment reminder is ready to send" : `${plan.rows.length} payment reminders are ready to send`,
          body: "Check the list and send them in one go.",
        });
      }
    } else if (settings.mode === "automatic") {
      const out = await this.runAutomatic({ now });
      const problem = out.error?.message || (out.stopped && out.stopped !== "ALLOWANCE" ? `The email service refused the reminders (${out.stopped}).` : null);
      if (problem) {
        blocked.push(KIND_BLOCKED);
        await NotificationService.raise({
          kind: KIND_BLOCKED, severity: "warning", dedupeKey: KIND_BLOCKED, permission: "settings.manage", link: "/settings?tab=sending", now,
          title: "Automatic payment reminders could not be sent", body: problem,
        });
      }
    }
    await NotificationService.resolveMissing({ kind: KIND_READY, activeDedupeKeys: ready, now });
    await NotificationService.resolveMissing({ kind: KIND_BLOCKED, activeDedupeKeys: blocked, now });
    return { mode: settings.mode, ready: ready.length > 0, blocked: blocked.length > 0 };
  }
}

module.exports = PaymentReminderService;
