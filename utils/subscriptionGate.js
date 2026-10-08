// What a request may do given where its organisation stands against its subscription. Pure: it takes the
// organisation and the clock, and answers with an error to send (or null), so every state is a test with no
// server. The same answers are used at sign-in, on every signed-in request and when a session is refreshed.
const AppError = require("./AppError");
const { subscriptionState } = require("./plans");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const CODES = { expired: "ORGANISATION_EXPIRED", suspended: "ORGANISATION_SUSPENDED", closed: "ORGANISATION_CLOSED" };

// Who to contact is the operator's to say; the app does not invent an address.
const contact = () => process.env.SUPPORT_CONTACT || process.env.SUPPORT_EMAIL || null;

const detailsOf = (org, state) => ({
  state: state.state,
  endsAt: state.endsAt || null,
  onExpiry: state.onExpiry,
  plan: org?.planCode || null,
  organisation: org?.legalName || org?.code || null,
  contact: contact(),
});

// The organisation may not use the system at all (suspended, closed, or expired with the block rule).
function lockedError(org, state = subscriptionState(org)) {
  const tail = " Please contact support" + (contact() ? ` (${contact()})` : "") + " to restore access.";
  return new AppError(`${state.reason}${tail}`, 403, CODES[state.state] || "ORGANISATION_LOCKED", detailsOf(org, state));
}

// Sign-in and refresh: only a blocked organisation is turned away; one that is read-only may sign in and look.
function signInRefusal(org, now = new Date()) {
  const state = subscriptionState(org, now);
  return state.blocked ? lockedError(org, state) : null;
}

// A signed-in request: blocked is refused outright, and a read-only organisation (expired with the read-only
// rule) may read but not change anything.
function requestRefusal(org, method, now = new Date()) {
  const state = subscriptionState(org, now);
  if (state.blocked) return lockedError(org, state);
  if (!state.canWrite && !SAFE_METHODS.has(String(method || "").toUpperCase())) {
    return new AppError(
      `${state.reason} This organisation can still be read but nothing can be changed.` + (contact() ? ` Please contact ${contact()}.` : " Please contact support."),
      403,
      "ORGANISATION_READ_ONLY",
      detailsOf(org, state)
    );
  }
  return null;
}

// Headers a screen can use to warn before anything is refused: the grace period, a subscription ending soon.
function warningHeaders(org, now = new Date()) {
  const state = subscriptionState(org, now);
  const headers = {};
  const ending = state.daysLeft != null && state.daysLeft <= 14;
  if (state.state === "active" && !ending) return headers;
  headers["X-Subscription-State"] = state.state;
  if (state.daysLeft != null) headers["X-Subscription-Days-Left"] = String(state.daysLeft);
  if (state.endsAt) headers["X-Subscription-Ends"] = new Date(state.endsAt).toISOString();
  return headers;
}

module.exports = { SAFE_METHODS, lockedError, signInRefusal, requestRefusal, warningHeaders };
