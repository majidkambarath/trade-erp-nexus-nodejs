// Thin, like every controller here: one service call, one { success, data } envelope, and the audit row that says who
// did it. The only judgement it makes is the one a route could not make in advance - qualifying a lead creates a real
// customer, so it asks for sales.create at that moment (the ProcessOrderController pattern).
const catchAsync = require("../../utils/catchAsync");
const { assertPermission } = require("../../middleware/permissionGate");
const AuditService = require("../../services/core/auditService");
const LeadService = require("../../services/crm/leadService");
const OpportunityService = require("../../services/crm/opportunityService");
const ActivityService = require("../../services/crm/activityService");
const CrmSetupService = require("../../services/crm/crmSetupService");
const CrmReportService = require("../../services/crm/crmReportService");
const ContactService = require("../../services/crm/contactService");

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
  // place in this module where a Sales permission is required.
  assertPermission(req, "sales.create", "qualifying a lead creates a real customer");
  const { lead, opportunity, customerId } = await LeadService.qualify(req.params.leadId, req.body, by(req));
  await log(req, "CRM_LEAD_QUALIFIED", "Lead", lead, `${leadWords(lead)} became a customer and ${dealWords(opportunity)}`, {
    customerId, opportunityNo: opportunity.opportunityNo,
  });
  ok(res, { lead: LeadService.present(lead), opportunity: OpportunityService.present(opportunity), customerId }, 201);
});

exports.removeLead = catchAsync(async (req, res) => {
  const lead = await LeadService.remove(req.params.leadId, by(req));
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
