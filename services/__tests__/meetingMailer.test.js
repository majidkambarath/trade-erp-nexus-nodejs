// What actually leaves the building when a meeting is arranged, with the provider replaced so the exact request can be
// read without a mail account.
//
// This is the half no database test can prove: an .ics that a mail client will not recognise is a meeting the customer
// never puts in their diary, and the two providers need DIFFERENT things to make that work.
const test = require("node:test");
const assert = require("node:assert/strict");
const { PROVIDERS, RESEND_URL } = require("../messaging/providers");
const meetings = require("../../utils/meetings");

const ICS = meetings.buildIcs({
  uid: "crm-1@zarvia",
  sequence: 0,
  method: "REQUEST",
  start: new Date("2026-11-03T10:30:00Z"),
  end: new Date("2026-11-03T11:00:00Z"),
  subject: "Price review",
  organiser: { name: "Asif Rahman", email: "asif@zarvia.test" },
  attendees: [{ name: "Hassan Al Noor", email: "hassan@alnoor.test" }],
});

const message = (over = {}) => ({
  from: "Zarvia <crm@zarvia.test>",
  to: ["hassan@alnoor.test"],
  cc: [],
  bcc: [],
  replyTo: "asif@zarvia.test",
  subject: "Invitation: Price review",
  text: "When: 2026-11-03, 14:30 - 15:00 (Asia/Dubai)",
  html: "<p>When: 2026-11-03, 14:30 - 15:00 (Asia/Dubai)</p>",
  icalEvent: { method: "REQUEST", filename: "invite.ics", content: ICS },
  attachments: [{ filename: "invite.ics", content: Buffer.from(ICS, "utf8"), contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
  idempotencyKey: "meeting-crm-1@zarvia-0-invite",
  ...over,
});

// ---- Resend ------------------------------------------------------------------------------------------------------

/** Capture the one request the provider makes, and answer as Resend does. */
function captureFetch(answer = { id: "re_1" }) {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  return { calls, fake };
}

test("Resend is told the attachment is a calendar, or the invitation arrives as a nameless file", { skip: !PROVIDERS.resend }, async () => {
  const { calls, fake } = captureFetch();
  const previous = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await PROVIDERS.resend.send(message(), { apiKey: "re_test" });
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_URL);
  const attachment = calls[0].body.attachments[0];
  assert.equal(attachment.filename, "invite.ics");
  assert.equal(attachment.content_type, "text/calendar; charset=utf-8; method=REQUEST", "the field Resend reads; without it no mail client offers a diary entry");
  // Raw, not base64: Resend has been reported to mishandle a base64 .ics, and the bytes are plain text anyway.
  assert.ok(attachment.content.startsWith("BEGIN:VCALENDAR"), "sent as text, not base64");
  assert.match(attachment.content, /METHOD:REQUEST/);
});

test("an ordinary attachment is still base64, exactly as it was before meetings existed", { skip: !PROVIDERS.resend }, async () => {
  const { calls, fake } = captureFetch();
  const previous = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await PROVIDERS.resend.send(
      message({ icalEvent: undefined, attachments: [{ filename: "invoice.pdf", content: Buffer.from("%PDF-1.4 hello"), contentType: "application/pdf" }] }),
      { apiKey: "re_test" }
    );
  } finally {
    globalThis.fetch = previous;
  }
  const attachment = calls[0].body.attachments[0];
  assert.deepEqual(Object.keys(attachment).sort(), ["content", "filename"], "byte for byte the request it always sent: Resend reads a PDF's type from the filename");
  assert.equal(Buffer.from(attachment.content, "base64").toString("utf8"), "%PDF-1.4 hello", "a PDF is base64, as it always was");
});

test("an attachment with no type named is sent as it always was", { skip: !PROVIDERS.resend }, async () => {
  const { calls, fake } = captureFetch();
  const previous = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await PROVIDERS.resend.send(message({ icalEvent: undefined, attachments: [{ filename: "notes.txt", content: Buffer.from("hello") }] }), { apiKey: "re_test" });
  } finally {
    globalThis.fetch = previous;
  }
  const attachment = calls[0].body.attachments[0];
  assert.equal(attachment.content_type, undefined, "no type is sent rather than a wrong one");
  assert.equal(Buffer.from(attachment.content, "base64").toString("utf8"), "hello");
  assert.deepEqual(Object.keys(attachment).sort(), ["content", "filename"]);
});

// ---- SMTP --------------------------------------------------------------------------------------------------------

/** A transport that records what nodemailer was asked to send. */
function fakeTransport() {
  const sent = [];
  return {
    sent,
    createTransport: () => ({
      sendMail: async (mail) => {
        sent.push(mail);
        return { messageId: "<x@zarvia.test>", accepted: mail.to, rejected: [], response: "250 OK" };
      },
      close: () => {},
    }),
  };
}

test("SMTP sends the event as a calendar part, which is what draws the Accept buttons", async () => {
  const t = fakeTransport();
  await PROVIDERS.smtp.send(message(), { apiKey: "pw", smtp: { host: "smtp.test", port: 587, user: "crm@zarvia.test" }, createTransport: t.createTransport });
  assert.equal(t.sent.length, 1);
  const mail = t.sent[0];
  assert.equal(mail.icalEvent.method, "REQUEST", "nodemailer turns this into text/calendar; method=REQUEST");
  assert.equal(mail.icalEvent.filename, "invite.ics");
  assert.match(mail.icalEvent.content, /^BEGIN:VCALENDAR/);
  assert.equal(mail.replyTo, "asif@zarvia.test", "an answer goes to the organiser, not to the address nobody reads");
  // and the .ics is attached as well, for anything that ignores the alternative
  assert.equal(mail.attachments[0].filename, "invite.ics");
  assert.match(mail.attachments[0].contentType, /text\/calendar/);
});

test("an ordinary message carries no calendar part at all", async () => {
  const t = fakeTransport();
  await PROVIDERS.smtp.send(message({ icalEvent: undefined, attachments: [] }), { apiKey: "pw", smtp: { host: "smtp.test", port: 587 }, createTransport: t.createTransport });
  assert.equal(t.sent[0].icalEvent, undefined, "nothing changed for an invoice email");
});

test("a cancellation is sent as a cancellation", async () => {
  const off = meetings.buildIcs({
    uid: "crm-1@zarvia", sequence: 2, method: "CANCEL",
    start: new Date("2026-11-03T10:30:00Z"), end: new Date("2026-11-03T11:00:00Z"),
    subject: "Price review", organiser: { name: "Asif", email: "asif@zarvia.test" }, attendees: [{ name: "H", email: "h@x.test" }],
  });
  const t = fakeTransport();
  await PROVIDERS.smtp.send(
    message({ subject: "Cancelled: Price review", icalEvent: { method: "CANCEL", filename: "invite.ics", content: off }, attachments: [{ filename: "invite.ics", content: Buffer.from(off), contentType: "text/calendar; charset=utf-8; method=CANCEL" }] }),
    { apiKey: "pw", smtp: { host: "smtp.test", port: 587 }, createTransport: t.createTransport }
  );
  const mail = t.sent[0];
  assert.equal(mail.icalEvent.method, "CANCEL");
  assert.match(mail.icalEvent.content, /STATUS:CANCELLED/);
  assert.match(mail.subject, /^Cancelled:/);
});

// ---- the words ---------------------------------------------------------------------------------------------------

test("the email body carries the time, the zone and the link, so nothing is lost if the .ics is ignored", () => {
  const { asHtml } = require("../crm/meetingMailer");
  const text = meetings.inviteText({
    subject: "Price review",
    startAt: new Date("2026-11-03T10:30:00Z"),
    endAt: new Date("2026-11-03T11:00:00Z"),
    zone: "Asia/Dubai",
    joinUrl: "https://meet.example.com/abc",
    organiserName: "Asif Rahman",
  });
  const html = asHtml(text, "https://meet.example.com/abc");
  assert.match(html, /14:30 - 15:00 \(Asia\/Dubai\)/);
  assert.match(html, /<a href="https:\/\/meet\.example\.com\/abc">/, "the link is clickable");
  assert.ok(!html.includes("<script"), "and the words are escaped");
  const nasty = asHtml("<script>alert(1)</script>", "");
  assert.ok(!nasty.includes("<script>"), "a subject cannot carry markup into the email");
  assert.match(nasty, /&lt;script&gt;/);
});
