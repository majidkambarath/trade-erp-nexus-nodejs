// Sending an email to a customer from the CRM, and keeping it on the record.
//
// The rules only - no Mongoose, no network - so the things that go wrong quietly (a template that addresses somebody
// as "Hello {{contact.name}}", an address typed with a space in it, a body that carries markup into the message) are
// tests rather than something a customer receives.
//
// This is NOT two-way email. We send, and we remember what we sent. Reading the customer's REPLY would mean either
// their mailbox password or Gmail's restricted scope, which costs an annual third-party security assessment; neither
// is built, and the screen never pretends a reply has been seen.
const text = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** How many a person may send at once. A CRM email is one conversation, not a campaign - that is a different product. */
const MAX_RECIPIENTS = 10;
const MAX_SUBJECT = 200;
const MAX_BODY = 10000;
const MAX_TEMPLATES = 20;

/**
 * What a template may put in a message. Deliberately short: every one of these is something we certainly hold, so a
 * placeholder can always be filled or honestly blanked, and nobody writes {{customer.vat_number}} and gets silence.
 */
const PLACEHOLDERS = [
  ["contact.name", "The person's name"],
  ["contact.firstName", "Their first name"],
  ["company.name", "Their company"],
  ["deal.title", "What the deal is for"],
  ["deal.value", "What the deal is worth"],
  ["sender.name", "Your name"],
  ["sender.company", "Your company"],
];
const PLACEHOLDER_KEYS = PLACEHOLDERS.map(([k]) => k);

const addressOf = (v) => {
  const raw = text(v, 160).toLowerCase();
  return EMAIL_RE.test(raw) ? raw : "";
};

/** The first word of a name, for "Hello Hassan". A one-word name is its own first word; nothing is "there". */
const firstNameOf = (name) => text(name, 120).split(/\s+/)[0] || "";

/**
 * Fill a template. An UNKNOWN placeholder is left exactly as it was written, on purpose: a person proof-reading sees
 * `{{customer.trn}}` still sitting there and fixes it, where quietly deleting it would send a sentence with a hole.
 * A KNOWN placeholder with nothing behind it becomes empty, because that is the honest answer.
 */
function fill(template, values = {}) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (whole, key) =>
    PLACEHOLDER_KEYS.includes(key) ? text(values[key], 300) : whole
  );
}

/** The values a template can draw on, from whatever the message is about. */
function valuesFor({ contact = {}, customer = {}, deal = {}, sender = {}, company = "" } = {}) {
  const name = text(contact.name, 120);
  return {
    "contact.name": name,
    "contact.firstName": firstNameOf(name),
    "company.name": text(customer.customerName || customer.name || contact.company, 150),
    "deal.title": text(deal.title, 150),
    "deal.value": deal.value === undefined || deal.value === null || deal.value === "" ? "" : String(deal.value),
    "sender.name": text(sender.name, 120),
    "sender.company": text(company, 150),
  };
}

/** Which placeholders a template uses that we cannot fill - what the editor warns about before it is saved. */
const unknownIn = (template) =>
  [...new Set([...String(template ?? "").matchAll(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g)].map((m) => m[1]))].filter((k) => !PLACEHOLDER_KEYS.includes(k));

const err = (errors) => (field, code, message) => errors.push({ field, code, message });

/** What will not be sent. The server refuses the same things; the form only says so sooner. */
function validateEmail(input = {}) {
  const errors = [];
  const add = err(errors);

  const to = (Array.isArray(input.to) ? input.to : []).map(addressOf).filter(Boolean);
  const asked = (Array.isArray(input.to) ? input.to : []).length;
  if (!asked) add("to", "EMAIL_TO_REQUIRED", "Say who it goes to");
  else if (!to.length) add("to", "EMAIL_TO_INVALID", "None of those is an email address");
  else if (to.length !== asked) add("to", "EMAIL_TO_INVALID", "One of those is not an email address");
  else if (to.length > MAX_RECIPIENTS) add("to", "EMAIL_TOO_MANY", `An email from here goes to at most ${MAX_RECIPIENTS} people. More than that is a campaign, which this is not.`);

  if (!text(input.subject, MAX_SUBJECT)) add("subject", "EMAIL_SUBJECT_REQUIRED", "Give the email a subject");
  if (!text(input.body, MAX_BODY)) add("body", "EMAIL_BODY_REQUIRED", "Write something to send");
  else if (String(input.body).length > MAX_BODY) add("body", "EMAIL_BODY_TOO_LONG", "That message is too long to send from here");

  const cc = (Array.isArray(input.cc) ? input.cc : []).filter(Boolean);
  if (cc.length && cc.some((a) => !addressOf(a))) add("cc", "EMAIL_CC_INVALID", "One of the copied addresses is not an email address");
  return errors;
}

/** The message as it will be stored and sent: addresses cleaned, the signature added once. */
function buildMessage(input = {}, { values = {}, signature = "" } = {}) {
  const subject = fill(text(input.subject, MAX_SUBJECT), values);
  const filled = fill(text(input.body, MAX_BODY), values);
  const body = signature && !filled.includes(signature) ? `${filled}\n\n${signature}` : filled;
  return {
    to: [...new Set((Array.isArray(input.to) ? input.to : []).map(addressOf).filter(Boolean))],
    cc: [...new Set((Array.isArray(input.cc) ? input.cc : []).map(addressOf).filter(Boolean))],
    subject,
    body,
  };
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The HTML of the message. The body a person typed is ESCAPED, never passed through: a subject or a sentence is text,
 * and letting markup into it would make every email a place to put a script or a disguised link.
 */
const htmlOf = (body) =>
  `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1c1d21">${String(body ?? "")
    .split("\n")
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p>&nbsp;</p>"))
    .join("")}</div>`;

// ---- templates -----------------------------------------------------------------------------------------------

/** A template is a name, a subject and a body. Nothing else: the moment it has rules it becomes a campaign tool. */
function validateTemplates(list) {
  const errors = [];
  const add = err(errors);
  if (!Array.isArray(list)) {
    add("templates", "TEMPLATES_INVALID", "Templates must be a list");
    return errors;
  }
  if (list.length > MAX_TEMPLATES) add("templates", "TEMPLATES_TOO_MANY", `${MAX_TEMPLATES} templates is as many as a list can be read in`);
  const names = new Set();
  list.forEach((t, i) => {
    const name = text(t?.name, 80);
    if (!name) add(`templates.${i}.name`, "TEMPLATE_NAME_REQUIRED", "Give the template a name");
    else if (names.has(name.toLowerCase())) add(`templates.${i}.name`, "TEMPLATE_NAME_DUPLICATE", `Two templates cannot both be called "${name}"`);
    names.add(name.toLowerCase());
    if (!text(t?.subject, MAX_SUBJECT)) add(`templates.${i}.subject`, "TEMPLATE_SUBJECT_REQUIRED", "Give the template a subject");
    if (!text(t?.body, MAX_BODY)) add(`templates.${i}.body`, "TEMPLATE_BODY_REQUIRED", "Write the template's message");
  });
  return errors;
}

const normaliseTemplates = (list) =>
  (Array.isArray(list) ? list : []).slice(0, MAX_TEMPLATES).map((t) => ({
    key: text(t?.key, 40) || text(t?.name, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "template",
    name: text(t?.name, 80),
    subject: text(t?.subject, MAX_SUBJECT),
    body: text(t?.body, MAX_BODY),
  }));

/** What a new organisation starts with: the three emails a salesperson actually writes, in plain words. */
const STARTER_TEMPLATES = [
  {
    key: "after-a-call",
    name: "After a call",
    subject: "Following up on our call",
    body: "Hello {{contact.firstName}},\n\nThank you for your time today. I have noted what you need and will come back to you with a price.\n\nIf anything has changed in the meantime, just reply to this email.",
  },
  {
    key: "sending-a-quotation",
    name: "Sending a quotation",
    subject: "Our quotation for {{deal.title}}",
    body: "Hello {{contact.firstName}},\n\nPlease find our quotation for {{deal.title}} attached to the message that follows, or let me know if you would rather I resend it.\n\nI am happy to go through it line by line if that would help.",
  },
  {
    key: "checking-in",
    name: "Checking in",
    subject: "Still happy to help",
    body: "Hello {{contact.firstName}},\n\nI wanted to check whether you had any questions about what we discussed. There is no rush, and I would rather you had the answers than felt chased.\n\nIf the timing is wrong, tell me when to come back.",
  },
];

module.exports = {
  MAX_RECIPIENTS, MAX_SUBJECT, MAX_BODY, MAX_TEMPLATES, PLACEHOLDERS, PLACEHOLDER_KEYS, STARTER_TEMPLATES,
  addressOf, firstNameOf, fill, valuesFor, unknownIn,
  validateEmail, buildMessage, htmlOf, escapeHtml,
  validateTemplates, normaliseTemplates,
};
