// Talking to Google: connecting a person's account, keeping the token alive, and creating the event that carries the
// Meet link.
//
// Every network call goes through `http` below, which is one small injectable function, so the whole service is
// testable without a Google account - and there is no Google account on this machine, so that is the only way any of
// this is proved at all. What CANNOT be proved here is the real round trip; that is said plainly in CLAUDE.md.
//
// The OAuth app is configured once for the whole installation (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), because the
// people using this have ordinary Gmail accounts and cannot own a Workspace app of their own. Each PERSON then
// connects their own Google account to it.
const crypto = require("crypto");
const AppError = require("../../utils/AppError");
const GoogleAccount = require("../../models/modules/crm/googleAccountModel");
const google = require("../../utils/googleCalendar");
const { encrypt, decrypt } = require("../../utils/secretBox");
const { getTenant } = require("../../utils/tenant");
const logger = require("../../utils/logger");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

/** The one place a request leaves for Google. Replaceable in a test; `fetch` is looked up at call time for the same reason. */
async function http(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, body };
}

/** What the installation was given. Absent means the feature is simply not offered, never a broken screen. */
function appConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const base = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  // Google redirects the BROWSER back, and this app authenticates with a token held in the tab, not a cookie - so the
  // address Google returns to is a page of the app, which then hands the code to the API with its own token.
  const redirectUri = clientId && base ? `${base}/crm/google/callback` : "";
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret && redirectUri) };
}

class GoogleCalendarService {
  static get http() {
    return GoogleCalendarService._http || http;
  }

  /** Tests replace the one function that reaches the network. */
  static useHttp(fn) {
    GoogleCalendarService._http = fn;
  }

  static config() {
    return appConfig();
  }

  // ---- connecting -------------------------------------------------------------------------------------------

  /**
   * Where to send the person. The `state` is signed with the server's own key and carries who asked and when, so a
   * callback cannot be replayed, and an attacker cannot trick somebody into attaching an attacker's Google account to
   * their own record.
   */
  static startUrl(adminId, { email = "" } = {}) {
    const cfg = appConfig();
    if (!cfg.configured) throw fail("Google is not set up on this server yet.", 422, "GOOGLE_NOT_CONFIGURED");
    const { companyId } = getTenant();
    const payload = `${companyId}.${adminId}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`;
    const state = `${Buffer.from(payload).toString("base64url")}.${GoogleCalendarService.signState(payload)}`;
    return google.consentUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state, loginHint: email });
  }

  static signState(payload) {
    const key = process.env.SECRET_BOX_KEY || process.env.JWT_SECRET || "dev";
    return crypto.createHmac("sha256", key).update(payload).digest("base64url");
  }

  /** The state back from Google: ours, unexpired, and this person's. Anything else is refused. */
  static readState(state, adminId) {
    const [encoded, signature] = String(state || "").split(".");
    if (!encoded || !signature) throw fail("That sign-in could not be checked. Try connecting again.", 400, "GOOGLE_STATE_INVALID");
    const payload = Buffer.from(encoded, "base64url").toString();
    const expected = GoogleCalendarService.signState(payload);
    // constant time, so the signature cannot be guessed one character at a time
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail("That sign-in could not be checked. Try connecting again.", 400, "GOOGLE_STATE_INVALID");
    const [companyId, who, at] = payload.split(".");
    const { companyId: here } = getTenant();
    if (companyId !== here || String(who) !== String(adminId)) throw fail("That sign-in belongs to somebody else.", 400, "GOOGLE_STATE_INVALID");
    if (Date.now() - Number(at) > 15 * 60 * 1000) throw fail("That took too long. Connect the account again.", 400, "GOOGLE_STATE_EXPIRED");
    return true;
  }

  /** Trade the code for tokens and remember them. One connection per person: connecting again replaces it. */
  static async connect({ code, state, adminId }) {
    const cfg = appConfig();
    if (!cfg.configured) throw fail("Google is not set up on this server yet.", 422, "GOOGLE_NOT_CONFIGURED");
    GoogleCalendarService.readState(state, adminId);

    const res = await GoogleCalendarService.http(google.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: google.codeExchangeBody({ code, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri }),
    });
    if (!res.ok) throw fail(google.classify(res.status, res.body).message, 422, "GOOGLE_CONNECT_FAILED");

    const tokens = google.tokensFrom(res.body);
    if (!tokens) throw fail("Google did not return a usable answer. Try again.", 422, "GOOGLE_CONNECT_FAILED");
    if (!tokens.refreshToken) {
      // Without one, the connection would die within the hour and nobody would know why.
      throw fail("Google did not give a lasting permission. Remove this app at myaccount.google.com and connect again.", 422, "GOOGLE_NO_REFRESH_TOKEN");
    }
    if (!google.grantedEnough(tokens.scope)) {
      throw fail("The calendar permission was not granted, so meetings cannot be created. Connect again and leave the calendar box ticked.", 422, "GOOGLE_SCOPE_MISSING");
    }

    const email = await GoogleCalendarService.whoIs(tokens.accessToken);
    const { companyId } = getTenant();
    await GoogleAccount.findOneAndUpdate(
      { adminId: String(adminId) },
      {
        $set: {
          adminId: String(adminId),
          email,
          accessTokenEnc: encrypt(tokens.accessToken),
          refreshTokenEnc: encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
          connectedAt: new Date(),
          revokedAt: null,
          lastError: null,
        },
        $setOnInsert: { companyId },
      },
      { upsert: true, new: true }
    );
    return GoogleCalendarService.status(adminId);
  }

  /** Which Google account this is, for the screen to name. A failure here is not worth losing the connection over. */
  static async whoIs(accessToken) {
    try {
      const res = await GoogleCalendarService.http("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.ok ? String(res.body?.email || "").toLowerCase().slice(0, 160) : "";
    } catch {
      return "";
    }
  }

  static async status(adminId) {
    const cfg = appConfig();
    const row = await GoogleAccount.findOne({ adminId: String(adminId) }).lean();
    return { available: cfg.configured, ...google.connectionState(row), email: row?.email || "", connectedAt: row?.connectedAt || null };
  }

  /** Forget the connection, and tell Google to forget it too, so the permission really is gone. */
  static async disconnect(adminId) {
    const row = await GoogleAccount.findOne({ adminId: String(adminId) }).select("+refreshTokenEnc").lean();
    if (!row) return { disconnected: true };
    const refresh = GoogleCalendarService.open(row.refreshTokenEnc);
    if (refresh) {
      try {
        await GoogleCalendarService.http(`${google.REVOKE_URL}?token=${encodeURIComponent(refresh)}`, { method: "POST" });
      } catch (e) {
        logger.warn(`[google] the permission could not be withdrawn at Google: ${e?.message || e}`);
      }
    }
    await GoogleAccount.deleteOne({ adminId: String(adminId) });
    return { disconnected: true };
  }

  static open(blob) {
    if (!blob) return "";
    try {
      return decrypt(blob);
    } catch {
      // SECRET_BOX_KEY changed under us: the token is unreadable, and the person must connect again.
      return "";
    }
  }

  // ---- using it ---------------------------------------------------------------------------------------------

  /** A usable access token, refreshed if it is near its end. Null when this person has no working connection. */
  static async tokenFor(adminId) {
    const cfg = appConfig();
    if (!cfg.configured) return null;
    const row = await GoogleAccount.findOne({ adminId: String(adminId) }).select("+accessTokenEnc +refreshTokenEnc").lean();
    if (!row || row.revokedAt) return null;

    if (!google.needsRefresh(row)) {
      const access = GoogleCalendarService.open(row.accessTokenEnc);
      if (access) return access;
    }
    const refresh = GoogleCalendarService.open(row.refreshTokenEnc);
    if (!refresh) {
      await GoogleCalendarService.note(adminId, "The Google connection could not be read. Connect the account again.");
      return null;
    }
    const res = await GoogleCalendarService.http(google.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: google.refreshBody({ refreshToken: refresh, clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
    });
    if (!res.ok) {
      const how = google.classify(res.status, res.body);
      await GoogleCalendarService.note(adminId, how.message);
      return null;
    }
    // A refresh answer carries no refresh_token: the one we hold is kept, or the connection would be lost here.
    const tokens = google.tokensFrom(res.body, { previousRefresh: refresh });
    if (!tokens) return null;
    await GoogleAccount.updateOne(
      { adminId: String(adminId) },
      { $set: { accessTokenEnc: encrypt(tokens.accessToken), refreshTokenEnc: encrypt(tokens.refreshToken), expiresAt: tokens.expiresAt, lastError: null } }
    );
    return tokens.accessToken;
  }

  static async note(adminId, message) {
    await GoogleAccount.updateOne({ adminId: String(adminId) }, { $set: { lastError: String(message).slice(0, 300) } }).catch(() => {});
  }

  /**
   * Create the event, and with it the Meet link. Returns `{ ok, meetLink, event, error }` - never throws, because a
   * meeting that is booked must not be lost to Google being unreachable: the booking stands and the screen says the
   * link could not be made.
   */
  static async createEvent(adminId, meeting = {}) {
    const token = await GoogleCalendarService.tokenFor(adminId);
    if (!token) return { ok: false, error: "This person's Google account is not connected." };

    const body = google.eventBody({ ...meeting, requestId: meeting.requestId || crypto.randomUUID() });
    if (!body) return { ok: false, error: "The meeting could not be described to Google." };

    const res = await GoogleCalendarService.http(`${google.EVENTS_URL}?${google.eventQuery({ wantsMeet: true, notify: false })}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const how = google.classify(res.status, res.body);
      if (how.kind === "reconnect") await GoogleCalendarService.note(adminId, how.message);
      return { ok: false, error: how.message, retryable: how.retryable };
    }
    const ref = google.eventRefOf(res.body);
    if (!ref.meetLink) {
      // Google accepted the event but minted no conference: the booking is fine, the link is not, and saying so is
      // better than showing an empty Join button.
      return { ok: true, meetLink: "", event: ref, error: "Google made the event but no Meet link. Add one by hand." };
    }
    return { ok: true, meetLink: ref.meetLink, event: ref, error: null };
  }

  /** Move or change the event we made. Quiet when there is nothing of ours in Google to change. */
  static async updateEvent(adminId, eventId, meeting = {}) {
    if (!eventId) return { ok: false, error: "This meeting is not in Google Calendar." };
    const token = await GoogleCalendarService.tokenFor(adminId);
    if (!token) return { ok: false, error: "This person's Google account is not connected." };
    const body = google.eventBody({ ...meeting, wantsMeet: false }); // the conference already exists; asking again would replace it
    if (!body) return { ok: false, error: "The meeting could not be described to Google." };
    const res = await GoogleCalendarService.http(`${google.EVENTS_URL}/${encodeURIComponent(eventId)}?${google.eventQuery({ wantsMeet: false, notify: false })}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const how = google.classify(res.status, res.body);
      if (how.kind === "reconnect") await GoogleCalendarService.note(adminId, how.message);
      return { ok: false, error: how.message };
    }
    return { ok: true, event: google.eventRefOf(res.body), error: null };
  }

  /** Remove it from the organiser's Google Calendar. A 404 or 410 means it is already gone, which is the wanted end. */
  static async deleteEvent(adminId, eventId) {
    if (!eventId) return { ok: true };
    const token = await GoogleCalendarService.tokenFor(adminId);
    if (!token) return { ok: false, error: "This person's Google account is not connected." };
    const res = await GoogleCalendarService.http(`${google.EVENTS_URL}/${encodeURIComponent(eventId)}?${google.eventQuery({ wantsMeet: false, notify: false })}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 404 || res.status === 410) return { ok: true };
    const how = google.classify(res.status, res.body);
    if (how.kind === "reconnect") await GoogleCalendarService.note(adminId, how.message);
    return { ok: false, error: how.message };
  }
}

module.exports = GoogleCalendarService;
