// Writing to a customer from the CRM, and keeping what was written on their record.
//
// The gap this closes: a salesperson had to leave for Outlook to send one email, and nothing of that conversation
// came back. Now the email is sent from here and lands in the lead's, the deal's or the person's timeline beside the
// calls and the meetings, so the next person to pick the account up can see what was actually said.
//
// It reuses the ORGANISATION's own mail account (services/messaging/settingsService.js) and the provider layer, like
// `meetingMailer.js` and for the same reason: `MessagingService.send` is document-shaped - a docType, a share link, a
// PDF, a retry row per document - and a letter to a customer is not a document. Forcing one through it would mean
// inventing a fake docType.
//
// It is NOT two-way email. We send and we remember; the customer's reply arrives in the salesperson's own mailbox,
// which we do not read. The screen says so, and nothing here ever implies a reply has been seen.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const Contact = require("../../models/modules/crm/contactModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const Lead = require("../../models/modules/crm/leadModel");
const Customer = require("../../models/modules/customerModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const { DocumentSend } = require("../../models/modules/messagingModels");
const rules = require("../../utils/crm");
const email = require("../../utils/crmEmail");
const Settings = require("../messaging/settingsService");
const { PROVIDERS, formatFrom } = require("../messaging/providers");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg } = require("../../utils/documentExpiry");
const ActivityService = require("./activityService");
const CrmSetupService = require("./crmSetupService");
const logger = require("../../utils/logger");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

class CrmEmailService {
  // ---- templates ----------------------------------------------------------------------------------------------

  /**
   * The organisation's own templates. Stored beside the CRM's other settings but managed apart from them, so
   * `normaliseSettings` keeps its fixed key set and a template cannot be lost by saving the automation settings.
   *
   * An organisation that has never saved any gets the starters - not written to the database, just offered, so
   * clearing the list really does clear it instead of resurrecting three emails nobody asked for.
   */
  static async templates() {
    const doc = await CompanySettings.findOne({}).select("crm.emailTemplates crm.emailSignature").lean();
    const stored = doc?.crm?.emailTemplates;
    return {
      templates: Array.isArray(stored) ? email.normaliseTemplates(stored) : email.STARTER_TEMPLATES,
      signature: String(doc?.crm?.emailSignature || ""),
      starters: !Array.isArray(stored),
      placeholders: email.PLACEHOLDERS.map(([key, label]) => ({ key, label })),
    };
  }

  static async saveTemplates(input = {}) {
    const list = Array.isArray(input.templates) ? input.templates : [];
    const errors = email.validateTemplates(list);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const { companyId } = getTenant();
    await CompanySettings.updateOne(
      {},
      {
        $set: {
          "crm.emailTemplates": email.normaliseTemplates(list),
          "crm.emailSignature": String(input.signature || "").slice(0, 1000),
        },
        $setOnInsert: { companyId },
      },
      { upsert: true }
    );
    return this.templates();
  }

  // ---- who it is to, and what fills the template ----------------------------------------------------------------

  /**
   * The addresses a form may offer for whatever this is about, and the values a template can draw on. One read per
   * screen, so the dialog opens with the customer's own people already listed instead of asking for them to be typed.
   */
  static async recipientsFor(regarding = {}) {
    const parent = await ActivityService.parentOf(regarding);
    const [contacts, deal, customer] = await Promise.all([
      parent.customerId
        ? Contact.find({ customerId: new mongoose.Types.ObjectId(String(parent.customerId)) }).select("name email designation isPrimary").limit(50).lean()
        : [],
      parent.kind === "opportunity" ? Opportunity.findById(parent.id).select("title value").lean() : null,
      parent.customerId ? Customer.findById(parent.customerId).select("customerName email").lean() : null,
    ]);

    const people = contacts
      .filter((c) => c.email)
      .map((c) => ({ id: String(c._id), name: c.name || "", email: String(c.email).toLowerCase(), designation: c.designation || "", primary: Boolean(c.isPrimary) }));

    // A lead has not become a customer yet, so its own enquirer is the only address there is.
    if (parent.kind === "lead") {
      const lead = await Lead.findById(parent.id).select("name email company").lean();
      if (lead?.email && !people.some((p) => p.email === String(lead.email).toLowerCase())) {
        people.unshift({ id: `lead:${parent.id}`, name: lead.name || "", email: String(lead.email).toLowerCase(), designation: "", primary: true });
      }
    }
    if (customer?.email && !people.some((p) => p.email === String(customer.email).toLowerCase())) {
      people.push({ id: `customer:${String(customer._id)}`, name: customer.customerName || "", email: String(customer.email).toLowerCase(), designation: "", primary: false });
    }

    return {
      regarding: { kind: parent.kind, id: parent.id, name: parent.name },
      people,
      deal: deal ? { title: deal.title || "", value: deal.value || 0 } : null,
      customer: customer ? { name: customer.customerName || "" } : null,
    };
  }

  /** Everything a template's placeholders can be filled from, for this thing and this sender. */
  static async valuesFor(regarding, sender) {
    const { people, deal, customer } = await this.recipientsFor(regarding);
    const primary = people.find((p) => p.primary) || people[0] || {};
    const profile = await CompanySettings.findOne({}).select("profile.companyName").lean();
    return email.valuesFor({
      contact: { name: primary.name || "" },
      customer: { name: customer?.name || "" },
      deal: deal || {},
      sender: { name: sender?.name || "" },
      company: profile?.profile?.companyName || "",
    });
  }

  // ---- sending ---------------------------------------------------------------------------------------------------

  /**
   * How many emails this organisation has sent in the last day, documents and CRM letters together.
   *
   * They share ONE allowance on purpose. The limit exists so a misconfigured account or a runaway loop cannot send a
   * thousand messages from a customer's domain; a second uncounted door would simply be the way around it.
   */
  static async sentInLastDay(companyId) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [documents, letters] = await Promise.all([
      DocumentSend.countDocuments({ companyId, channel: "email", createdAt: { $gte: since } }),
      CrmActivity.countDocuments({ kind: "email", "email.sentAt": { $gte: since } }),
    ]);
    return documents + letters;
  }

  /**
   * Write to a customer, and record it.
   *
   * The order matters: the message goes out FIRST and the activity is written afterwards, with whatever happened. A
   * record written first and then a send that fails leaves the timeline claiming something the customer never got,
   * which is the one lie a CRM must not tell. A send that worked and a record that failed is the safer way round, is
   * logged loudly, and shows up as nothing on the timeline rather than as a fiction.
   */
  static async send(input = {}, by, req) {
    const errors = email.validateEmail(input);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    // The parent is checked before anything is sent: an email about a deal in another branch is refused here, by the
    // same lookup every other activity goes through, rather than being sent and then failing to be filed.
    const parent = await ActivityService.parentOf(input.regarding);

    const { companyId } = getTenant();
    const settings = await Settings.load(companyId, { withSecrets: true });
    if (!settings.enabled) throw fail("Sending is switched off. Turn it on in Settings, under Sending.", 409, "SENDING_DISABLED");
    if (!settings.fromEmail) throw fail("No sender address is set. Set one in Settings, under Sending.", 409, "SENDER_NOT_SET");

    const used = await this.sentInLastDay(companyId);
    if (used >= settings.dailyLimit) {
      throw fail(`The limit of ${settings.dailyLimit} emails a day has been reached. It frees up as the day passes.`, 429, "SEND_LIMIT_REACHED");
    }

    const sender = { name: req?.admin?.name || "", email: req?.admin?.email || "" };
    const [values, { signature }] = await Promise.all([this.valuesFor(input.regarding, sender), this.templates()]);
    const message = email.buildMessage(input, { values, signature });

    const payload = {
      from: formatFrom(settings.fromName, settings.fromEmail),
      to: message.to,
      cc: message.cc,
      bcc: [],
      // A reply belongs to the person who wrote it, not to the sending address, which usually nobody reads.
      replyTo: sender.email || settings.replyTo || undefined,
      subject: message.subject,
      text: message.body,
      html: email.htmlOf(message.body),
      attachments: [],
      idempotencyKey: `crm-email-${companyId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    };

    const provider = PROVIDERS[settings.provider] || PROVIDERS.console;
    let sent = true;
    let problem = null;
    try {
      await provider.send(payload, { apiKey: Settings.keyOf(settings), ...Settings.optionsOf(settings) });
    } catch (e) {
      sent = false;
      problem = String(e?.message || e).slice(0, 300);
      logger.warn(`[crm] an email could not be sent: ${problem}`);
    }

    const activity = await this.record({ input, parent, message, payload, settings, sent, problem, by, sender });
    return {
      activity: this.present(activity),
      sent,
      // "console" is the default provider and sends nothing. A demo must never read as though a customer was written
      // to, so this is surfaced and the screen says "recorded, not emailed".
      recordedOnly: settings.provider === "console",
      provider: settings.provider,
      error: problem,
    };
  }

  /** The timeline entry: an email is something that happened, so it is DONE the moment it is written. */
  static async record({ input, parent, message, payload, settings, sent, problem, by, sender }) {
    const ownerId = rules.isId(input.ownerId) ? rules.text(input.ownerId, 24) : rules.isId(by) ? String(by) : parent.ownerId || null;
    const [doc] = await CrmActivity.create([
      {
        kind: "email",
        subject: message.subject,
        notes: message.body.slice(0, 2000),
        regarding: { kind: parent.kind, id: new mongoose.Types.ObjectId(parent.id) },
        customerId: parent.customerId || null,
        ownerId,
        ownerName: await CrmSetupService.ownerName(ownerId),
        dueAt: todayInOrg(),
        status: "DONE",
        completedAt: new Date(),
        completedBy: String(by || "system"),
        outcome: "done",
        auto: false,
        createdBy: String(by || "system"),
        companyId: getTenant().companyId,
        email: {
          to: message.to,
          cc: message.cc,
          from: payload.from,
          replyTo: sender.email || "",
          body: message.body,
          templateKey: rules.text(input.templateKey, 40) || null,
          sentAt: sent ? new Date() : null,
          sentBy: String(by || "system"),
          provider: settings.provider,
          error: problem,
        },
      },
    ]);
    await ActivityService.touch(parent.kind, parent.id);
    return doc;
  }

  /** What a screen reads: the activity, plus who it went to and whether it really left the building. */
  static present(doc) {
    const a = ActivityService.present(doc);
    const e = a.email;
    if (!e) return a;
    return {
      ...a,
      email: {
        ...e,
        sent: Boolean(e.sentAt),
        recordedOnly: e.provider === "console",
      },
    };
  }
}

module.exports = CrmEmailService;
