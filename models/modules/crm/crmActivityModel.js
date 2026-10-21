// A call, a visit, a meeting, a message or a note: the contact itself, and - when it is still open - the next action
// somebody owes. This is what the follow-up worklist and the notification feed read.
//
// Named CrmActivity, not Activity, because `ActivityLog` is already the audit trail (models/modules/financial/
// activityLogModel.js). That one records what the SYSTEM was told to do; this one records what a person did with a
// customer. They are never mixed.
//
// `dedupeKey` is how an automatic follow-up is created at most once per stage entry: the automation sets it, a person
// never does, and the unique index (per organisation, via the plugin) makes a replay a no-op instead of a second
// reminder. The shape is borrowed from models/core/notificationModel.js, but the writer is a conditional upsert in one
// session, not a find-then-create.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const crm = require("../../../utils/crm");
const meetings = require("../../../utils/meetings");

// Somebody invited to a meeting: a contact (the customer's side) or a colleague (ours). The name and the email are a
// SNAPSHOT taken when the invitation went out - a contact who later changes their address does not silently rewrite
// what we sent, and an attendee whose record is deleted still shows on the meeting that happened.
const attendeeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: meetings.ATTENDEE_KINDS, required: true },
    id: { type: String, required: true },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    // The customer's answer arrives by email in the ORGANISER's own mailbox, which we do not read, so this is recorded
    // by a person. It is never guessed from silence.
    rsvp: { type: String, enum: meetings.RSVP, default: "invited" },
  },
  { _id: false }
);

// A scheduled meeting. Absent on every other kind of activity - no default, the pattern `closedShort` uses - so a call
// or a note is exactly the document it was before this existed.
const meetingSchema = new mongoose.Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, required: true }, // the zone it was booked in: what the organiser saw on the form
    where: { type: String, enum: meetings.WHERE, default: "online" },
    location: { type: String, trim: true, maxlength: 300, default: "" },
    joinUrl: { type: String, trim: true, maxlength: 500, default: "" },

    // The iCalendar identity. `uid` is minted once and NEVER changes; every change raises `sequence`. Send a changed
    // meeting with a new uid and the attendee's calendar keeps the old one and adds a second.
    uid: { type: String, required: true },
    sequence: { type: Number, default: 0, min: 0 },

    attendees: { type: [attendeeSchema], default: [] },
    invite: {
      sentAt: { type: Date, default: null },
      sentBy: { type: String, default: null },
      count: { type: Number, default: 0, min: 0 }, // how many invitations have gone out, the first and every change
      provider: { type: String, default: null }, // which account sent it; "console" means nothing left the building
      lastError: { type: String, default: null },
    },
    cancelledAt: { type: Date, default: null },
  },
  { _id: false }
);

const crmActivitySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: crm.ACTIVITY_KINDS, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },

    // What it is about. One shape for all three so a timeline can be assembled with one query per screen.
    regarding: {
      kind: { type: String, enum: crm.REGARDING_KINDS, required: true },
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
    },
    // Kept beside `regarding` so the customer's own CRM tab needs no join through the deal.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    ownerId: { type: String, default: null },
    ownerName: { type: String, trim: true, default: "" },

    dueAt: { type: String, default: null }, // a day, "YYYY-MM-DD", in the organisation's zone
    status: { type: String, enum: crm.ACTIVITY_STATUS, default: "OPEN" },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    outcome: { type: String, enum: [...crm.OUTCOMES, null], default: null },

    // Set only on a meeting (kind "meeting"); `dueAt` above stays the DAY it falls on, so everything that reads a day -
    // the worklist, the board, overdue, aging, the reports, the calendar - is untouched by a meeting having a time.
    meeting: { type: meetingSchema, default: undefined },

    auto: { type: Boolean, default: false }, // the automation left it, not a person
    dedupeKey: { type: String, default: null },

    createdBy: { type: String, default: "system" },
    updatedBy: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

crmActivitySchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
crmActivitySchema.index({ "regarding.id": 1, status: 1, dueAt: 1 });
crmActivitySchema.index({ ownerId: 1, status: 1, dueAt: 1 });
crmActivitySchema.index({ status: 1, dueAt: 1 });
crmActivitySchema.index({ customerId: 1, createdAt: -1 });
crmActivitySchema.index({ createdAt: -1 });
// The day's meetings in order, and the reminder pass ("what starts in the next few minutes").
crmActivitySchema.index({ "meeting.startAt": 1, status: 1 });

crmActivitySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.CrmActivity || mongoose.model("CrmActivity", crmActivitySchema);
