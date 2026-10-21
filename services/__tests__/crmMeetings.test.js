// Scheduled meetings over HTTP against a strict server with real sign-ins.
//
// The two things that would hurt a customer are tested hardest: the TIME (a meeting booked at 14:30 in Dubai must be
// 14:30 in Dubai, and its `dueAt` day must be the organisation's day, not UTC's) and the INVITATION (the same UID with
// a higher sequence on a change, a CANCEL when it is called off). The `console` provider records what would have been
// sent, so the exact bytes can be read back without a mail account.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";

let child, M, Org, ctx, meetings;
let logs = "";
const T = {};
const S = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (fn, company = "meet") => ctx.runWithTenant({ companyId: company, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

async function person(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key, rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@meet.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@meet.test` }, { $set: { mustChangePassword: false } }));
  T[key] = await login(`${key}@meet.test`);
  assert.ok(T[key], `${key} signs in`);
}

/** The .ics the console provider would have sent, read from the activity plus the builder - the same bytes. */
const icsOf = async (id, method = "REQUEST") => {
  const doc = await as(() => M.CrmActivity.findById(id).lean());
  return meetings.buildIcs({
    uid: doc.meeting.uid, sequence: doc.meeting.sequence, method,
    start: doc.meeting.startAt, end: doc.meeting.endAt, subject: doc.subject,
    // the same fields the mailer passes, so this is the file the attendee would receive
    location: doc.meeting.location, joinUrl: doc.meeting.joinUrl,
    organiser: { name: "x", email: "x@meet.test" }, attendees: doc.meeting.attendees,
  });
};

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
    Lead: require("../../models/modules/crm/leadModel"),
    Contact: require("../../models/modules/crm/contactModel"),
    CrmActivity: require("../../models/modules/crm/crmActivityModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  meetings = require("../../utils/meetings");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const h = await fetch(`${BASE}/health`);
      if (h.ok && (await h.json()).ready !== false) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("an organisation in Dubai, a lead, and the people who will use this", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Meet Works", code: "meet", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "Asif Rahman", email: "owner@meet.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@meet.test");
  assert.ok(T.owner);

  await person("looker", ["crm.view"]);
  await person("chaser", ["crm.view", "crm.create", "crm.edit"]);

  const lead = await api("owner", "POST", "/crm/leads", { name: "Hassan Al Noor", company: "Al Noor Foods", phone: "0501234567", email: "hassan@alnoor.test" });
  assert.equal(lead.status, 201, JSON.stringify(lead.data));
  S.lead = lead.body._id;

  // somebody to invite: a contact of the customer's side, and a colleague of ours
  const contact = await api("owner", "POST", "/crm/contacts", { name: "Hassan Al Noor", email: "hassan@alnoor.test", phone: "0501234567" });
  assert.equal(contact.status, 201, JSON.stringify(contact.data));
  S.contact = contact.body._id;
  S.colleague = (await api("owner", "GET", "/crm/owners")).body.find((o) => o.name === "chaser").id;
  S.noGoogleOwner = (await api("owner", "GET", "/crm/owners")).body.find((o) => o.name === "looker").id;
});

const booking = (over = {}) => ({
  subject: "Price review for 200 bags",
  regarding: { kind: "lead", id: S.lead },
  day: "2026-11-03",
  time: "14:30",
  minutes: 30,
  where: "online",
  joinUrl: "https://meet.example.com/abc-defg-hij",
  attendees: [{ kind: "contact", id: S.contact }, { kind: "user", id: S.colleague }],
  ...over,
});

test("a meeting is booked at the time the organisation's clock reads, and its day is the organisation's day", { skip }, async () => {
  const made = await api("chaser", "POST", "/crm/meetings", booking());
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.meeting = made.body.meeting._id;

  const m = made.body.meeting.meeting;
  assert.equal(new Date(m.startAt).toISOString(), "2026-11-03T10:30:00.000Z", "14:30 in Dubai is 10:30Z");
  assert.equal(new Date(m.endAt).toISOString(), "2026-11-03T11:00:00.000Z");
  assert.equal(m.timezone, "Asia/Dubai");
  assert.equal(m.timeRange, "14:30 - 15:00", "said back on the organisation's clock");
  assert.equal(m.sequence, 0);
  assert.ok(m.uid, "it has a calendar identity from the first moment");
  assert.equal(m.attendees.length, 2);
  assert.equal(made.body.meeting.kind, "meeting");

  const stored = await as(() => M.CrmActivity.findById(S.meeting).lean());
  assert.equal(stored.dueAt, "2026-11-03", "the DAY is what the rest of the CRM reads, and it is the organisation's");
  assert.equal(stored.status, "OPEN");
});

test("a meeting late at night is filed on the organisation's day, not UTC's previous one", { skip }, async () => {
  // 02:00 in Dubai is 22:00 the day before in UTC: a day taken from the instant would be wrong by one.
  const made = await api("chaser", "POST", "/crm/meetings", booking({ subject: "Early call with Singapore", day: "2026-11-05", time: "02:00" }));
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const stored = await as(() => M.CrmActivity.findById(made.body.meeting._id).lean());
  assert.equal(new Date(stored.meeting.startAt).toISOString(), "2026-11-04T22:00:00.000Z");
  assert.equal(stored.dueAt, "2026-11-05", "the day a person would say it is on");
  S.nightMeeting = made.body.meeting._id;
});

test("everything that reads a day still reads this meeting, knowing nothing about times", { skip }, async () => {
  // The worklist, the calendar and the timeline are all `dueAt` readers. None of them was changed for meetings.
  const work = await api("chaser", "GET", "/crm/follow-ups?view=all");
  assert.equal(work.status, 200, JSON.stringify(work.data));
  assert.ok(work.body.some((a) => String(a._id) === String(S.meeting)), "it is on the worklist like any other follow-up");

  const cal = await api("chaser", "GET", "/crm/calendar?from=2026-11-01&to=2026-11-30");
  assert.equal(cal.status, 200);
  const entry = cal.body.items.find((i) => i.id === String(S.meeting));
  assert.ok(entry, "and on the calendar");
  assert.equal(entry.day, "2026-11-03");
  assert.equal(entry.kind, "meeting");

  const lead = await api("chaser", "GET", `/crm/leads/${S.lead}`);
  assert.ok(lead.body.timeline.some((t) => String(t._id) === String(S.meeting)), "and on the lead's own story");
});

test("the invitation is a real calendar request, addressed to everybody on it", { skip }, async () => {
  const ics = await icsOf(S.meeting);
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /DTSTART:20261103T103000Z/, "UTC, so the customer's own calendar converts it");
  assert.match(ics, /SEQUENCE:0/);
  assert.match(ics.replace(/\r\n /g, ""), /ATTENDEE;[^\r]*RSVP=TRUE;CN=Hassan Al Noor:mailto:hassan@alnoor\.test/);
  assert.match(ics.replace(/\r\n /g, ""), /LOCATION:https:\/\/meet\.example\.com\/abc-defg-hij/);

  // The console provider is the default: it records and sends nothing, and the meeting says so rather than claiming
  // an email went out.
  const stored = await as(() => M.CrmActivity.findById(S.meeting).lean());
  assert.equal(stored.meeting.invite.provider, "console");
});

test("moving a meeting keeps its identity and raises its sequence, or the customer gets a second one", { skip }, async () => {
  const moved = await api("chaser", "PUT", `/crm/meetings/${S.meeting}`, { day: "2026-11-04", time: "09:00" });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const m = moved.body.meeting.meeting;
  assert.equal(new Date(m.startAt).toISOString(), "2026-11-04T05:00:00.000Z", "09:00 in Dubai");
  assert.equal(m.timeRange, "09:00 - 09:30", "the length is kept when only the time moves");
  assert.equal(m.sequence, 1, "a higher sequence, or the change is ignored by the calendar");

  const before = await as(() => M.CrmActivity.findById(S.meeting).lean());
  assert.equal(before.dueAt, "2026-11-04", "and the day moved with it");

  const ics = await icsOf(S.meeting);
  assert.equal((ics.match(/UID:(.+)/) || [])[1], m.uid, "the same UID");
  assert.match(ics, /SEQUENCE:1/);
});

test("a meeting can be made longer, moved to a room, and given a link later", { skip }, async () => {
  const out = await api("chaser", "PUT", `/crm/meetings/${S.meeting}`, { minutes: 90, where: "in_person", location: "Deira office" });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.body.meeting.meeting.minutes, 90);
  assert.equal(out.body.meeting.meeting.where, "in_person");
  assert.equal(out.body.meeting.meeting.joinUrl, "", "a room has no web address");
  assert.equal(out.body.meeting.meeting.sequence, 2);
});

test("a clash with the organiser's own day is a warning, never a refusal", { skip }, async () => {
  const first = await api("chaser", "POST", "/crm/meetings", booking({ subject: "Morning one", day: "2026-12-01", time: "10:00", minutes: 60 }));
  assert.equal(first.status, 201);
  const overlapping = await api("chaser", "POST", "/crm/meetings", booking({ subject: "Morning two", day: "2026-12-01", time: "10:30", minutes: 60 }));
  assert.equal(overlapping.status, 201, "it is still booked");
  assert.equal(overlapping.body.clashes.length, 1, "and the person is told");
  assert.equal(overlapping.body.clashes[0].subject, "Morning one");

  const after = await api("chaser", "POST", "/crm/meetings", booking({ subject: "Afternoon", day: "2026-12-01", time: "11:30", minutes: 30 }));
  assert.deepEqual(after.body.clashes, [], "a meeting that starts as another ends does not clash");
});

test("calling it off tells the calendar to remove it, and takes it off the worklist", { skip }, async () => {
  const off = await api("chaser", "POST", `/crm/meetings/${S.meeting}/cancel`, {});
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.body.meeting.meeting.cancelled, true);
  assert.equal(off.body.meeting.status, "CANCELLED");

  const ics = await icsOf(S.meeting, "CANCEL");
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /SEQUENCE:3/, "a cancellation is a change like any other");

  const cal = await api("chaser", "GET", "/crm/calendar?from=2026-11-01&to=2026-11-30");
  assert.ok(!cal.body.items.some((i) => i.id === String(S.meeting)), "a cancelled meeting leaves the calendar");

  assert.equal((await api("chaser", "POST", `/crm/meetings/${S.meeting}/cancel`, {})).code, "MEETING_CANCELLED", "twice is refused");
  assert.equal((await api("chaser", "PUT", `/crm/meetings/${S.meeting}`, { time: "10:00" })).code, "MEETING_CANCELLED", "and it cannot be moved afterwards");
});

test("the answer a person records is kept against the attendee who gave it", { skip }, async () => {
  const made = await api("chaser", "POST", "/crm/meetings", booking({ subject: "RSVP test", day: "2026-12-05", time: "10:00" }));
  const id = made.body.meeting._id;
  const out = await api("chaser", "POST", `/crm/meetings/${id}/rsvp`, { attendeeId: S.contact, rsvp: "accepted" });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const them = out.body.meeting.attendees.find((a) => a.id === String(S.contact));
  assert.equal(them.rsvp, "accepted");
  assert.equal(out.body.meeting.attendees.find((a) => a.id === String(S.colleague)).rsvp, "invited", "nobody else is answered for");
  assert.equal((await api("chaser", "POST", `/crm/meetings/${id}/rsvp`, { attendeeId: S.contact, rsvp: "maybe not" })).code, "MEETING_RSVP_INVALID");
});

test("a day's meetings come back in time order", { skip }, async () => {
  const day = await api("looker", "GET", "/crm/meetings/day?day=2026-12-01");
  assert.equal(day.status, 200, JSON.stringify(day.data));
  assert.deepEqual(day.body.map((d) => d.meeting.time), ["10:00", "10:30", "11:30"]);
});

test("who may book, move and look", { skip }, async () => {
  const refused = await api("looker", "POST", "/crm/meetings", booking({ subject: "Not mine" }));
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.details.required, ["crm.create"]);
  assert.equal((await api("looker", "PUT", `/crm/meetings/${S.nightMeeting}`, { time: "03:00" })).status, 403);
  assert.equal((await api("looker", "POST", `/crm/meetings/${S.nightMeeting}/cancel`, {})).status, 403);
  assert.equal((await api("looker", "GET", "/crm/meetings/day?day=2026-12-01")).status, 200, "but anyone in the CRM may look");
});

test("a bad booking is refused cleanly, and hostile input never reaches a field", { skip }, async () => {
  const cases = [
    [booking({ time: "25:00" }), "MEETING_TIME_INVALID"],
    [booking({ day: "2026-02-30" }), "MEETING_DAY_INVALID"],
    [booking({ minutes: 2 }), "MEETING_TOO_SHORT"],
    [booking({ joinUrl: "javascript:alert(1)" }), "MEETING_LINK_INVALID"],
    [booking({ attendees: [] }), "MEETING_ATTENDEES_REQUIRED"],
    [booking({ subject: "" }), "MEETING_SUBJECT_REQUIRED"],
    [booking({ attendees: [{ kind: "contact", id: "64b64b64b64b64b64b64b64b" }] }), "MEETING_ATTENDEE_NOT_FOUND"],
  ];
  for (const [body, code] of cases) {
    const r = await api("chaser", "POST", "/crm/meetings", body);
    assert.equal(r.status >= 400 && r.status < 500, true, `${code}: ${r.status}`);
    assert.equal(r.code, code, JSON.stringify(r.data)?.slice(0, 160));
  }
  const hostile = await api("chaser", "POST", "/crm/meetings", { subject: { $ne: "x" }, day: ["2026-11-03"], time: {}, attendees: "everybody", regarding: { kind: "lead", id: S.lead } });
  assert.equal(hostile.status, 400);
  assert.equal(await as(() => M.CrmActivity.countDocuments({ kind: "meeting", subject: "" })), 0, "and nothing was written");
});

test("a meeting booked before this existed, with only a day, still works", { skip }, async () => {
  // What the CRM has written since the module shipped: kind "meeting", a day, and no meeting block at all.
  const [old] = await as(() =>
    M.CrmActivity.create([{ kind: "meeting", subject: "Old style meeting", regarding: { kind: "lead", id: S.lead }, dueAt: "2026-11-10", status: "OPEN", companyId: "meet", branchId: "main" }])
  );
  const cal = await api("chaser", "GET", "/crm/calendar?from=2026-11-01&to=2026-11-30");
  const entry = cal.body.items.find((i) => i.id === String(old._id));
  assert.ok(entry, "it is still on the calendar");
  assert.equal(entry.day, "2026-11-10");
  const list = await api("chaser", "GET", "/crm/follow-ups?view=all");
  assert.ok(list.body.some((a) => String(a._id) === String(old._id)), "and still on the worklist");
  assert.equal((await api("chaser", "PUT", `/crm/meetings/${old._id}`, { time: "10:00" })).code, "NOT_A_MEETING", "but it is not one this can move");
});

// ---- Google -------------------------------------------------------------------------------------------------
//
// The connection itself is proved in googleCalendar.test.js with the network replaced. What matters HERE is that a
// meeting survives whatever Google does: the link is taken when it comes, and the booking stands when it does not.

// These three call the service IN THIS PROCESS, not over HTTP. The server under test is a separate process holding
// the real Google client, so a stub installed here could never reach it; the HTTP route is covered by the case below
// and the connection itself by googleCalendar.test.js.

/** Replace Google for one test, and always put it back. */
async function withGoogle(answer, fn) {
  const Google = require("../crm/googleCalendarService");
  const previous = Google._http;
  const calls = [];
  Google.useHttp(async (url, options) => {
    calls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      return { ok: true, status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events" } };
    }
    return typeof answer === "function" ? answer(url, options) : answer;
  });
  try {
    return await fn(calls);
  } finally {
    Google.useHttp(previous);
  }
}

/** The owner these use, with a connection written straight in: connecting is proved in googleCalendar.test.js. */
async function connectedOwner() {
  const GoogleAccount = require("../../models/modules/crm/googleAccountModel");
  const { encrypt } = require("../../utils/secretBox");
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.PUBLIC_APP_URL = "https://app.test";
  const admin = await as(() => M.Admin.findOne({ email: "chaser@meet.test" }).lean());
  await as(() =>
    GoogleAccount.updateOne(
      { adminId: String(admin._id) },
      { $set: { adminId: String(admin._id), email: "chaser@gmail.test", accessTokenEnc: encrypt("at"), refreshTokenEnc: encrypt("rt"), expiresAt: new Date(Date.now() + 3600000), connectedAt: new Date(), revokedAt: null, lastError: null }, $setOnInsert: { companyId: "meet" } },
      { upsert: true }
    )
  );
  return String(admin._id);
}

const schedule = (owner, over = {}) => {
  const MeetingService = require("../crm/meetingService");
  return as(() =>
    MeetingService.schedule(
      { subject: "Google meeting", regarding: { kind: "lead", id: S.lead }, day: "2026-12-10", time: "10:00", minutes: 30, where: "online", joinUrl: "", attendees: [{ kind: "contact", id: S.contact }], ownerId: owner, notify: false, googleMeet: true, ...over },
      owner
    )
  );
};

test("a Meet link Google makes is put on the meeting, and the event is remembered", { skip }, async () => {
  const owner = await connectedOwner();
  const out = await withGoogle({ ok: true, status: 200, body: { id: "ev-9", htmlLink: "https://calendar.google.com/x", hangoutLink: "https://meet.google.com/zzz-yyyy-xxx" } }, (calls) =>
    schedule(owner).then((r) => ({ r, calls }))
  );
  assert.equal(out.r.google.ok, true, JSON.stringify(out.r.google));
  assert.equal(out.r.google.meetLink, "https://meet.google.com/zzz-yyyy-xxx");
  assert.ok(out.calls.some((u) => u.includes("conferenceDataVersion=1")), "without this Google returns no link at all");

  const stored = await as(() => M.CrmActivity.findById(out.r.meeting._id).lean());
  assert.equal(stored.meeting.joinUrl, "https://meet.google.com/zzz-yyyy-xxx", "the link Google made is the meeting's link");
  assert.equal(stored.meeting.google.eventId, "ev-9");
  assert.equal(String(stored.meeting.google.connectedAs), owner, "whose calendar it is in");
});

test("a link the person typed is kept, even when Google offers one", { skip }, async () => {
  const owner = await connectedOwner();
  const out = await withGoogle({ ok: true, status: 200, body: { id: "ev-10", hangoutLink: "https://meet.google.com/google-made" } }, () =>
    schedule(owner, { day: "2026-12-11", joinUrl: "https://zoom.example.com/mine" })
  );
  assert.equal(out.google.ok, true);
  const stored = await as(() => M.CrmActivity.findById(out.meeting._id).lean());
  assert.equal(stored.meeting.joinUrl, "https://zoom.example.com/mine", "the person's deliberate choice wins");
  assert.equal(stored.meeting.google.eventId, "ev-10", "and the event is still in their diary");
});

test("Google refusing the link never loses the meeting", { skip }, async () => {
  const owner = await connectedOwner();
  const out = await withGoogle({ ok: false, status: 503, body: { error: { message: "Backend error" } } }, () => schedule(owner, { day: "2026-12-12" }));
  assert.equal(out.google.ok, false);
  assert.match(out.google.error, /could not be reached/i);
  const stored = await as(() => M.CrmActivity.findById(out.meeting._id).lean());
  assert.ok(stored, "the meeting exists");
  assert.equal(stored.meeting.joinUrl, "", "with no link, which the screen says");
  assert.ok(!stored.meeting.google?.eventId, "and nothing pretending to be a Google event");
});

test("over HTTP, asking for a Meet link where Google is not set up still arranges the meeting", { skip }, async () => {
  // The server under test has no Google app configured, which is the state of most installations: asking for a
  // link must be answered honestly and must not cost anybody their booking.
  const made = await api("chaser", "POST", "/crm/meetings", booking({ subject: "Nobody connected", day: "2026-12-13", time: "10:00", joinUrl: "", googleMeet: true, ownerId: S.noGoogleOwner }));
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.body.google.ok, false);
  assert.match(made.body.google.error, /not connected/i);
});

test("the trail says what was arranged, moved and called off", { skip }, async () => {
  const rows = await as(() => M.ActivityLog.find({ action: /^CRM_MEETING_/ }).sort({ at: 1 }).lean());
  const actions = rows.map((r) => r.action);
  for (const a of ["CRM_MEETING_SCHEDULED", "CRM_MEETING_MOVED", "CRM_MEETING_CANCELLED"]) assert.ok(actions.includes(a), `${a}: ${actions.join(", ")}`);
  assert.match(rows.find((r) => r.action === "CRM_MEETING_SCHEDULED").summary, /was arranged/);
});
