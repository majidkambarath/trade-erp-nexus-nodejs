// Connecting a Google account and making a Meet link, with the one function that reaches the network replaced.
//
// There is no Google account on this machine, so this proves everything EXCEPT the real round trip: the exact requests
// that would leave, the token being refreshed and kept, the failures being read correctly, and - the part that matters
// most to a person - that none of it can lose a meeting that was already booked.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ADMIN = "a".repeat(24);

let GoogleAccount, Google, ctx;
const as = (fn) => ctx.runWithTenant({ companyId: "goog", branchId: "main" }, fn);

/** A fake Google: every call is recorded, and the answers are whatever the test queued. */
function fakeGoogle() {
  const calls = [];
  const queue = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body });
    const next = queue.shift();
    if (!next) return { ok: true, status: 200, body: {} };
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    answer: (body, { ok = true, status = 200 } = {}) => queue.push({ ok, status, body }),
    fn,
    find: (part) => calls.find((c) => c.url.includes(part)),
    form: (part) => Object.fromEntries(new URLSearchParams(calls.find((c) => c.url.includes(part)).body)),
    // the LAST matching call: the token endpoint is hit once to connect and again to refresh
    lastForm: (part) => Object.fromEntries(new URLSearchParams([...calls].reverse().find((c) => c.url.includes(part)).body)),
    json: (part) => JSON.parse(calls.find((c) => c.url.includes(part)).body),
  };
}

const TOKENS = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events" };
const EVENT = { id: "ev-1", htmlLink: "https://calendar.google.com/event?eid=1", hangoutLink: "https://meet.google.com/abc-defg-hij" };

test.before(async () => {
  if (skip) return;
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "a-secret";
  process.env.PUBLIC_APP_URL = "https://app.test";
  await mongoose.connect(process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`));
  GoogleAccount = require("../../models/modules/crm/googleAccountModel");
  Google = require("../crm/googleCalendarService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
});

test.after(async () => {
  if (skip) return;
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/** Connect an account, and hand back the fake so the test can look at what was sent. */
async function connect(fake = fakeGoogle()) {
  Google.useHttp(fake.fn);
  fake.answer(TOKENS); // the code exchange
  fake.answer({ email: "asif@gmail.test" }); // who it is
  const url = await as(() => Google.startUrl(ADMIN));
  const state = new URL(url).searchParams.get("state");
  const status = await as(() => Google.connect({ code: "4/code", state, adminId: ADMIN }));
  return { fake, status, state };
}

test("connecting stores the account, and the tokens are never stored in the clear", { skip }, async () => {
  const { fake, status } = await connect();
  assert.equal(status.connected, true);
  assert.equal(status.email, "asif@gmail.test");

  const sent = fake.form("oauth2.googleapis.com/token");
  assert.equal(sent.grant_type, "authorization_code");
  assert.equal(sent.code, "4/code");
  assert.equal(sent.redirect_uri, "https://app.test/crm/google/callback");

  const row = await as(() => GoogleAccount.findOne({ adminId: ADMIN }).select("+accessTokenEnc +refreshTokenEnc").lean());
  assert.ok(row.accessTokenEnc && row.refreshTokenEnc);
  const whole = JSON.stringify(row);
  assert.ok(!whole.includes("at-1") && !whole.includes("rt-1"), "neither token is readable in the row");
  // and a plain read, as any screen would do, carries neither
  const plain = JSON.stringify(await as(() => GoogleAccount.findOne({ adminId: ADMIN }).lean()));
  assert.ok(!plain.includes("TokenEnc"), "the encrypted fields are not even sent unless asked for");
});

test("the state Google sends back must be ours, this person's, and recent", { skip }, async () => {
  const url = await as(() => Google.startUrl(ADMIN));
  const state = new URL(url).searchParams.get("state");
  const fake = fakeGoogle();
  Google.useHttp(fake.fn);

  // somebody else's connection cannot be attached to this person
  await assert.rejects(() => as(() => Google.connect({ code: "x", state, adminId: "b".repeat(24) })), /belongs to somebody else/i);
  // a made-up or tampered state is refused
  await assert.rejects(() => as(() => Google.connect({ code: "x", state: "nonsense", adminId: ADMIN })), /could not be checked/i);
  await assert.rejects(() => as(() => Google.connect({ code: "x", state: `${state}tampered`, adminId: ADMIN })), /could not be checked/i);
  assert.equal(fake.calls.length, 0, "none of those reached Google at all");
});

test("a connection with no lasting permission is refused, because it would die within the hour", { skip }, async () => {
  const fake = fakeGoogle();
  Google.useHttp(fake.fn);
  fake.answer({ access_token: "at", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events" }); // no refresh_token
  const url = await as(() => Google.startUrl("c".repeat(24)));
  const state = new URL(url).searchParams.get("state");
  await assert.rejects(() => as(() => Google.connect({ code: "x", state, adminId: "c".repeat(24) })), /lasting permission/i);
});

test("a person who unticks the calendar box is told, rather than finding out when a meeting fails", { skip }, async () => {
  const fake = fakeGoogle();
  Google.useHttp(fake.fn);
  fake.answer({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid email" });
  const who = "d".repeat(24);
  const url = await as(() => Google.startUrl(who));
  const state = new URL(url).searchParams.get("state");
  await assert.rejects(() => as(() => Google.connect({ code: "x", state, adminId: who })), /calendar permission was not granted/i);
});

test("making an event asks for a conference, and the Meet link comes back", { skip }, async () => {
  const { fake } = await connect();
  fake.answer(EVENT);
  const out = await as(() => Google.createEvent(ADMIN, {
    subject: "Price review",
    startAt: new Date("2026-11-03T10:30:00Z"),
    endAt: new Date("2026-11-03T11:00:00Z"),
    timezone: "Asia/Dubai",
    attendees: [{ name: "Hassan", email: "hassan@alnoor.test" }],
    requestId: "uid-1",
  }));
  assert.equal(out.ok, true);
  assert.equal(out.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.equal(out.event.id, "ev-1");

  const call = fake.find("/calendar/v3/calendars/primary/events");
  assert.equal(call.method, "POST");
  assert.match(call.url, /conferenceDataVersion=1/, "without this Google ignores the conference and returns no link");
  assert.match(call.url, /sendUpdates=none/, "we send our own invitation");
  assert.equal(call.headers.Authorization, "Bearer at-1");
  const body = fake.json("/calendar/v3/calendars/primary/events");
  assert.equal(body.conferenceData.createRequest.requestId, "uid-1");
  assert.equal(body.summary, "Price review");
});

test("an expired token is replaced before the call, and the refresh token is kept", { skip }, async () => {
  const { fake } = await connect();
  await as(() => GoogleAccount.updateOne({ adminId: ADMIN }, { $set: { expiresAt: new Date(Date.now() - 60000) } }));
  fake.answer({ access_token: "at-2", expires_in: 3600 }); // a refresh answer carries NO refresh token
  fake.answer(EVENT);

  const out = await as(() => Google.createEvent(ADMIN, { subject: "x", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z"), timezone: "UTC" }));
  assert.equal(out.ok, true);

  const refreshed = fake.lastForm("oauth2.googleapis.com/token");
  assert.equal(refreshed.grant_type, "refresh_token");
  assert.equal(refreshed.refresh_token, "rt-1");
  // the event call used the NEW token
  assert.equal(fake.find("/calendar/v3/calendars/primary/events").headers.Authorization, "Bearer at-2");
  // and the refresh token we already had is still there, or the connection would be lost on the next refresh
  const row = await as(() => GoogleAccount.findOne({ adminId: ADMIN }).select("+refreshTokenEnc").lean());
  assert.ok(row.refreshTokenEnc, "still connected");
  fake.answer(EVENT);
  await as(() => Google.createEvent(ADMIN, { subject: "y", startAt: new Date("2026-11-03T12:30:00Z"), endAt: new Date("2026-11-03T13:00:00Z"), timezone: "UTC" }));
  assert.equal(fake.calls.filter((c) => c.url.includes("oauth2.googleapis.com/token")).length, 2, "a token still in date is not refreshed again");
});

test("a grant the person withdrew at Google is reported as 'connect again', and recorded on the account", { skip }, async () => {
  const { fake } = await connect();
  await as(() => GoogleAccount.updateOne({ adminId: ADMIN }, { $set: { expiresAt: new Date(Date.now() - 60000) } }));
  fake.answer({ error: "invalid_grant" }, { ok: false, status: 400 });

  const out = await as(() => Google.createEvent(ADMIN, { subject: "x", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z"), timezone: "UTC" }));
  assert.equal(out.ok, false);
  assert.match(out.error, /not connected|connect the account again/i);
  const status = await as(() => Google.status(ADMIN));
  assert.equal(status.label, "Needs attention", "the screen can tell them to reconnect");
  assert.match(status.detail, /connect the account again/i);
});

test("Google being unreachable is a failed link, never a lost meeting", { skip }, async () => {
  const { fake } = await connect();
  fake.answer({ error: { message: "Backend error" } }, { ok: false, status: 503 });
  const out = await as(() => Google.createEvent(ADMIN, { subject: "x", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z"), timezone: "UTC" }));
  assert.equal(out.ok, false);
  assert.equal(out.retryable, true);
  assert.match(out.error, /could not be reached/i);
});

test("an event Google accepts without a conference is said plainly, not shown as an empty Join button", { skip }, async () => {
  const { fake } = await connect();
  fake.answer({ id: "ev-2", htmlLink: "https://calendar.google.com/x" }); // no hangoutLink at all
  const out = await as(() => Google.createEvent(ADMIN, { subject: "x", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z"), timezone: "UTC" }));
  assert.equal(out.ok, true, "the event exists");
  assert.equal(out.meetLink, "");
  assert.match(out.error, /no Meet link/i);
});

test("changing an event does not ask for a new conference, which would replace the link people hold", { skip }, async () => {
  const { fake } = await connect();
  fake.answer({ ...EVENT });
  const out = await as(() => Google.updateEvent(ADMIN, "ev-1", { subject: "Moved", startAt: new Date("2026-11-04T10:30:00Z"), endAt: new Date("2026-11-04T11:00:00Z"), timezone: "Asia/Dubai" }));
  assert.equal(out.ok, true);
  const call = fake.find("/events/ev-1");
  assert.equal(call.method, "PATCH");
  assert.match(call.url, /conferenceDataVersion=0/);
  assert.equal(JSON.parse(call.body).conferenceData, undefined);
});

test("deleting one that is already gone is a success, because gone is what was wanted", { skip }, async () => {
  const { fake } = await connect();
  fake.answer({}, { ok: false, status: 404 });
  assert.equal((await as(() => Google.deleteEvent(ADMIN, "ev-gone"))).ok, true);
  assert.deepEqual(await as(() => Google.deleteEvent(ADMIN, "")), { ok: true }, "nothing to delete reaches Google at all");
});

test("disconnecting withdraws the permission at Google and forgets the account", { skip }, async () => {
  const { fake } = await connect();
  fake.answer({});
  await as(() => Google.disconnect(ADMIN));
  assert.ok(fake.find("oauth2.googleapis.com/revoke"), "Google is told, or the permission would live on in the person's account");
  assert.equal(await as(() => GoogleAccount.countDocuments({ adminId: ADMIN })), 0);
  assert.equal((await as(() => Google.status(ADMIN))).connected, false);
});

test("with no Google app configured the feature is simply not offered", { skip }, async () => {
  const id = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "";
  try {
    const status = await as(() => Google.status("e".repeat(24)));
    assert.equal(status.available, false, "the screen hides it rather than offering a button that cannot work");
    assert.throws(() => Google.startUrl("e".repeat(24)), /not set up/i);
    assert.equal(await as(() => Google.tokenFor(ADMIN)), null);
  } finally {
    process.env.GOOGLE_CLIENT_ID = id;
  }
});
