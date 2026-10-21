const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const c = require("../../controllers/crm/crmController");
const multer = require("multer");
const AppError = require("../../utils/AppError");
const AttachmentService = require("../../services/core/attachmentService");

// A file arrives in memory and is validated (extension AND contents) by AttachmentService before anything is stored.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AttachmentService.MAX_BYTES, files: 1 } });
const uploadOne = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    next(err.code === "LIMIT_FILE_SIZE" ? new AppError("File too large (10 MB maximum)", 413, "FILE_TOO_LARGE") : new AppError("Upload failed", 400));
  });

// The CRM, mounted at /api/v1/crm: leads, the pipeline of deals, follow-ups, the report and the automation's own
// settings. Every route is gated on a crm.* permission - the module is sold per organisation, so the plan ceiling
// (middleware/permissionGate.js `refusalFor`) answers MODULE_NOT_IN_PLAN before a role is even considered.
//
// Three id parameters rather than one `:id`, because three kinds of record live under one mount: each is loaded by
// `branchOfDocument` so a head office working across branches acts in the record's own branch.
const router = express.Router();
router.use(authenticateToken);
router.param("leadId", branchOfDocument(Lead));
router.param("oppId", branchOfDocument(Opportunity));
router.param("activityId", branchOfDocument(CrmActivity));

// Fixed paths first: none of these may be read as an id.
router.get("/dashboard", requirePermission("crm.view"), c.dashboard);
router.get("/summary", requirePermission("crm.view"), c.summary);
router.get("/analysis", requirePermission("crm.view"), c.analysis);
// The named reports. Fixed paths, declared with the rest of them: "/reports/..." can never be read as an id.
router.get("/calendar", requirePermission("crm.view"), c.calendar);
router.get("/reports/aging", requirePermission("crm.view"), c.aging);
router.get("/reports/activity", requirePermission("crm.view"), c.activityReport);
// A file is addressed by its own id; the service refuses any id that is not a lead's or a deal's file.
router.get("/attachments/:attachmentId", requirePermission("crm.view"), c.downloadFile);
router.delete("/attachments/:attachmentId", requirePermission("crm.edit"), c.removeFile);
router.get("/pipeline", requirePermission("crm.view"), c.pipeline);
router.get("/owners", requirePermission("crm.view"), c.owners);
router.get("/customers", requirePermission("crm.view"), c.customers);
router.get("/timeline", requirePermission("crm.view"), c.timeline);

router.get("/stages", requirePermission("crm.view"), c.stages);
router.put("/stages", requirePermission("crm.manage"), c.saveStages);
router.get("/settings", requirePermission("crm.view"), c.settings);
router.put("/settings", requirePermission("crm.manage"), c.saveSettings);

// Follow-ups. `/follow-ups/count` is the nav badge and is deliberately its own cheap route.
router.get("/follow-ups", requirePermission("crm.view"), c.listFollowUps);
router.get("/follow-ups/count", requirePermission("crm.view"), c.followUpCount);

// Leads.
router.get("/leads/summary", requirePermission("crm.view"), c.leadSummary);
router.post("/leads/import", requirePermission("crm.create"), c.importLeads);
router.get("/leads/duplicates", requirePermission("crm.view"), c.duplicateCheck);
router.get("/leads", requirePermission("crm.view"), c.listLeads);
router.post("/leads", requirePermission("crm.create"), c.createLead);
router.get("/leads/:leadId", requirePermission("crm.view"), c.getLead);
router.get("/leads/:leadId/activity", requirePermission("crm.view"), c.leadActivity);
router.get("/leads/:leadId/attachments", requirePermission("crm.view"), c.leadFiles.list);
router.post("/leads/:leadId/attachments", requirePermission("crm.edit"), uploadOne, c.leadFiles.add);
router.put("/leads/:leadId", requirePermission("crm.edit"), c.updateLead);
router.delete("/leads/:leadId", requirePermission("crm.delete"), c.removeLead);
router.post("/leads/:leadId/assign", requirePermission("crm.assign"), c.assignLead);
router.post("/leads/:leadId/lose", requirePermission("crm.edit"), c.loseLead);
// Also asks for sales.create inside the controller: it creates a real customer.
router.post("/leads/:leadId/qualify", requirePermission("crm.edit"), c.qualifyLead);

// Deals.
router.get("/opportunities", requirePermission("crm.view"), c.listOpportunities);
router.post("/opportunities", requirePermission("crm.create"), c.createOpportunity);
router.get("/opportunities/:oppId", requirePermission("crm.view"), c.getOpportunity);
router.get("/opportunities/:oppId/activity", requirePermission("crm.view"), c.opportunityActivity);
router.get("/opportunities/:oppId/attachments", requirePermission("crm.view"), c.dealFiles.list);
router.post("/opportunities/:oppId/attachments", requirePermission("crm.edit"), uploadOne, c.dealFiles.add);
router.put("/opportunities/:oppId", requirePermission("crm.edit"), c.updateOpportunity);
router.delete("/opportunities/:oppId", requirePermission("crm.delete"), c.removeOpportunity);
router.post("/opportunities/:oppId/stage", requirePermission("crm.edit"), c.moveOpportunity);
router.post("/opportunities/:oppId/win", requirePermission("crm.edit"), c.winOpportunity);
router.post("/opportunities/:oppId/lose", requirePermission("crm.edit"), c.loseOpportunity);
router.post("/opportunities/:oppId/reopen", requirePermission("crm.edit"), c.reopenOpportunity);
router.post("/opportunities/:oppId/assign", requirePermission("crm.assign"), c.assignOpportunity);

// People. Contact is a MASTER (no branchId), so there is deliberately no branchOfDocument on :contactId - unlike a
// lead or a deal, a person is not owned by one branch and every branch sees the same address book.
// Meetings: an activity with a time, attendees and an invitation. Booking one is adding (crm.create); moving it,
// calling it off, inviting again and recording an answer are all changing one (crm.edit). The fixed path first, so
// "day" is never read as an id.
// A person's own Google account: self-service, so crm.view is enough - connecting your own calendar acts on nobody
// else. Declared before "/meetings/:activityId" so none of these is read as an id.
router.get("/google/status", requirePermission("crm.view"), c.googleStatus);
router.post("/google/start", requirePermission("crm.view"), c.googleStart);
router.post("/google/connect", requirePermission("crm.view"), c.googleConnect);
router.post("/google/disconnect", requirePermission("crm.view"), c.googleDisconnect);

// Email: writing to a customer from the CRM. Sending is adding to the record (crm.create); the organisation's own
// templates are configuration, so saving them is crm.manage, like the stages and the automation settings.
router.get("/email/templates", requirePermission("crm.view"), c.emailTemplates);
router.put("/email/templates", requirePermission("crm.manage"), c.saveEmailTemplates);
router.get("/email/recipients", requirePermission("crm.view"), c.emailRecipients);
router.post("/email/send", requirePermission("crm.create"), c.sendEmail);

router.get("/meetings/day", requirePermission("crm.view"), c.meetingsOnDay);
router.post("/meetings", requirePermission("crm.create"), c.scheduleMeeting);
router.put("/meetings/:activityId", requirePermission("crm.edit"), c.rescheduleMeeting);
router.post("/meetings/:activityId/cancel", requirePermission("crm.edit"), c.cancelMeeting);
router.post("/meetings/:activityId/invite", requirePermission("crm.edit"), c.inviteToMeeting);
router.post("/meetings/:activityId/rsvp", requirePermission("crm.edit"), c.recordRsvp);

router.post("/contacts/import", requirePermission("crm.create"), c.importContacts);
router.get("/contacts", requirePermission("crm.view"), c.listContacts);
router.post("/contacts", requirePermission("crm.create"), c.createContact);
router.get("/contacts/:contactId", requirePermission("crm.view"), c.getContact);
router.put("/contacts/:contactId", requirePermission("crm.edit"), c.updateContact);
router.delete("/contacts/:contactId", requirePermission("crm.delete"), c.removeContact);

// Activities. GET is the communications log (everything that happened); the worklist is /follow-ups above.
router.get("/activities", requirePermission("crm.view"), c.listActivities);
router.post("/activities", requirePermission("crm.create"), c.createActivity);
router.put("/activities/:activityId", requirePermission("crm.edit"), c.updateActivity);
router.post("/activities/:activityId/done", requirePermission("crm.edit"), c.completeActivity);
router.delete("/activities/:activityId", requirePermission("crm.delete"), c.removeActivity);

module.exports = router;
