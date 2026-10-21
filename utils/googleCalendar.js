// Connecting a person's own Google account, so a meeting gets a REAL Google Meet link and lands in their Google
// Calendar. The rules only - no network, no Mongoose - so the request shapes, the token arithmetic and the awkward
// answers Google gives are tests rather than something discovered against a live account.
//
// WHY THE CALENDAR API AND NOT THE MEET API. A Meet link can be minted two ways: Calendar's
// `conferenceData.createRequest` on an event, or Meet API v2 `spaces.create`. The Meet API lives in Google's
// Workspace documentation and its behaviour on an ORDINARY GMAIL account is not documented either way, while Google
// Calendar demonstrably works on a consumer account - a person makes a Meet link in Calendar every day. Calendar also
// does more for the same consent: the meeting appears in the organiser's own diary, not only as a link we hold.
//
// WHAT THIS CANNOT AVOID. Ordinary Gmail accounts mean the OAuth app must be "External". Until Google reviews it,
// everyone connecting sees an unverified-app warning and there is a hard cap of 100 accounts. The app must also be
// PUBLISHED (not left in "Testing"), where Google expires a refresh token after seven days and the connection would
// break every week.
const SCOPES = [
  // Creating an event with a conference on the person's own calendar. Sensitive, so it is the scope Google reviews.
  "https://www.googleapis.com/auth/calendar.events",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** A token is replaced this long before it actually expires, so a slow request cannot overtake it. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

const text = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Where to send the person to consent.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a REFRESH token: without the prompt Google
 * sends one only the first time ever, so a person who disconnects and reconnects would arrive with no refresh token
 * and the connection would die at the first hour.
 */
function consentUrl({ clientId, redirectUri, state, loginHint = "" } = {}) {
  if (!text(clientId) || !text(redirectUri) || !text(state)) return null;
  const params = new URLSearchParams({
    client_id: text(clientId),
    redirect_uri: text(redirectUri),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: text(state),
  });
  if (text(loginHint, 160)) params.set("login_hint", text(loginHint, 160));
  return `${AUTH_URL}?${params.toString()}`;
}

/** The form body that turns the code Google sent back into tokens. */
const codeExchangeBody = ({ code, clientId, clientSecret, redirectUri } = {}) =>
  new URLSearchParams({
    code: text(code, 2000),
    client_id: text(clientId),
    client_secret: text(clientSecret),
    redirect_uri: text(redirectUri),
    grant_type: "authorization_code",
  }).toString();

/** The form body that trades a refresh token for a new access token. */
const refreshBody = ({ refreshToken, clientId, clientSecret } = {}) =>
  new URLSearchParams({
    refresh_token: text(refreshToken, 2000),
    client_id: text(clientId),
    client_secret: text(clientSecret),
    grant_type: "refresh_token",
  }).toString();

/**
 * What to store from Google's answer. `expires_in` is seconds from now, turned into an instant so nothing has to
 * remember when the answer arrived. A refresh answer carries NO refresh_token, so the one already held is kept - the
 * single most common way a connection is lost is overwriting it with undefined.
 */
function tokensFrom(answer = {}, { now = new Date(), previousRefresh = "" } = {}) {
  const access = text(answer.access_token, 2048);
  if (!access) return null;
  const seconds = Number(answer.expires_in);
  return {
    accessToken: access,
    refreshToken: text(answer.refresh_token, 2048) || text(previousRefresh, 2048),
    expiresAt: new Date(now.getTime() + (Number.isFinite(seconds) ? seconds : 3600) * 1000),
    scope: text(answer.scope, 1000),
  };
}

/** Is the access token past using? A missing expiry is treated as expired: ask again rather than send a dead token. */
const needsRefresh = (account, now = new Date()) => {
  const at = account?.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  return !at || at - REFRESH_MARGIN_MS <= now.getTime();
};

/** Did the person grant what we asked for? Google lets them untick a scope, and then the event call would just fail. */
const grantedEnough = (scope) => {
  const granted = text(scope, 1000).split(/\s+/).filter(Boolean);
  return SCOPES.every((s) => granted.includes(s));
};

/**
 * The event body for Google Calendar.
 *
 * `conferenceData.createRequest` with a UNIQUE requestId is what makes Google mint a Meet link; it must be sent with
 * `conferenceDataVersion=1` in the query or Google silently ignores the whole block and returns an event with no link.
 * Google's own guidance is a fresh request id for every event, because reusing a Meet code across events can let one
 * meeting's attendees into another.
 */
function eventBody({ subject, description = "", startAt, endAt, timezone, attendees = [], location = "", requestId, wantsMeet = true } = {}) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const end = endAt instanceof Date ? endAt : new Date(endAt);
  if (!text(subject) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const body = {
    summary: text(subject, 200),
    description: text(description, 2000),
    // The instant in UTC with the zone beside it: Google shows each attendee their own clock, and the zone is what
    // makes a recurring reading of it unambiguous.
    start: { dateTime: start.toISOString(), timeZone: text(timezone, 60) || "UTC" },
    end: { dateTime: end.toISOString(), timeZone: text(timezone, 60) || "UTC" },
    attendees: (attendees || [])
      .map((a) => ({ email: text(a?.email, 160), displayName: text(a?.name, 120) }))
      .filter((a) => a.email),
    reminders: { useDefault: true },
  };
  if (text(location, 300)) body.location = text(location, 300);
  if (wantsMeet) {
    body.conferenceData = {
      createRequest: { requestId: text(requestId, 64), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  return body;
}

/** The query Google needs for a conference to be created at all, plus who it should email. */
const eventQuery = ({ wantsMeet = true, notify = false } = {}) =>
  new URLSearchParams({
    conferenceDataVersion: wantsMeet ? "1" : "0",
    // We send our own invitation, so Google is told not to send a second one unless asked.
    sendUpdates: notify ? "all" : "none",
  }).toString();

/** The Meet link out of Google's answer, wherever this version of the API puts it. */
function meetLinkOf(event = {}) {
  const direct = text(event.hangoutLink, 500);
  if (direct) return direct;
  const entry = (event.conferenceData?.entryPoints || []).find((e) => e?.entryPointType === "video" && text(e.uri, 500));
  return entry ? text(entry.uri, 500) : "";
}

/** What is worth keeping about the event we made, so it can be changed or removed later. */
const eventRefOf = (event = {}) => ({
  id: text(event.id, 200),
  htmlLink: text(event.htmlLink, 500),
  meetLink: meetLinkOf(event),
});

/**
 * Google's failures, told apart, because they need different answers from us.
 *   reconnect  the person must sign in to Google again (the grant is gone)
 *   retry      a passing problem: try later
 *   refused    Google will not do it however often we ask
 */
function classify(status, body = {}) {
  const error = text(body?.error?.message || body?.error_description || body?.error, 300);
  const reason = text(body?.error?.errors?.[0]?.reason || body?.error, 60);
  if (status === 401 || reason === "invalid_grant" || reason === "authError") {
    return { kind: "reconnect", retryable: false, message: "The Google connection has expired. Connect the account again." };
  }
  if (status === 403 && /rateLimit|userRateLimit|quota/i.test(reason)) return { kind: "retry", retryable: true, message: "Google is busy. It will be tried again shortly." };
  if (status === 403) return { kind: "refused", retryable: false, message: error || "Google refused this. The account may not be allowed to create meetings." };
  if (status === 404) return { kind: "refused", retryable: false, message: "That meeting is no longer in Google Calendar." };
  if (status === 429 || (status >= 500 && status <= 599)) return { kind: "retry", retryable: true, message: "Google could not be reached. It will be tried again shortly." };
  return { kind: "refused", retryable: false, message: error || `Google answered ${status}.` };
}

/**
 * What the screen says about a connection, which must never promise more than is true.
 *
 * It judges by `connectedAt`, NOT by holding a token: the tokens are `select: false` on the model, so a status read
 * never has them and testing for one would say "not connected" about every working account.
 */
function connectionState(account) {
  if (!account || !account.connectedAt) return { connected: false, label: "Not connected", detail: "" };
  if (account.revokedAt) return { connected: false, label: "Disconnected", detail: "" };
  if (account.lastError) return { connected: true, label: "Needs attention", detail: account.lastError };
  return { connected: true, label: `Connected as ${account.email || "a Google account"}`, detail: "" };
}

module.exports = {
  SCOPES, AUTH_URL, TOKEN_URL, REVOKE_URL, EVENTS_URL, REFRESH_MARGIN_MS,
  consentUrl, codeExchangeBody, refreshBody, tokensFrom, needsRefresh, grantedEnough,
  eventBody, eventQuery, meetLinkOf, eventRefOf, classify, connectionState,
};
