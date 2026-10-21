// The Google rules. There is no Google account on this machine, so these pin the exact shapes we send and the exact
// readings we take of what comes back - which is the only part of a third-party integration that can be proved here.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../googleCalendar");

const APP = { clientId: "cid.apps.googleusercontent.com", clientSecret: "secret", redirectUri: "https://app.test/crm/google/callback" };

test("the consent link asks for a LASTING permission, which is the whole point of connecting", () => {
  const url = new URL(g.consentUrl({ ...APP, state: "st8" }));
  assert.equal(url.origin + url.pathname, g.AUTH_URL);
  const q = url.searchParams;
  assert.equal(q.get("client_id"), APP.clientId);
  assert.equal(q.get("redirect_uri"), APP.redirectUri);
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("state"), "st8");
  // Without offline + consent Google hands back no refresh token the second time, and the connection dies in an hour.
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("scope"), "https://www.googleapis.com/auth/calendar.events");
});

test("a consent link cannot be built from nothing", () => {
  assert.equal(g.consentUrl({}), null);
  assert.equal(g.consentUrl({ ...APP }), null, "no state means no way to check the answer came back to us");
  assert.equal(g.consentUrl({ ...APP, state: "s", loginHint: "a@b.test" }).includes("login_hint=a%40b.test"), true);
});

test("the two token requests are the forms Google documents", () => {
  const code = new URLSearchParams(g.codeExchangeBody({ code: "4/abc", ...APP }));
  assert.equal(code.get("grant_type"), "authorization_code");
  assert.equal(code.get("code"), "4/abc");
  assert.equal(code.get("redirect_uri"), APP.redirectUri, "Google checks it matches the one that started this");

  const refresh = new URLSearchParams(g.refreshBody({ refreshToken: "1//rt", ...APP }));
  assert.equal(refresh.get("grant_type"), "refresh_token");
  assert.equal(refresh.get("refresh_token"), "1//rt");
  assert.equal(refresh.get("redirect_uri"), null, "a refresh carries no redirect");
});

test("what is kept from Google's answer, including the refresh token it does NOT repeat", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  const first = g.tokensFrom({ access_token: "at1", refresh_token: "rt1", expires_in: 3599, scope: g.SCOPES[0] }, { now });
  assert.equal(first.accessToken, "at1");
  assert.equal(first.refreshToken, "rt1");
  assert.equal(first.expiresAt.toISOString(), "2026-11-03T10:59:59.000Z");

  // A refresh answer has no refresh_token. Overwriting with undefined is how a connection is silently lost.
  const again = g.tokensFrom({ access_token: "at2", expires_in: 3600 }, { now, previousRefresh: "rt1" });
  assert.equal(again.refreshToken, "rt1", "the one we hold is kept");
  assert.equal(again.accessToken, "at2");

  assert.equal(g.tokensFrom({}), null, "an answer with no access token is no answer");
  assert.equal(g.tokensFrom({ access_token: "at", scope: "" }, { now }).expiresAt.toISOString(), "2026-11-03T11:00:00.000Z", "a missing expiry is treated as an hour");
});

test("a token is replaced before it expires, and a missing expiry counts as expired", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  assert.equal(g.needsRefresh({ expiresAt: new Date("2026-11-03T10:30:00Z") }, now), false);
  assert.equal(g.needsRefresh({ expiresAt: new Date("2026-11-03T10:01:00Z") }, now), true, "inside the margin: replace it rather than race");
  assert.equal(g.needsRefresh({ expiresAt: new Date("2026-11-03T09:59:00Z") }, now), true);
  assert.equal(g.needsRefresh({}, now), true, "nothing known means ask again, never send a dead token");
  assert.equal(g.needsRefresh(null, now), true);
});

test("a person who unticks the calendar box has not granted enough", () => {
  assert.equal(g.grantedEnough("https://www.googleapis.com/auth/calendar.events"), true);
  assert.equal(g.grantedEnough("https://www.googleapis.com/auth/calendar.events openid email"), true);
  assert.equal(g.grantedEnough("openid email"), false);
  assert.equal(g.grantedEnough(""), false);
  assert.equal(g.grantedEnough(undefined), false);
});

// ---- the event -------------------------------------------------------------------------------------------------

const MEETING = {
  subject: "Price review",
  description: "Bring the list",
  startAt: new Date("2026-11-03T10:30:00Z"),
  endAt: new Date("2026-11-03T11:00:00Z"),
  timezone: "Asia/Dubai",
  attendees: [{ name: "Hassan", email: "hassan@alnoor.test" }, { name: "No address" }],
  requestId: "req-1",
};

test("the event asks Google to mint a conference, which is what makes the Meet link", () => {
  const body = g.eventBody(MEETING);
  assert.equal(body.summary, "Price review");
  assert.deepEqual(body.start, { dateTime: "2026-11-03T10:30:00.000Z", timeZone: "Asia/Dubai" });
  assert.deepEqual(body.end, { dateTime: "2026-11-03T11:00:00.000Z", timeZone: "Asia/Dubai" });
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(body.conferenceData.createRequest.requestId, "req-1");
  assert.deepEqual(body.attendees, [{ email: "hassan@alnoor.test", displayName: "Hassan" }], "somebody with no address is left out, not sent as a blank");
});

test("the query carries the one parameter without which Google ignores the conference entirely", () => {
  const q = new URLSearchParams(g.eventQuery({ wantsMeet: true }));
  assert.equal(q.get("conferenceDataVersion"), "1");
  assert.equal(q.get("sendUpdates"), "none", "we send our own invitation; Google must not send a second");
  assert.equal(new URLSearchParams(g.eventQuery({ wantsMeet: false })).get("conferenceDataVersion"), "0");
  assert.equal(new URLSearchParams(g.eventQuery({ wantsMeet: true, notify: true })).get("sendUpdates"), "all");
});

test("an update does not ask for a conference again, which would replace the link people already have", () => {
  const body = g.eventBody({ ...MEETING, wantsMeet: false });
  assert.equal(body.conferenceData, undefined);
  assert.equal(body.summary, "Price review");
});

test("an event that cannot be described is null, never a half-built request", () => {
  assert.equal(g.eventBody({ ...MEETING, subject: "" }), null);
  assert.equal(g.eventBody({ ...MEETING, startAt: new Date("nonsense") }), null);
  assert.equal(g.eventBody({}), null);
});

test("the Meet link is found wherever Google puts it", () => {
  assert.equal(g.meetLinkOf({ hangoutLink: "https://meet.google.com/abc-defg-hij" }), "https://meet.google.com/abc-defg-hij");
  assert.equal(
    g.meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+971" }, { entryPointType: "video", uri: "https://meet.google.com/xyz" }] } }),
    "https://meet.google.com/xyz",
    "a phone entry is not a joining link"
  );
  assert.equal(g.meetLinkOf({}), "", "an event with no conference says so plainly");
  assert.equal(g.eventRefOf({ id: "ev1", htmlLink: "https://calendar.google.com/x", hangoutLink: "https://meet.google.com/a" }).meetLink, "https://meet.google.com/a");
});

// ---- when Google says no ------------------------------------------------------------------------------------------

test("Google's failures are told apart, because they need different answers from us", () => {
  assert.equal(g.classify(401, {}).kind, "reconnect");
  assert.equal(g.classify(400, { error: "invalid_grant" }).kind, "reconnect", "the grant is gone: the person must connect again");
  assert.match(g.classify(401, {}).message, /connect the account again/i);

  assert.equal(g.classify(429, {}).kind, "retry");
  assert.equal(g.classify(503, {}).kind, "retry");
  assert.equal(g.classify(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }).kind, "retry");
  assert.equal(g.classify(403, { error: { errors: [{ reason: "forbidden" }], message: "No" } }).kind, "refused");
  assert.equal(g.classify(404, {}).kind, "refused");

  assert.equal(g.classify(400, { error: { message: "Bad Request" } }).message, "Bad Request", "Google's own words reach the person");
  assert.equal(g.classify(500, {}).retryable, true);
  assert.equal(g.classify(403, {}).retryable, false);
});

test("the screen is told the truth about a connection, judged by what a status read can actually see", () => {
  // The row shape here is the one the database gives: the tokens are select:false and are NEVER in it. Judging a
  // connection by holding a token said "not connected" about every working account.
  assert.deepEqual(g.connectionState(null), { connected: false, label: "Not connected", detail: "" });
  assert.equal(g.connectionState({ email: "a@b.test" }).connected, false, "no connectedAt, no connection");
  assert.equal(g.connectionState({ connectedAt: new Date(), revokedAt: new Date() }).connected, false);
  assert.equal(g.connectionState({ connectedAt: new Date(), email: "a@b.test" }).label, "Connected as a@b.test");
  assert.equal(g.connectionState({ connectedAt: new Date() }).label, "Connected as a Google account");
  const broken = g.connectionState({ connectedAt: new Date(), email: "a@b.test", lastError: "The Google connection has expired." });
  assert.equal(broken.label, "Needs attention");
  assert.match(broken.detail, /expired/);
});
