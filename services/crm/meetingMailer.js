// Sending a meeting invitation, cancellation or change.
//
// It reuses the ORGANISATION's own mail account (services/messaging/settingsService.js) and the provider layer, but
// deliberately NOT MessagingService.send: that pipeline is document-shaped - a docType, a share link, a PDF, a retry
// row per document - and a meeting is not a document. Forcing one through it would mean inventing a fake docType.
//
// Nothing here throws into the caller's face. A meeting that is booked but whose invitation did not go out is still a
// meeting; the failure is recorded on it and the screen says so, rather than losing the booking to a mail problem.
const meetings = require("../../utils/meetings");
const Settings = require("../messaging/settingsService");
const { PROVIDERS, formatFrom } = require("../messaging/providers");
const { getTenant } = require("../../utils/tenant");
const logger = require("../../utils/logger");

const ICS_TYPE = (method) => `text/calendar; charset=utf-8; method=${method}`;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The plain text as simple HTML: one paragraph a line, and the join link as a real link. */
function asHtml(text, joinUrl) {
  const body = String(text || "")
    .split("\n")
    .map((line) => {
      if (joinUrl && line.includes(joinUrl)) {
        const [label] = line.split(joinUrl);
        return `<p>${escapeHtml(label)}<a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></p>`;
      }
      return line.trim() ? `<p>${escapeHtml(line)}</p>` : "";
    })
    .join("\n");
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1c1d21">${body}</div>`;
}

class MeetingMailer {
  /**
   * Send one invitation to everybody on it.
   *
   * `method` is REQUEST to invite or to tell them it moved, CANCEL to call it off. Returns what happened, for the
   * record kept on the meeting: { sent, provider, to[], error }.
   *
   * The ORGANISER is the person who booked it, not our sending address, because the attendee's Accept reply goes to
   * whoever is named there and it must reach a human being.
   */
  static async send({ activity, organiser, note = "", method = "REQUEST", dayLabel = "" } = {}) {
    const m = activity?.meeting;
    const to = (m?.attendees || []).map((a) => String(a.email || "").trim()).filter(Boolean);
    if (!m || !to.length) return { sent: false, provider: null, to: [], error: "Nobody on this meeting has an email address" };

    let settings;
    try {
      settings = await Settings.load(getTenant().companyId, { withSecrets: true });
    } catch (e) {
      return { sent: false, provider: null, to, error: e?.message || "The sending setup could not be read" };
    }
    if (!settings.enabled) return { sent: false, provider: settings.provider, to, error: "Sending is switched off in Settings, under Sending" };
    if (!settings.fromEmail) return { sent: false, provider: settings.provider, to, error: "No sender address is set in Settings, under Sending" };

    const cancelled = String(method).toUpperCase() === "CANCEL";
    const changed = !cancelled && (m.sequence || 0) > 0;
    const zone = m.timezone;
    const text = meetings.inviteText({
      subject: activity.subject,
      startAt: m.startAt,
      endAt: m.endAt,
      zone,
      where: m.where,
      location: m.location,
      joinUrl: m.joinUrl,
      organiserName: organiser?.name || "",
      note: cancelled ? "This meeting has been cancelled." : note,
      dayLabel,
    });

    const ics = meetings.buildIcs({
      uid: m.uid,
      sequence: m.sequence || 0,
      method: cancelled ? "CANCEL" : "REQUEST",
      start: m.startAt,
      end: m.endAt,
      subject: activity.subject,
      description: note || activity.notes || "",
      location: m.location,
      joinUrl: m.joinUrl,
      organiser,
      attendees: m.attendees,
    });
    if (!ics) return { sent: false, provider: settings.provider, to, error: "The invitation could not be built" };

    const message = {
      from: formatFrom(settings.fromName, settings.fromEmail),
      to,
      cc: [],
      bcc: [],
      // An answer belongs to the organiser, not to the sending address, which nobody reads.
      replyTo: organiser?.email || settings.replyTo || undefined,
      subject: meetings.inviteSubject({ subject: activity.subject, cancelled, changed }),
      text,
      html: asHtml(text, m.joinUrl),
      // Both halves on purpose. `icalEvent` is what nodemailer turns into the text/calendar alternative that makes a
      // mail client show Accept and Decline; the attachment is the fallback for anything that ignores it. The body
      // above carries the day, the time, the zone and the link in words, so even a client that shows neither loses
      // nothing a person needs.
      icalEvent: { method: cancelled ? "CANCEL" : "REQUEST", filename: "invite.ics", content: ics },
      attachments: [{ filename: "invite.ics", content: Buffer.from(ics, "utf8"), contentType: ICS_TYPE(cancelled ? "CANCEL" : "REQUEST") }],
      idempotencyKey: `meeting-${m.uid}-${m.sequence || 0}-${cancelled ? "cancel" : "invite"}`,
    };

    const provider = PROVIDERS[settings.provider] || PROVIDERS.console;
    try {
      await provider.send(message, { apiKey: Settings.keyOf(settings), smtp: { host: settings.smtpHost, port: settings.smtpPort, user: settings.smtpUser } });
      return { sent: true, provider: settings.provider, to, error: null };
    } catch (e) {
      logger.warn(`[crm] a meeting invitation could not be sent: ${e?.message || e}`);
      return { sent: false, provider: settings.provider, to, error: String(e?.message || e).slice(0, 300) };
    }
  }
}

module.exports = MeetingMailer;
module.exports.asHtml = asHtml;
