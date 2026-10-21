// Thin, like every controller here: one service call, one { success, data } envelope, and the audit row that says who
// did it. The only judgement it makes is the one a route could not make in advance - qualifying a lead creates a real
// customer, so it asks for sales.create at that moment (the ProcessOrderController pattern).
const catchAsync = require("../../utils/catchAsync");
const { assertPermission } = require("../../middleware/permissionGate");
const plans = require("../../utils/plans");
const rules = require("../../utils/crm");
const AuditService = require("../../services/core/auditService");
const LeadService = require("../../services/crm/leadService");
const OpportunityService = require("../../services/crm/opportunityService");
const ActivityService = require("../../services/crm/activityService");
const CrmSetupService = require("../../services/crm/crmSetupService");
const CrmReportService = require("../../services/crm/crmReportService");
const ContactService = require("../../services/crm/contactService");
const CrmAttachmentService = require("../../services/crm/crmAttachmentService");
const MeetingService = require("../../services/crm/meetingService");
const GoogleCalendarService = require("../../services/crm/googleCalendarService");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const log = (req, action, entity, doc, summary, after) =>
  AuditService.log({ req, action, entity, entityId: doc?._id, summary, after });

const leadWords = (l) => `${l.leadNo || "Lead"} (${l.name})`;
const dealWords = (o) => `${o.opportunityNo || "Deal"} (${o.title})`;
const contactWords = (c) => `${c.name}${c.designation ? `, ${c.designation}` : ""}`;

// ---- the module's own screens ---------------------------------------------------------------------------

exports.summary = catchAsync(async (req, res) => ok(res, await CrmReportService.summary()));
exports.analysis = catchAsync(async (req, res) => ok(res, await CrmReportService.analysis(req.query)));
exports.pipeline = catchAsync(async (req, res) => ok(res, await OpportunityService.pipeline(req.query)));
exports.owners = catchAsync(async (req, res) => ok(res, await CrmSetupService.owners()));
exports.customers = catchAsync(async (req, res) => ok(res, await OpportunityService.customerChoices(req.query)));

exports.stages = catchAsync(async (req, res) => ok(res, await CrmSetupService.stages()));
exports.saveStages = catchAsync(async (req, res) => {
  const stages = await CrmSetupService.replaceStages(req.body?.stages, by(req));
  await AuditService.log({
    req, action: "CRM_STAGES_SAVED", entity: "CrmStage", entityId: null,
    summary: `The pipeline is now ${stages.map((s) => s.name).join(" -> ")}`, after: { stages },
  });
  ok(res, stages);
});

exports.settings = catchAsync(async (req, res) => ok(res, await CrmSetupService.settings()));
exports.saveSettings = catchAsync(async (req, res) => {
  const before = await CrmSetupService.settings();
  const settings = await CrmSetupService.saveSettings(req.body, by(req));
  await AuditService.log({
    req, action: "CRM_SETTINGS_SAVED", entity: "CompanySettings", entityId: null,
    summary: "The CRM automation settings were changed", before, after: settings,
  });
  ok(res, settings);
});

// ---- leads ----------------------------------------------------------------------------------------------

exports.listLeads = catchAsync(async (req, res) => ok(res, await LeadService.list(req.query)));
exports.leadSummary = catchAsync(async (req, res) => ok(res, await LeadService.summary()));
exports.duplicateCheck = catchAsync(async (req, res) => ok(res, await LeadService.possibleDuplicates(req.query)));
exports.getLead = catchAsync(async (req, res) => ok(res, await LeadService.getById(req.params.leadId)));
exports.leadActivity = catchAsync(async (req, res) =>
  ok(res, await AuditService.list(req, { entity: "Lead", entityId: req.params.leadId, limit: 100 }))
);

exports.createLead = catchAsync(async (req, res) => {
  const lead = await LeadService.create(req.body, by(req));
  await log(req, "CRM_LEAD_CREATED", "Lead", lead, `${leadWords(lead)} came in${lead.ownerName ? `, given to ${lead.ownerName}` : ""}`, {
    leadNo: lead.leadNo, source: lead.source, ownerName: lead.ownerName, score: lead.score,
  });
  ok(res, LeadService.present(lead), 201);
});

// A spreadsheet of enquiries. Only an explicit `dryRun: false` writes anything: an omitted flag is the preview, so a client
// that forgets it (or a person who replays the request) can never import by accident. The audit row is written for the real
// run only, and carries counts and the file's name - never the rows, which are people's names and numbers.
exports.importLeads = catchAsync(async (req, res) => {
  const b = req.body || {};
  const result = await LeadService.importMany(b.rows, by(req), {
    dryRun: b.dryRun !== false,
    allowDuplicates: b.allowDuplicates === true,
    followUp: b.followUp === true,
  });
  if (!result.dryRun) {
    const s = result.summary;
    await log(req, "CRM_LEADS_IMPORTED", "Lead", null, `${s.created} enquiries were imported${s.duplicate ? `, ${s.duplicate} already held` : ""}${s.invalid + s.failed ? `, ${s.invalid + s.failed} could not be` : ""}`, {
      fileName: rules.text(b.fileName, 120), created: s.created, duplicate: s.duplicate, invalid: s.invalid, failed: s.failed, followUp: b.followUp === true,
    });
  }
  ok(res, result);
});

exports.updateLead = catchAsync(async (req, res) => {
  const lead = await LeadService.update(req.params.leadId, req.body, by(req));
  await log(req, "CRM_LEAD_UPDATED", "Lead", lead, `${leadWords(lead)} was changed`, { status: lead.status, score: lead.score });
  ok(res, LeadService.present(lead));
});

exports.assignLead = catchAsync(async (req, res) => {
  const lead = await LeadService.assign(req.params.leadId, req.body?.ownerId, by(req));
  await log(req, "CRM_LEAD_ASSIGNED", "Lead", lead, `${leadWords(lead)} was given to ${lead.ownerName}`, { ownerName: lead.ownerName });
  ok(res, LeadService.present(lead));
});

exports.loseLead = catchAsync(async (req, res) => {
  const lead = await LeadService.lose(req.params.leadId, req.body, by(req));
  await log(req, "CRM_LEAD_LOST", "Lead", lead, `${leadWords(lead)} came to nothing: ${lead.lostReason}`, { lostReason: lead.lostReason });
  ok(res, LeadService.present(lead));
});

exports.qualifyLead = catchAsync(async (req, res) => {
  // Qualifying makes a real customer, with its own ledger account - a bigger act than editing a lead, and the one
  // place in this module where a Sales permission is asked for: when the organisation bought Sales. One that did not
  // has no Sales key to hold, and asks for the CRM's own (utils/crm.js qualifyPermission).
  assertPermission(req, rules.qualifyPermission(plans.moduleAllows(req.organisation, "sales.create")), "qualifying a lead creates a real customer");
  const { lead, opportunity, customerId } = await LeadService.qualify(req.params.leadId, req.body, by(req));
  await log(req, "CRM_LEAD_QUALIFIED", "Lead", lead, `${leadWords(lead)} became a customer and ${dealWords(opportunity)}`, {
    customerId, opportunityNo: opportunity.opportunityNo,
  });
  ok(res, { lead: LeadService.present(lead), opportunity: OpportunityService.present(opportunity), customerId }, 201);
});

exports.removeLead = catchAsync(async (req, res) => {
  const lead = await LeadService.remove(req.params.leadId, by(req));
  await CrmAttachmentService.removeAll("lead", lead._id, req); // after the record is gone, never inside its transaction
  await log(req, "CRM_LEAD_DELETED", "Lead", lead, `${leadWords(lead)} was deleted`);
  ok(res, { deleted: true });
});

// ---- deals ----------------------------------------------------------------------------------------------

exports.listOpportunities = catchAsync(async (req, res) => ok(res, await OpportunityService.list(req.query)));
exports.getOpportunity = catchAsync(async (req, res) => ok(res, await OpportunityService.getById(req.params.oppId)));
exports.opportunityActivity = catchAsync(async (req, res) =>
  ok(res, await AuditService.list(req, { entity: "Opportunity", entityId: req.params.oppId, limit: 100 }))
);

exports.createOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.create(req.body, by(req));
  await log(req, "CRM_OPPORTUNITY_CREATED", "Opportunity", deal, `${dealWords(deal)} was opened on ${deal.stageName}`, {
    opportunityNo: deal.opportunityNo, value: deal.value, stageName: deal.stageName,
  });
  ok(res, OpportunityService.present(deal), 201);
});

exports.updateOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.update(req.params.oppId, req.body, by(req));
  await log(req, "CRM_OPPORTUNITY_UPDATED", "Opportunity", deal, `${dealWords(deal)} was changed`, { value: deal.value });
  ok(res, OpportunityService.present(deal));
});

exports.moveOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.moveStage(req.params.oppId, req.body, by(req));
  await log(req, "CRM_OPPORTUNITY_MOVED", "Opportunity", deal, `${dealWords(deal)} was moved to ${deal.stageName} by hand`, {
    stageName: deal.stageName, status: deal.status,
  });
  ok(res, OpportunityService.present(deal));
});

exports.winOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.win(req.params.oppId, req.body, by(req));
  await log(req, "CRM_OPPORTUNITY_WON", "Opportunity", deal, `${dealWords(deal)} was won`, { value: deal.value });
  ok(res, OpportunityService.present(deal));
});

exports.loseOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.lose(req.params.oppId, req.body, by(req));
  await log(req, "CRM_OPPORTUNITY_LOST", "Opportunity", deal, `${dealWords(deal)} was lost: ${deal.lostReason}`, { lostReason: deal.lostReason });
  ok(res, OpportunityService.present(deal));
});

exports.reopenOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.reopen(req.params.oppId, by(req));
  await log(req, "CRM_OPPORTUNITY_REOPENED", "Opportunity", deal, `${dealWords(deal)} was reopened on ${deal.stageName}`);
  ok(res, OpportunityService.present(deal));
});

exports.assignOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.assign(req.params.oppId, req.body?.ownerId, by(req));
  await log(req, "CRM_OPPORTUNITY_ASSIGNED", "Opportunity", deal, `${dealWords(deal)} was given to ${deal.ownerName}`, { ownerName: deal.ownerName });
  ok(res, OpportunityService.present(deal));
});

exports.removeOpportunity = catchAsync(async (req, res) => {
  const deal = await OpportunityService.remove(req.params.oppId, by(req));
  await CrmAttachmentService.removeAll("opportunity", deal._id, req);
  await log(req, "CRM_OPPORTUNITY_DELETED", "Opportunity", deal, `${dealWords(deal)} was deleted`);
  ok(res, { deleted: true });
});

// ---- follow-ups ------------------------------------------------------------------------------------------

exports.listFollowUps = catchAsync(async (req, res) => ok(res, await ActivityService.list(req.query, { adminId: req.admin?.id })));
exports.followUpCount = catchAsync(async (req, res) => ok(res, await ActivityService.dueCount({ adminId: req.admin?.id })));
exports.timeline = catchAsync(async (req, res) =>
  ok(res, await ActivityService.timeline({ regardingId: req.query?.regardingId, customerId: req.query?.customerId }))
);

exports.createActivity = catchAsync(async (req, res) => {
  const activity = await ActivityService.create(req.body, by(req));
  await log(req, "CRM_ACTIVITY_CREATED", "CrmActivity", activity, `${activity.kind}: ${activity.subject}`, {
    kind: activity.kind, dueAt: activity.dueAt, ownerName: activity.ownerName,
  });
  ok(res, ActivityService.present(activity), 201);
});

exports.updateActivity = catchAsync(async (req, res) => {
  const activity = await ActivityService.update(req.params.activityId, req.body, by(req));
  await log(req, "CRM_ACTIVITY_UPDATED", "CrmActivity", activity, `${activity.subject} was changed`);
  ok(res, ActivityService.present(activity));
});

exports.completeActivity = catchAsync(async (req, res) => {
  const { activity, next } = await ActivityService.done(req.params.activityId, req.body, by(req));
  await log(req, "CRM_ACTIVITY_DONE", "CrmActivity", activity, `${activity.subject}: ${activity.outcome}`, {
    outcome: activity.outcome, next: next ? next.dueAt : null,
  });
  ok(res, { activity: ActivityService.present(activity), next: next ? ActivityService.present(next) : null });
});

exports.removeActivity = catchAsync(async (req, res) => {
  const activity = await ActivityService.remove(req.params.activityId, by(req));
  await log(req, "CRM_ACTIVITY_DELETED", "CrmActivity", activity, `${activity.subject} was deleted`);
  ok(res, { deleted: true });
});

// ---- the dashboard, the log and the people ---------------------------------------------------------------

exports.calendar = catchAsync(async (req, res) => ok(res, await CrmReportService.calendar(req.query)));
exports.aging = catchAsync(async (req, res) => ok(res, await CrmReportService.aging()));
exports.activityReport = catchAsync(async (req, res) => ok(res, await CrmReportService.activity(req.query)));

exports.dashboard = catchAsync(async (req, res) => ok(res, await CrmReportService.dashboard({ adminId: req.admin?.id })));

// The communications LOG, as against the follow-up worklist at /follow-ups: same rows, read newest-first and with
// everything that ever happened rather than only what is still owed.
exports.listActivities = catchAsync(async (req, res) =>
  ok(res, await ActivityService.list({ status: "all", sort: "recent", ...req.query }, { adminId: req.admin?.id }))
);

exports.listContacts = catchAsync(async (req, res) => ok(res, await ContactService.list(req.query)));
exports.getContact = catchAsync(async (req, res) => ok(res, await ContactService.getById(req.params.contactId)));

// A spreadsheet of people: the same preview-first rule as the enquiries above.
exports.importContacts = catchAsync(async (req, res) => {
  const b = req.body || {};
  const result = await ContactService.importMany(b.rows, by(req), { dryRun: b.dryRun !== false, unmatched: b.unmatched === "skip" ? "skip" : "import" });
  if (!result.dryRun) {
    const s = result.summary;
    await log(req, "CRM_CONTACTS_IMPORTED", "Contact", null, `${s.created} people were imported${s.duplicate ? `, ${s.duplicate} already held` : ""}${s.invalid + s.failed ? `, ${s.invalid + s.failed} could not be` : ""}`, {
      fileName: rules.text(b.fileName, 120), created: s.created, duplicate: s.duplicate, invalid: s.invalid, failed: s.failed,
    });
  }
  ok(res, result);
});

exports.createContact = catchAsync(async (req, res) => {
  const contact = await ContactService.create(req.body, by(req));
  await log(req, "CRM_CONTACT_CREATED", "Contact", contact, `${contactWords(contact)} was added`, {
    name: contact.name, email: contact.email, phone: contact.phone, customerId: contact.customerId, vendorId: contact.vendorId,
  });
  ok(res, ContactService.present(contact), 201);
});

exports.updateContact = catchAsync(async (req, res) => {
  const contact = await ContactService.update(req.params.contactId, req.body, by(req));
  await log(req, "CRM_CONTACT_UPDATED", "Contact", contact, `${contactWords(contact)} was changed`, {
    name: contact.name, email: contact.email, phone: contact.phone, customerId: contact.customerId, vendorId: contact.vendorId,
  });
  ok(res, ContactService.present(contact));
});

exports.removeContact = catchAsync(async (req, res) => {
  const contact = await ContactService.remove(req.params.contactId, by(req));
  await log(req, "CRM_CONTACT_DELETED", "Contact", contact, `${contactWords(contact)} was removed`);
  ok(res, { deleted: true });
});

// ---- meetings ------------------------------------------------------------------------------------------------
//
// A meeting is an activity of kind "meeting" with a time, attendees and an invitation, so these sit beside the
// activity handlers and use the same `:activityId` parameter (and therefore the same branch loading).
//
// The invitation's outcome is reported, never thrown: a meeting that is booked but whose email did not leave is still
// booked, and the screen says which happened.

const meetingWords = (m) => `${m.subject}${m.meeting?.timeRange ? ` at ${m.meeting.timeRange}` : ""}`;

exports.scheduleMeeting = catchAsync(async (req, res) => {
  const out = await MeetingService.schedule(req.body, by(req), req);
  await log(req, "CRM_MEETING_SCHEDULED", "CrmActivity", { _id: out.meeting._id }, `${meetingWords(out.meeting)} was arranged`, {
    startAt: out.meeting.meeting?.startAt, attendees: (out.meeting.meeting?.attendees || []).length, invited: Boolean(out.invite?.sent),
  });
  ok(res, out, 201);
});

exports.rescheduleMeeting = catchAsync(async (req, res) => {
  const out = await MeetingService.reschedule(req.params.activityId, req.body, by(req), req);
  await log(req, "CRM_MEETING_MOVED", "CrmActivity", { _id: out.meeting._id }, `${meetingWords(out.meeting)} was moved`, {
    startAt: out.meeting.meeting?.startAt, told: Boolean(out.invite?.sent),
  });
  ok(res, out);
});

exports.cancelMeeting = catchAsync(async (req, res) => {
  const out = await MeetingService.cancel(req.params.activityId, req.body, by(req), req);
  await log(req, "CRM_MEETING_CANCELLED", "CrmActivity", { _id: out.meeting._id }, `${out.meeting.subject} was called off`, { told: Boolean(out.invite?.sent) });
  ok(res, out);
});

// Sending the invitation again: after setting the email up, or because somebody lost it.
exports.inviteToMeeting = catchAsync(async (req, res) => {
  const doc = await MeetingService.load(req.params.activityId);
  const sent = await MeetingService.invite(doc, by(req), { note: rules.text(req.body?.note, 500) });
  await log(req, "CRM_MEETING_INVITED", "CrmActivity", doc, `The invitation to ${doc.subject} was sent again`, { sent: Boolean(sent.sent), to: (sent.to || []).length });
  ok(res, { meeting: MeetingService.present(doc), invite: sent });
});

// What the customer said. Their Accept arrives in the organiser's own mailbox, which we do not read, so a person
// records it here rather than the system inventing an answer from silence.
exports.recordRsvp = catchAsync(async (req, res) => {
  const doc = await MeetingService.recordRsvp(req.params.activityId, req.body, by(req));
  ok(res, MeetingService.present(doc));
});

// ---- a person's own Google account ---------------------------------------------------------------------------
//
// Each person connects their OWN account: the Meet link is minted by it and the event lands in their own diary. So
// these are self-service - they act on the signed-in person and take no id - and `crm.view` is enough, because
// connecting your own calendar is not an act upon anybody else.
//
// Google redirects the BROWSER back, and this app signs requests with a token held in the tab rather than a cookie,
// so the address Google returns to is a page of the app; that page hands the code here with its own token.

exports.googleStatus = catchAsync(async (req, res) => ok(res, await GoogleCalendarService.status(by(req))));

exports.googleStart = catchAsync(async (req, res) => ok(res, { url: GoogleCalendarService.startUrl(by(req), { email: req.admin?.email }) }));

exports.googleConnect = catchAsync(async (req, res) => {
  const status = await GoogleCalendarService.connect({ code: req.body?.code, state: req.body?.state, adminId: by(req) });
  await log(req, "CRM_GOOGLE_CONNECTED", "Admin", { _id: req.admin?.id }, `A Google account was connected for meetings${status.email ? ` (${status.email})` : ""}`, { email: status.email });
  ok(res, status);
});

exports.googleDisconnect = catchAsync(async (req, res) => {
  await GoogleCalendarService.disconnect(by(req));
  await log(req, "CRM_GOOGLE_DISCONNECTED", "Admin", { _id: req.admin?.id }, "The Google account was disconnected from meetings");
  ok(res, await GoogleCalendarService.status(by(req)));
});

exports.meetingsOnDay = catchAsync(async (req, res) => ok(res, await MeetingService.onDay(req.query.day, { ownerId: req.query.ownerId })));

// ---- files on a lead or a deal -------------------------------------------------------------------------------
//
// The same four handlers for both kinds of record, which differ only in the id parameter and the words in the audit row.
// The download is piped from here with nosniff and an attachment disposition, exactly as the accounting attachments are:
// the browser saves the file, it never interprets it.

const FILES = { lead: { param: "leadId", entity: "Lead" }, opportunity: { param: "oppId", entity: "Opportunity" } };

const filesOf = (kind) => ({
  list: catchAsync(async (req, res) => ok(res, await CrmAttachmentService.list(kind, req.params[FILES[kind].param], req))),
  add: catchAsync(async (req, res) => {
    const file = await CrmAttachmentService.add(kind, req.params[FILES[kind].param], req.file, { by: by(req), label: req.body?.label, req });
    await log(req, "CRM_ATTACHMENT_ADDED", FILES[kind].entity, { _id: req.params[FILES[kind].param] }, `${file.fileName} was attached`, { fileName: file.fileName, fileSize: file.fileSize });
    ok(res, file, 201);
  }),
});
exports.leadFiles = filesOf("lead");
exports.dealFiles = filesOf("opportunity");

exports.downloadFile = catchAsync(async (req, res) => {
  const { attachment: a, stream } = await CrmAttachmentService.open(req.params.attachmentId, req);
  res.setHeader("Content-Type", a.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.originalName)}`);
  stream.pipe(res);
});

exports.removeFile = catchAsync(async (req, res) => {
  const gone = await CrmAttachmentService.remove(req.params.attachmentId, req);
  await log(req, "CRM_ATTACHMENT_REMOVED", FILES[gone.ownerType].entity, { _id: gone.ownerId }, `${gone.fileName} was removed`, { fileName: gone.fileName });
  ok(res, { deleted: true });
});
