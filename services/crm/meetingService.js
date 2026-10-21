// Scheduled meetings: booking one, moving it, calling it off.
//
// A meeting IS a CrmActivity of kind "meeting" - not a collection of its own - so it is already on the worklist, the
// calendar, the timeline, the deal and the reports, and `ActivityService` keeps owning the activity half (the parent
// lookup, the `touch` rollups, the timeline). This service owns only what a time adds: the instant, the attendees,
// the invitation and its iCalendar identity.
//
// THE RULE THE REST OF THE CRM DEPENDS ON: `dueAt` is written as the calendar DAY of the start, in the organisation's
// zone. 33 places read `dueAt` as a day; none of them learns that a meeting has a time.
const crypto = require("crypto");
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const Contact = require("../../models/modules/crm/contactModel");
const Admin = require("../../models/core/adminModel");
const rules = require("../../utils/crm");
const meetings = require("../../utils/meetings");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");
const tz = require("../../utils/tz");
const ActivityService = require("./activityService");
const CrmSetupService = require("./crmSetupService");
const MeetingMailer = require("./meetingMailer");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

/** The organisation's own clock: what the organiser sees on the form, and what the meeting is stored against. */
const zoneOf = () => orgLocale.timezone();

/** A new iCalendar identity. Random, not derived from the record, so it can never collide with another organisation's. */
const mintUid = () => `${crypto.randomBytes(12).toString("hex")}@zarvia.crm`;

class MeetingService {
  // ---- reading -----------------------------------------------------------------------------------------------

  /** A meeting as a screen reads it: the activity, plus the time said in words and what may be done to it. */
  static present(doc) {
    const a = ActivityService.present(doc);
    const m = a.meeting;
    if (!m) return a;
    const zone = m.timezone || zoneOf();
    const cancelled = Boolean(m.cancelledAt);
    return {
      ...a,
      meeting: {
        ...m,
        zone,
        time: meetings.timeIn(m.startAt, zone),
        timeRange: meetings.timeRange(m.startAt, m.endAt, zone),
        minutes: meetings.minutesBetween(m.startAt, m.endAt),
        cancelled,
        invited: Boolean(m.invite?.sentAt),
      },
      actions: {
        ...a.actions,
        // A meeting that has happened or been called off is history: it is not moved, and nobody is invited again.
        reschedule: !cancelled && a.status === "OPEN",
        cancelMeeting: !cancelled && a.status === "OPEN",
        invite: !cancelled && a.status === "OPEN" && (m.attendees || []).some((x) => x.email),
      },
    };
  }

  static async load(id, session) {
    const doc = await ActivityService.load(id, session);
    if (doc.kind !== "meeting" || !doc.meeting) throw fail("That is not a meeting", 409, "NOT_A_MEETING");
    return doc;
  }

  /** One day's meetings, in time order: what the calendar's agenda and the clash check both read. */
  static async onDay(day, { ownerId = null } = {}) {
    const zone = zoneOf();
    if (!tz.isRealDay(rules.text(day, 10))) return [];
    const q = { kind: "meeting", "meeting.startAt": { $gte: tz.dayStart(day, zone), $lt: tz.dayEnd(day, zone) } };
    if (rules.isId(ownerId)) q.ownerId = rules.text(ownerId, 24);
    const rows = await CrmActivity.find(q).sort({ "meeting.startAt": 1 }).limit(200).lean();
    return rows.map((r) => MeetingService.present(r));
  }

  // ---- who is invited ------------------------------------------------------------------------------------------

  /**
   * Turn the ids a form sent into attendees with a name and an address, SNAPSHOT at this moment. A contact with no
   * email is kept (the meeting is still theirs) but cannot be written to - the screen says so - and an id that is not
   * ours at all is refused rather than quietly dropped, because a person who ticked somebody expects them invited.
   */
  static async resolveAttendees(list = [], session) {
    const asked = Array.isArray(list) ? list : [];
    const contactIds = asked.filter((a) => a?.kind === "contact" && rules.isId(a.id)).map((a) => rules.text(a.id, 24));
    const userIds = asked.filter((a) => a?.kind === "user" && rules.isId(a.id)).map((a) => rules.text(a.id, 24));

    const [contacts, users] = await Promise.all([
      contactIds.length ? Contact.find({ _id: { $in: contactIds } }).select("name email").session(session || null).lean() : [],
      userIds.length ? Admin.find({ _id: { $in: userIds }, isActive: true, status: "active" }).select("name email").lean() : [],
    ]);
    const byId = new Map([
      ...contacts.map((c) => [String(c._id), { kind: "contact", id: String(c._id), name: c.name || "", email: (c.email || "").toLowerCase() }]),
      ...users.map((u) => [String(u._id), { kind: "user", id: String(u._id), name: u.name || u.email || "", email: (u.email || "").toLowerCase() }]),
    ]);

    const out = [];
    for (const a of asked) {
      const found = byId.get(rules.text(a?.id, 24));
      if (!found) throw fail("One of the people invited could not be found", 400, "MEETING_ATTENDEE_NOT_FOUND");
      if (!out.some((x) => x.id === found.id && x.kind === found.kind)) out.push({ ...found, rsvp: "invited" });
    }
    return out;
  }

  // ---- booking ---------------------------------------------------------------------------------------------------

  /**
   * Book a meeting. The activity is created through ActivityService so the parent is checked, the owner is settled and
   * the rollups run exactly as they do for a call; the meeting half is written on top in the same transaction.
   *
   * The invitation is sent AFTER the transaction commits: it talks to a mail server, which must never be inside a
   * transaction that may be retried, and a meeting that is booked but not yet announced is a meeting, while an
   * invitation to a meeting that was rolled back is a lie.
   */
  static async schedule(input = {}, by, req) {
    const zone = zoneOf();
    const errors = meetings.validateMeeting(input, { zone });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const doc = await MeetingService.write(input, by, zone);
    const result = MeetingService.present(doc);
    const sent = rules.text(input.notify, 10) === "false" || input.notify === false ? null : await MeetingService.invite(doc, by, { note: rules.text(input.note, 500) });
    return { meeting: result, invite: sent, clashes: await MeetingService.clashes(doc) };
  }

  /** The database half of booking, in one transaction. */
  static write = withTransactionSession(async (input, by, zone, session) => {
    const attendees = await MeetingService.resolveAttendees(input.attendees, session);
    const shape = meetings.normaliseMeeting(input, { zone, attendees, uid: mintUid(), sequence: 0 });
    const day = meetings.dayOfMeeting(shape.startAt, zone);

    // ActivityService.create settles the parent, the owner and the rollups; `dueAt` is the meeting's own day.
    const activity = await ActivityService.create(
      { kind: "meeting", subject: input.subject, notes: input.note || input.notes, regarding: input.regarding, dueAt: day, ownerId: input.ownerId },
      by,
      session
    );
    activity.meeting = shape;
    await activity.save({ session });
    return activity;
  });

  /**
   * Move it. The UID stays and the sequence goes up by one, or the attendee's calendar files a SECOND meeting instead
   * of replacing the first - which is the single most common way a home-made invitation goes wrong.
   */
  static async reschedule(id, input = {}, by, req) {
    const zone = zoneOf();
    const errors = meetings.validateMeeting(input, { partial: true, zone });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const doc = await MeetingService.move(id, input, by, zone);
    const sent = input.notify === false ? null : await MeetingService.invite(doc, by, { note: rules.text(input.note, 500) });
    return { meeting: MeetingService.present(doc), invite: sent, clashes: await MeetingService.clashes(doc) };
  }

  static move = withTransactionSession(async (id, input, by, zone, session) => {
    const doc = await MeetingService.load(id, session);
    if (doc.meeting.cancelledAt) throw fail("That meeting has been cancelled", 409, "MEETING_CANCELLED");
    if (doc.status !== "OPEN") throw fail("That meeting is already done", 409, "ACTIVITY_DONE");

    const m = doc.meeting;
    const day = rules.text(input.day, 10) || tz.dayOf(m.startAt, m.timezone || zone);
    const time = meetings.timeOf(input.time) || meetings.timeIn(m.startAt, m.timezone || zone);
    const minutes = input.minutes === undefined ? meetings.minutesBetween(m.startAt, m.endAt) : Math.round(meetings.num(input.minutes));
    const next = meetings.normaliseMeeting(
      {
        day,
        time,
        minutes,
        where: input.where === undefined ? m.where : input.where,
        location: input.location === undefined ? m.location : input.location,
        joinUrl: input.joinUrl === undefined ? m.joinUrl : input.joinUrl,
      },
      { zone, attendees: m.attendees, uid: m.uid, sequence: (m.sequence || 0) + 1 }
    );
    if (input.attendees !== undefined) next.attendees = await MeetingService.resolveAttendees(input.attendees, session);
    if (rules.text(input.subject, 200)) doc.subject = rules.text(input.subject, 200);

    next.invite = m.invite; // what has been sent so far stays on record
    doc.meeting = next;
    doc.dueAt = meetings.dayOfMeeting(next.startAt, zone); // the day follows the meeting, as everything else reads it
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    await ActivityService.touch(doc.regarding.kind, doc.regarding.id, session);
    return doc;
  });

  /** Call it off: the attendees are told, and the activity is cancelled so it leaves the worklist. */
  static async cancel(id, input = {}, by, req) {
    const doc = await MeetingService.off(id, by);
    const sent = input.notify === false ? null : await MeetingService.invite(doc, by, { method: "CANCEL" });
    return { meeting: MeetingService.present(doc), invite: sent };
  }

  static off = withTransactionSession(async (id, by, session) => {
    const doc = await MeetingService.load(id, session);
    if (doc.meeting.cancelledAt) throw fail("That meeting has already been cancelled", 409, "MEETING_CANCELLED");
    doc.meeting.cancelledAt = new Date();
    doc.meeting.sequence = (doc.meeting.sequence || 0) + 1; // a cancellation is a change like any other
    doc.status = "CANCELLED";
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    await ActivityService.touch(doc.regarding.kind, doc.regarding.id, session);
    return doc;
  });

  /** What the customer said, recorded by a person: their Accept goes to the organiser's mailbox, which we do not read. */
  static recordRsvp = withTransactionSession(async (id, input, by, session) => {
    const doc = await MeetingService.load(id, session);
    const answer = meetings.oneOf(input?.rsvp, meetings.RSVP);
    const who = rules.text(input?.attendeeId, 24);
    if (!answer) throw fail("That is not an answer", 400, "MEETING_RSVP_INVALID");
    const attendee = (doc.meeting.attendees || []).find((a) => String(a.id) === who);
    if (!attendee) throw fail("That person is not on this meeting", 404, "MEETING_ATTENDEE_NOT_FOUND");
    attendee.rsvp = answer;
    doc.markModified("meeting.attendees");
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    return doc;
  });

  // ---- the invitation ------------------------------------------------------------------------------------------

  /** Send, and write on the meeting what happened - including that it did not, which the screen shows. */
  static async invite(doc, by, { method = "REQUEST", note = "" } = {}) {
    const organiser = await MeetingService.organiserOf(doc, by);
    const zone = doc.meeting?.timezone || zoneOf();
    const result = await MeetingMailer.send({
      activity: doc,
      organiser,
      note,
      method,
      dayLabel: tz.dayOf(doc.meeting?.startAt, zone),
    });
    const invite = {
      sentAt: result.sent ? new Date() : doc.meeting.invite?.sentAt || null,
      sentBy: result.sent ? String(by || "system") : doc.meeting.invite?.sentBy || null,
      count: (doc.meeting.invite?.count || 0) + (result.sent ? 1 : 0),
      provider: result.provider,
      lastError: result.error,
    };
    // A failed invitation must not undo a booked meeting, so this is written on its own and never throws.
    await CrmActivity.updateOne({ _id: doc._id }, { $set: { "meeting.invite": invite } }).catch(() => {});
    doc.meeting.invite = invite;
    return result;
  }

  /** The person whose mailbox an Accept reply reaches: the meeting's owner, falling back to whoever booked it. */
  static async organiserOf(doc, by) {
    const id = doc.ownerId || (rules.isId(by) ? String(by) : null);
    if (!rules.isId(id)) return { name: doc.ownerName || "", email: "" };
    const person = await Admin.findById(id).select("name email").lean();
    return person ? { name: person.name || person.email || "", email: person.email || "" } : { name: doc.ownerName || "", email: "" };
  }

  /** The organiser's other meetings that overlap. A warning the screen shows, never a refusal. */
  static async clashes(doc) {
    const m = doc?.meeting;
    if (!m?.startAt || !doc.ownerId) return [];
    const zone = m.timezone || zoneOf();
    const day = tz.dayOf(m.startAt, zone);
    const sameDay = await CrmActivity.find({
      kind: "meeting",
      ownerId: doc.ownerId,
      status: "OPEN",
      _id: { $ne: doc._id },
      "meeting.startAt": { $gte: tz.dayStart(day, zone), $lt: tz.dayEnd(day, zone) },
    })
      .select("subject meeting.startAt meeting.endAt meeting.cancelledAt")
      .limit(50)
      .lean();
    return meetings.clashesWith({ id: String(doc._id), startAt: m.startAt, endAt: m.endAt }, sameDay);
  }
}

module.exports = MeetingService;
