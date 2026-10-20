// Pure rules for the CRM module: what a lead, a deal, a follow-up and a pipeline stage may be, and - the part that
// matters - what the automation does when something happens. No Mongoose, no tenant scope, no clock of its own: every
// function that needs "today" is given it as a "YYYY-MM-DD" day in the organisation's own zone, the way
// utils/processOrders.js and utils/documentExpiry.js already work. See services/crm/* for where these are applied and
// services/crm/crmHooks.js for the one caller that the documents themselves drive.
//
// The design rule behind the whole module: a deal is NOT dragged from one stage to the next. It moves because a real
// document moved (a quotation was sent, an invoice was approved), and every move is claimed once and recorded with the
// document that caused it, so a document later rejected, cancelled or deleted takes its move back. That is why
// `planAdvance` and `planUndo` are two halves of one table and why `moveKey` exists.
const { addDays, isRealDay } = require("./tz");

// ---- what things may be -------------------------------------------------------------------------------------------

const LEAD_STATUS = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"];
const LEAD_SOURCES = ["walk_in", "phone", "whatsapp", "email", "website", "referral", "exhibition", "repeat", "other"];
const ACTIVITY_KINDS = ["call", "visit", "meeting", "whatsapp", "email", "note", "task"];
const ACTIVITY_STATUS = ["OPEN", "DONE", "CANCELLED"];
const OUTCOMES = ["spoke", "no_answer", "interested", "not_interested", "quoted", "follow_up", "done"];
const LOST_REASONS = ["price", "competitor", "no_budget", "no_response", "not_needed", "timing", "other"];
const OPPORTUNITY_STATUS = ["OPEN", "WON", "LOST"];
const STAGE_TYPES = ["open", "won", "lost"];
const ASSIGNMENT_MODES = ["round_robin", "creator", "fixed"];
// What a follow-up or a logged call can be ABOUT. "contact" is a person (models/modules/crm/contactModel.js):
// a call belongs to whoever you actually spoke to, which is not always the deal.
const REGARDING_KINDS = ["lead", "opportunity", "customer", "contact"];

// The events the automation can actually be told about. Each one is a document changing state somewhere else in the
// product; nothing here is invented or scheduled. `order_confirmed` is deliberately absent: a TradeOrder being
// confirmed posts nothing and has no hook yet, so offering it as a trigger would promise a move that never comes.
const EVENTS = ["quotation_sent", "quotation_accepted", "invoice_approved"];

const SOURCE_LABEL = {
  walk_in: "Walk-in", phone: "Phone", whatsapp: "WhatsApp", email: "Email", website: "Website",
  referral: "Referral", exhibition: "Exhibition", repeat: "Repeat customer", other: "Other",
};
const KIND_LABEL = {
  call: "Call", visit: "Visit", meeting: "Meeting", whatsapp: "WhatsApp", email: "Email", note: "Note", task: "Task",
};
const LOST_LABEL = {
  price: "Price too high", competitor: "Went to a competitor", no_budget: "No budget", no_response: "No response",
  not_needed: "Not needed", timing: "Wrong time", other: "Other",
};
const EVENT_LABEL = {
  quotation_sent: "A quotation was sent",
  quotation_accepted: "The customer accepted the quotation",
  invoice_approved: "The invoice was approved",
};

// The pipeline every organisation starts with. Each stage says what advances a deal INTO it (`advanceOn`), how soon
// the next follow-up falls due once a deal is in it (`followUpDays`) and after how long with nothing happening it is
// called stale. It is a master the customer may change, not a constant: see services/crm/crmSetupService.js.
const STARTER_STAGES = [
  { key: "new", name: "New", order: 1, probability: 10, advanceOn: null, followUpDays: 1, staleDays: 7, type: "open" },
  { key: "qualified", name: "Qualified", order: 2, probability: 25, advanceOn: null, followUpDays: 2, staleDays: 10, type: "open" },
  { key: "quoted", name: "Quotation sent", order: 3, probability: 50, advanceOn: "quotation_sent", followUpDays: 3, staleDays: 14, type: "open" },
  { key: "accepted", name: "Offer accepted", order: 4, probability: 90, advanceOn: "quotation_accepted", followUpDays: 2, staleDays: 7, type: "open" },
  { key: "won", name: "Won", order: 5, probability: 100, advanceOn: "invoice_approved", followUpDays: 0, staleDays: 0, type: "won" },
  { key: "lost", name: "Lost", order: 6, probability: 0, advanceOn: null, followUpDays: 0, staleDays: 0, type: "lost" },
];

const DEFAULT_SETTINGS = {
  autoAdvance: true, // a document moves the deal by itself
  autoFollowUp: true, // entering a stage leaves a next action behind
  assignmentMode: "round_robin",
  fixedOwnerId: null,
  uncontactedHours: 24, // a new lead nobody has touched after this is reported
  staleDays: 14, // the fallback when a stage names none
  quotationExpiryDays: 3, // how many days before a sent quotation lapses we say so
};

// ---- coercion: a request body is not to be trusted ----------------------------------------------------------------
// The security sweep posts `{ name: { $ne: "x" }, status: ["a"], id: 5 }` at every route and requires a clean 4xx, so
// nothing but a real string may ever reach a query. An object, an array or null reads as empty, never as itself.

// A BSON ObjectId is the one object that may speak for itself: it comes from our own database, never from a request
// body (JSON cannot carry `_bsontype`), and the services pass stored ids around as they are.
const isObjectId = (v) => Boolean(v) && typeof v === "object" && (v._bsontype === "ObjectId" || v._bsontype === "ObjectID");

const text = (v, max = 200) => {
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isObjectId(v)) return String(v);
  return "";
};
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
};
const day = (v) => {
  const s = text(v, 10);
  return isRealDay(s) ? s : null;
};
const oneOf = (v, list) => (list.includes(text(v, 40)) ? text(v, 40) : null);
const isId = (v) => isObjectId(v) || /^[0-9a-fA-F]{24}$/.test(text(v, 24));

// ---- validation ---------------------------------------------------------------------------------------------------

const err = (errors) => (field, code, message) => errors.push({ field, code, message });

/** A lead needs somebody to call and a word about where it came from; everything else is optional. */
function validateLead(input = {}, { partial = false } = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);

  if (!partial || has("name")) {
    if (!text(input.name, 150)) add("name", "LEAD_NAME_REQUIRED", "Give the person or company a name");
  }
  if (!partial || has("phone") || has("email")) {
    const phone = text(input.phone, 40);
    const email = text(input.email, 150);
    if (!partial && !phone && !email) add("phone", "LEAD_CONTACT_REQUIRED", "A lead needs a phone number or an email address");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) add("email", "LEAD_EMAIL_INVALID", "That email address does not look right");
  }
  if (has("source") && text(input.source, 40) && !oneOf(input.source, LEAD_SOURCES)) {
    add("source", "LEAD_SOURCE_INVALID", "That is not one of the lead sources");
  }
  if (has("status") && text(input.status, 40) && !oneOf(input.status, LEAD_STATUS)) {
    add("status", "LEAD_STATUS_INVALID", "That is not a lead status");
  }
  if (has("expectedValue") && num(input.expectedValue) < 0) add("expectedValue", "LEAD_VALUE_NEGATIVE", "An expected value cannot be less than nothing");
  if (has("ownerId") && text(input.ownerId, 24) && !isId(input.ownerId)) add("ownerId", "LEAD_OWNER_INVALID", "That is not a person in this organisation");
  return errors;
}

/**
 * A person. The only thing that is really required is a name - a contact is often captured from a business card
 * long before anybody knows their email address.
 *
 * A contact that belongs to a party is stored twice on purpose: once here and once in the party's own
 * `contacts[]` array, under the SAME _id (see services/crm/contactService.js). So `customerId` and `vendorId`
 * are mutually exclusive - a person works for one of them, and letting both be set would make the mirror
 * ambiguous about which array owns the row.
 */
function validateContact(input = {}, { partial = false } = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);

  if (!partial || has("name")) {
    if (!text(input.name, 100)) add("name", "CONTACT_NAME_REQUIRED", "Give the person a name");
  }
  if (has("email")) {
    const email = text(input.email, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) add("email", "CONTACT_EMAIL_INVALID", "That email address does not look right");
  }
  if (has("customerId") && text(input.customerId, 24) && !isId(input.customerId)) {
    add("customerId", "CONTACT_CUSTOMER_INVALID", "That is not a customer");
  }
  if (has("vendorId") && text(input.vendorId, 24) && !isId(input.vendorId)) {
    add("vendorId", "CONTACT_VENDOR_INVALID", "That is not a supplier");
  }
  if (has("leadId") && text(input.leadId, 24) && !isId(input.leadId)) {
    add("leadId", "CONTACT_LEAD_INVALID", "That is not an enquiry");
  }
  if (isId(input.customerId) && isId(input.vendorId)) {
    add("vendorId", "CONTACT_TWO_PARTIES", "A person belongs to a customer or to a supplier, not to both");
  }
  return errors;
}

/** A deal belongs to a customer, sits on a stage and is worth something. */
function validateOpportunity(input = {}, { stages = [], partial = false } = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);
  const keys = stages.map((s) => s.key);

  if (!partial || has("title")) {
    if (!text(input.title, 150)) add("title", "OPPORTUNITY_TITLE_REQUIRED", "Give the deal a name");
  }
  if (!partial || has("customerId")) {
    if (!isId(input.customerId)) add("customerId", "OPPORTUNITY_CUSTOMER_REQUIRED", "Choose the customer this deal is with");
  }
  if (has("stageKey") && text(input.stageKey, 40) && keys.length && !keys.includes(text(input.stageKey, 40))) {
    add("stageKey", "STAGE_NOT_FOUND", "That stage is not in this organisation's pipeline");
  }
  if (has("value") && num(input.value) < 0) add("value", "OPPORTUNITY_VALUE_NEGATIVE", "A deal cannot be worth less than nothing");
  if (has("expectedCloseDate") && text(input.expectedCloseDate, 10) && !day(input.expectedCloseDate)) {
    add("expectedCloseDate", "OPPORTUNITY_DATE_INVALID", "That is not a date");
  }
  if (has("ownerId") && text(input.ownerId, 24) && !isId(input.ownerId)) add("ownerId", "OPPORTUNITY_OWNER_INVALID", "That is not a person in this organisation");
  return errors;
}

/** A follow-up is a kind of contact, about something, due on a day. */
function validateActivity(input = {}, { partial = false } = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);

  if (!partial || has("kind")) {
    if (!oneOf(input.kind, ACTIVITY_KINDS)) add("kind", "ACTIVITY_KIND_INVALID", "Choose a call, visit, meeting, message, email, note or task");
  }
  if (!partial || has("subject")) {
    if (!text(input.subject, 200)) add("subject", "ACTIVITY_SUBJECT_REQUIRED", "Say what this follow-up is about");
  }
  if (!partial || has("regarding")) {
    const kind = oneOf(input.regarding?.kind, REGARDING_KINDS);
    if (!kind) add("regarding.kind", "ACTIVITY_REGARDING_INVALID", "A follow-up must be about a lead, a deal or a customer");
    else if (!isId(input.regarding?.id)) add("regarding.id", "ACTIVITY_REGARDING_INVALID", "A follow-up must be about a lead, a deal or a customer");
  }
  if (has("dueAt") && text(input.dueAt, 10) && !day(input.dueAt)) add("dueAt", "ACTIVITY_DUE_INVALID", "That is not a date");
  if (has("outcome") && text(input.outcome, 40) && !oneOf(input.outcome, OUTCOMES)) add("outcome", "ACTIVITY_OUTCOME_INVALID", "That is not an outcome");
  if (has("ownerId") && text(input.ownerId, 24) && !isId(input.ownerId)) add("ownerId", "ACTIVITY_OWNER_INVALID", "That is not a person in this organisation");
  return errors;
}

/** The pipeline itself: it must stay a pipeline, or the automation has nowhere to send a deal. */
function validateStages(list) {
  const errors = [];
  const add = err(errors);
  if (!Array.isArray(list) || list.length === 0) {
    add("stages", "STAGES_REQUIRED", "A pipeline needs at least one stage");
    return errors;
  }
  if (list.length > 12) add("stages", "STAGES_TOO_MANY", "Twelve stages is as many as a pipeline can be read in");

  const keys = new Set();
  const advances = new Set();
  let won = 0;
  let lost = 0;
  list.forEach((raw, i) => {
    const s = raw || {};
    const key = text(s.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!key) add(`stages.${i}.key`, "STAGE_KEY_REQUIRED", "Every stage needs a short key");
    else if (keys.has(key)) add(`stages.${i}.key`, "STAGE_KEY_DUPLICATE", `Two stages cannot both be "${key}"`);
    keys.add(key);
    if (!text(s.name, 60)) add(`stages.${i}.name`, "STAGE_NAME_REQUIRED", "Every stage needs a name");
    const p = num(s.probability);
    if (p < 0 || p > 100) add(`stages.${i}.probability`, "STAGE_PROBABILITY_RANGE", "A chance of closing is between 0 and 100");
    const type = oneOf(s.type, STAGE_TYPES) || "open";
    if (type === "won") won += 1;
    if (type === "lost") lost += 1;
    if (s.advanceOn !== null && s.advanceOn !== undefined && text(s.advanceOn, 40) !== "") {
      const on = oneOf(s.advanceOn, EVENTS);
      if (!on) add(`stages.${i}.advanceOn`, "STAGE_EVENT_INVALID", "That is not something the system can notice happening");
      else if (advances.has(on)) add(`stages.${i}.advanceOn`, "STAGE_EVENT_DUPLICATE", "Two stages cannot both answer the same event");
      else advances.add(on);
    }
    if (num(s.followUpDays) < 0 || num(s.followUpDays) > 365) add(`stages.${i}.followUpDays`, "STAGE_FOLLOWUP_RANGE", "Follow-up days are between 0 and 365");
    if (num(s.staleDays) < 0 || num(s.staleDays) > 365) add(`stages.${i}.staleDays`, "STAGE_STALE_RANGE", "Stale days are between 0 and 365");
  });
  if (won !== 1) add("stages", "STAGE_WON_REQUIRED", "Exactly one stage must be the won one");
  if (lost !== 1) add("stages", "STAGE_LOST_REQUIRED", "Exactly one stage must be the lost one");
  return errors;
}

/** Stages as they are stored: coerced, ordered from 1, keys cleaned. */
function normaliseStages(list) {
  return (Array.isArray(list) ? list : [])
    .map((raw, i) => {
      const s = raw || {};
      const type = oneOf(s.type, STAGE_TYPES) || "open";
      const advanceOn = oneOf(s.advanceOn, EVENTS);
      return {
        key: text(s.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "") || `stage-${i + 1}`,
        name: text(s.name, 60),
        order: num(s.order) || i + 1,
        probability: Math.max(0, Math.min(100, Math.round(num(s.probability)))),
        advanceOn: advanceOn || null,
        followUpDays: Math.max(0, Math.min(365, Math.round(num(s.followUpDays)))),
        staleDays: Math.max(0, Math.min(365, Math.round(num(s.staleDays)))),
        type,
      };
    })
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((s, i) => ({ ...s, order: i + 1 }));
}

function validateSettings(input = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);
  if (has("assignmentMode") && !oneOf(input.assignmentMode, ASSIGNMENT_MODES)) {
    add("assignmentMode", "ASSIGNMENT_MODE_INVALID", "Choose round robin, the person who entered it, or one fixed person");
  }
  if (oneOf(input.assignmentMode, ASSIGNMENT_MODES) === "fixed" && !isId(input.fixedOwnerId)) {
    add("fixedOwnerId", "ASSIGNMENT_OWNER_REQUIRED", "Name the person every new lead should go to");
  }
  if (has("uncontactedHours") && (num(input.uncontactedHours) < 1 || num(input.uncontactedHours) > 720)) {
    add("uncontactedHours", "SETTING_RANGE", "Between 1 and 720 hours");
  }
  if (has("staleDays") && (num(input.staleDays) < 1 || num(input.staleDays) > 365)) add("staleDays", "SETTING_RANGE", "Between 1 and 365 days");
  if (has("quotationExpiryDays") && (num(input.quotationExpiryDays) < 0 || num(input.quotationExpiryDays) > 60)) {
    add("quotationExpiryDays", "SETTING_RANGE", "Between 0 and 60 days");
  }
  return errors;
}

function normaliseSettings(input = {}) {
  const mode = oneOf(input.assignmentMode, ASSIGNMENT_MODES) || DEFAULT_SETTINGS.assignmentMode;
  const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
  const within = (v, lo, hi, fallback) => {
    const n = Math.round(num(v));
    return n >= lo && n <= hi ? n : fallback;
  };
  return {
    autoAdvance: bool(input.autoAdvance, DEFAULT_SETTINGS.autoAdvance),
    autoFollowUp: bool(input.autoFollowUp, DEFAULT_SETTINGS.autoFollowUp),
    assignmentMode: mode,
    fixedOwnerId: mode === "fixed" && isId(input.fixedOwnerId) ? text(input.fixedOwnerId, 24) : null,
    uncontactedHours: within(input.uncontactedHours, 1, 720, DEFAULT_SETTINGS.uncontactedHours),
    staleDays: within(input.staleDays, 1, 365, DEFAULT_SETTINGS.staleDays),
    quotationExpiryDays: within(input.quotationExpiryDays, 0, 60, DEFAULT_SETTINGS.quotationExpiryDays),
  };
}

// ---- who gets it --------------------------------------------------------------------------------------------------

/**
 * Who a new lead goes to. Round robin walks the candidate list in a fixed order, starting after whoever got the last
 * one, so a list that changes does not restart at the top; an unknown `lastOwnerId` simply starts at the beginning.
 * Returns null when there is nobody to give it to, which is not an error - the lead is simply unassigned.
 */
function assignOwner({ candidates = [], lastOwnerId = null, settings = DEFAULT_SETTINGS, createdBy = null } = {}) {
  const ids = (Array.isArray(candidates) ? candidates : []).map((c) => text(c?.id ?? c, 24)).filter(isId);
  const mode = oneOf(settings?.assignmentMode, ASSIGNMENT_MODES) || "round_robin";
  if (mode === "creator") return isId(createdBy) ? text(createdBy, 24) : ids[0] || null;
  if (mode === "fixed") {
    const fixed = text(settings?.fixedOwnerId, 24);
    if (isId(fixed) && ids.includes(fixed)) return fixed;
    return ids[0] || null;
  }
  if (!ids.length) return null;
  const last = text(lastOwnerId, 24);
  const at = ids.indexOf(last);
  return ids[(at + 1) % ids.length];
}

/**
 * How warm a lead is, 0-100, from what is actually known about it: where it came from, what it may be worth, how much
 * contact there has been, and how long since anything happened. Deterministic and explainable on purpose - nobody can
 * act on a score they cannot account for, and a test can pin every band.
 */
function leadScore(lead = {}, today = null) {
  const sourceWeight = {
    referral: 25, repeat: 25, exhibition: 20, website: 15, whatsapp: 15, phone: 15, walk_in: 15, email: 10, other: 5,
  };
  const source = oneOf(lead.source, LEAD_SOURCES) || "other";
  let score = sourceWeight[source] ?? 5;

  const value = num(lead.expectedValue);
  if (value >= 100000) score += 30;
  else if (value >= 25000) score += 22;
  else if (value >= 5000) score += 14;
  else if (value > 0) score += 7;

  const contacts = Math.max(0, Math.round(num(lead.contactCount)));
  score += Math.min(25, contacts * 8);

  if (oneOf(lead.status, LEAD_STATUS) === "QUALIFIED") score += 15;
  if (oneOf(lead.status, LEAD_STATUS) === "CONTACTED") score += 5;

  const last = day(lead.lastActivityDay);
  if (today && last) {
    const idle = diffDays(last, today);
    if (idle >= 30) score -= 25;
    else if (idle >= 14) score -= 15;
    else if (idle >= 7) score -= 7;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
  return { score, band };
}

// ---- the automation ------------------------------------------------------------------------------------------------

/** The one key an automatic move is claimed under: one move per deal, per event, per document that caused it. */
const moveKey = (event, documentId) => `${oneOf(event, EVENTS) || "unknown"}:${text(documentId, 24)}`;

const stageByKey = (stages, key) => (stages || []).find((s) => s.key === key) || null;
const stageFor = (stages, event) => (stages || []).find((s) => s.advanceOn === oneOf(event, EVENTS)) || null;
const orderOf = (stages, key) => {
  const s = stageByKey(stages, key);
  return s ? s.order : 0;
};

/**
 * Where an event sends a deal, or null for "nowhere". Never backwards (a quotation sent on a deal the customer has
 * already accepted does not undo the acceptance), never out of a closed stage, and never twice for the same document:
 * the caller claims `key` before applying this, so a retried transaction cannot double-apply it.
 */
function planAdvance({ opportunity = {}, stages = [], event, documentId, settings = DEFAULT_SETTINGS } = {}) {
  if (settings && settings.autoAdvance === false) return null;
  const on = oneOf(event, EVENTS);
  if (!on) return null;
  if (oneOf(opportunity.status, OPPORTUNITY_STATUS) !== "OPEN") return null;

  const target = stageFor(stages, on);
  if (!target) return null;

  const current = stageByKey(stages, text(opportunity.stageKey, 40));
  if (current && current.type !== "open") return null;
  if (current && target.order <= current.order) return null;

  const key = moveKey(on, documentId);
  if ((opportunity.autoMoves || []).some((m) => m && m.key === key)) return null;

  return {
    key,
    stageKey: target.key,
    stageName: target.name,
    probability: target.probability,
    status: target.type === "won" ? "WON" : target.type === "lost" ? "LOST" : "OPEN",
    from: current ? current.key : null,
    event: on,
    reason: EVENT_LABEL[on],
  };
}

/**
 * Taking a move back, because the document that caused it was rejected, cancelled or deleted. The deal returns to the
 * stage it was on BEFORE that move (recorded on the move itself), not to the beginning, and only if this deal's
 * current stage is still the one that move put it on - if something else has since moved it on, the later truth wins
 * and the undo is only forgotten, never applied. Mirrors `releaseQuotationsFor` in deliveryNoteLinks.js, which puts an
 * accepted quotation back rather than throwing it away.
 */
function planUndo({ opportunity = {}, stages = [], event, documentId } = {}) {
  const key = moveKey(event, documentId);
  const move = (opportunity.autoMoves || []).find((m) => m && m.key === key);
  if (!move) return null;
  if (text(opportunity.stageKey, 40) !== text(move.to, 40)) return { key, stageKey: null, forget: true };

  const back = stageByKey(stages, text(move.from, 40));
  const fallback = (stages || []).filter((s) => s.type === "open").sort((a, b) => a.order - b.order)[0] || null;
  const to = back && back.type === "open" ? back : fallback;
  if (!to) return { key, stageKey: null, forget: true };
  return {
    key,
    stageKey: to.key,
    stageName: to.name,
    probability: to.probability,
    status: "OPEN",
    forget: false,
    reason: `${EVENT_LABEL[oneOf(event, EVENTS)] || "The document"} was undone`,
  };
}

/**
 * The next action a deal is left with when it enters a stage: nothing in this product should ever sit with no next
 * step. Returns null when the stage asks for none (a won or lost deal), when the setting is off, or when there is
 * already an open follow-up - we never pile two reminders on one deal.
 */
function planFollowUp({ opportunity = {}, stage = null, openActivities = [], settings = DEFAULT_SETTINGS, today = null, ownerId = null } = {}) {
  if (settings && settings.autoFollowUp === false) return null;
  if (!stage || stage.type !== "open") return null;
  if ((openActivities || []).length > 0) return null;
  if (!today || !isRealDay(today)) return null;
  const days = Math.max(0, Math.round(num(stage.followUpDays)));
  if (!days && days !== 0) return null;
  const title = text(opportunity.title, 150) || "this deal";
  return {
    kind: "call",
    subject: `Follow up: ${stage.name} - ${title}`,
    dueAt: addDays(today, days),
    ownerId: isId(ownerId) ? text(ownerId, 24) : isId(opportunity.ownerId) ? text(opportunity.ownerId, 24) : null,
    auto: true,
  };
}

// ---- derived state the screens and the checks share ---------------------------------------------------------------

/** Whole days from `from` to `to`, both "YYYY-MM-DD". Negative when `to` is earlier. */
function diffDays(from, to) {
  const a = day(from);
  const b = day(to);
  if (!a || !b) return 0;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** How a follow-up stands against today. A day-only comparison: a thing due today is due, not late. */
function dueState(activity = {}, today = null) {
  if (oneOf(activity.status, ACTIVITY_STATUS) === "DONE") return "done";
  if (oneOf(activity.status, ACTIVITY_STATUS) === "CANCELLED") return "cancelled";
  const due = day(activity.dueAt);
  if (!due || !today) return "later";
  const left = diffDays(today, due);
  if (left < 0) return "overdue";
  if (left === 0) return "today";
  if (left <= 7) return "soon";
  return "later";
}

/** A deal nothing has happened to for too long. The stage's own `staleDays`, else the organisation's setting. */
function staleOf(opportunity = {}, settings = DEFAULT_SETTINGS, stages = [], today = null) {
  const status = oneOf(opportunity.status, OPPORTUNITY_STATUS) || "OPEN";
  const stage = stageByKey(stages, text(opportunity.stageKey, 40));
  const limit = Math.max(0, Math.round(num(stage?.staleDays) || num(settings?.staleDays) || 0));
  const last = day(opportunity.lastActivityDay) || day(opportunity.stageSinceDay);
  if (status !== "OPEN" || !limit || !last || !today) return { days: 0, isStale: false, limit };
  const idle = Math.max(0, diffDays(last, today));
  return { days: idle, isStale: idle >= limit, limit };
}

/** What the pipeline is worth: the plain total, and the total weighted by each stage's chance of closing. */
function weightedValue(opportunities = [], stages = []) {
  let value = 0;
  let weighted = 0;
  for (const o of opportunities || []) {
    if ((oneOf(o?.status, OPPORTUNITY_STATUS) || "OPEN") !== "OPEN") continue;
    const v = num(o?.value);
    const stage = stageByKey(stages, text(o?.stageKey, 40));
    const p = stage ? num(stage.probability) : num(o?.probability);
    value += v;
    weighted += (v * p) / 100;
  }
  return { value: round2(value), weighted: round2(weighted) };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Every stage with what sits on it, in pipeline order - the board, and the funnel in the analysis. */
function funnel(stages = [], opportunities = []) {
  const byKey = new Map((stages || []).map((s) => [s.key, { ...s, count: 0, value: 0, weighted: 0 }]));
  for (const o of opportunities || []) {
    const row = byKey.get(text(o?.stageKey, 40));
    if (!row) continue;
    row.count += 1;
    row.value = round2(row.value + num(o?.value));
    row.weighted = round2(row.weighted + (num(o?.value) * num(row.probability)) / 100);
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order);
}

/**
 * The CRM's own report: what came in, what was done with it, and how well. A rate with nothing to measure is null,
 * never 0 - the same rule as the production analysis - so an empty month does not read as a total failure.
 */
function analysis({ leads = [], opportunities = [], activities = [], stages = [], today = null } = {}) {
  const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
  const openOf = (o) => (oneOf(o?.status, OPPORTUNITY_STATUS) || "OPEN") === "OPEN";

  const bySource = new Map();
  for (const l of leads || []) {
    const key = oneOf(l?.source, LEAD_SOURCES) || "other";
    const row = bySource.get(key) || { source: key, label: SOURCE_LABEL[key], leads: 0, converted: 0, lost: 0, value: 0 };
    row.leads += 1;
    if (oneOf(l?.status, LEAD_STATUS) === "CONVERTED") row.converted += 1;
    if (oneOf(l?.status, LEAD_STATUS) === "LOST") row.lost += 1;
    row.value = round2(row.value + num(l?.expectedValue));
    bySource.set(key, row);
  }
  for (const row of bySource.values()) row.conversionRate = rate(row.converted, row.leads);

  const byOwner = new Map();
  const ownerRow = (id, name) => {
    const key = text(id, 24) || "unassigned";
    if (!byOwner.has(key)) byOwner.set(key, { ownerId: key === "unassigned" ? null : key, name: name || "Unassigned", leads: 0, deals: 0, won: 0, lost: 0, wonValue: 0, activities: 0 });
    return byOwner.get(key);
  };
  for (const l of leads || []) ownerRow(l?.ownerId, l?.ownerName).leads += 1;
  for (const o of opportunities || []) {
    const row = ownerRow(o?.ownerId, o?.ownerName);
    row.deals += 1;
    if (oneOf(o?.status, OPPORTUNITY_STATUS) === "WON") {
      row.won += 1;
      row.wonValue = round2(row.wonValue + num(o?.value));
    }
    if (oneOf(o?.status, OPPORTUNITY_STATUS) === "LOST") row.lost += 1;
  }
  for (const a of activities || []) if (oneOf(a?.status, ACTIVITY_STATUS) === "DONE") ownerRow(a?.ownerId, a?.ownerName).activities += 1;
  for (const row of byOwner.values()) row.winRate = rate(row.won, row.won + row.lost);

  const lostReasons = new Map();
  for (const o of opportunities || []) {
    if (oneOf(o?.status, OPPORTUNITY_STATUS) !== "LOST") continue;
    const key = oneOf(o?.lostReason, LOST_REASONS) || "other";
    const row = lostReasons.get(key) || { reason: key, label: LOST_LABEL[key], deals: 0, value: 0 };
    row.deals += 1;
    row.value = round2(row.value + num(o?.value));
    lostReasons.set(key, row);
  }

  const won = (opportunities || []).filter((o) => oneOf(o?.status, OPPORTUNITY_STATUS) === "WON");
  const lost = (opportunities || []).filter((o) => oneOf(o?.status, OPPORTUNITY_STATUS) === "LOST");
  const closeDays = won.map((o) => diffDays(day(o?.openedDay), day(o?.closedDay))).filter((d) => d >= 0);
  const open = (opportunities || []).filter(openOf);
  const totals = weightedValue(open, stages);

  return {
    leads: {
      total: (leads || []).length,
      converted: (leads || []).filter((l) => oneOf(l?.status, LEAD_STATUS) === "CONVERTED").length,
      lost: (leads || []).filter((l) => oneOf(l?.status, LEAD_STATUS) === "LOST").length,
      open: (leads || []).filter((l) => ["NEW", "CONTACTED", "QUALIFIED"].includes(oneOf(l?.status, LEAD_STATUS) || "NEW")).length,
      conversionRate: rate((leads || []).filter((l) => oneOf(l?.status, LEAD_STATUS) === "CONVERTED").length, (leads || []).length),
    },
    deals: {
      total: (opportunities || []).length,
      open: open.length,
      won: won.length,
      lost: lost.length,
      winRate: rate(won.length, won.length + lost.length),
      wonValue: round2(won.reduce((t, o) => t + num(o?.value), 0)),
      lostValue: round2(lost.reduce((t, o) => t + num(o?.value), 0)),
      openValue: totals.value,
      weightedValue: totals.weighted,
      averageDaysToWin: closeDays.length ? Math.round((closeDays.reduce((a, b) => a + b, 0) / closeDays.length) * 10) / 10 : null,
    },
    activity: {
      done: (activities || []).filter((a) => oneOf(a?.status, ACTIVITY_STATUS) === "DONE").length,
      open: (activities || []).filter((a) => (oneOf(a?.status, ACTIVITY_STATUS) || "OPEN") === "OPEN").length,
      overdue: (activities || []).filter((a) => dueState(a, today) === "overdue").length,
    },
    funnel: funnel(stages, open),
    bySource: [...bySource.values()].sort((a, b) => b.leads - a.leads),
    byOwner: [...byOwner.values()].sort((a, b) => b.wonValue - a.wonValue || b.deals - a.deals),
    lostReasons: [...lostReasons.values()].sort((a, b) => b.deals - a.deals),
  };
}

/** The day range a follow-up worklist shows. `overdue` has no start: a thing six months late is still late. */
function followUpRange(scope, today) {
  const t = day(today);
  if (!t) return { from: null, to: null };
  if (scope === "overdue") return { from: null, to: addDays(t, -1) };
  if (scope === "today") return { from: t, to: t };
  if (scope === "week") return { from: null, to: addDays(t, 7) };
  return { from: null, to: null };
}

module.exports = {
  LEAD_STATUS, LEAD_SOURCES, ACTIVITY_KINDS, ACTIVITY_STATUS, OUTCOMES, LOST_REASONS, OPPORTUNITY_STATUS,
  STAGE_TYPES, ASSIGNMENT_MODES, REGARDING_KINDS, EVENTS, SOURCE_LABEL, KIND_LABEL, LOST_LABEL, EVENT_LABEL,
  STARTER_STAGES, DEFAULT_SETTINGS,
  text, num, day, oneOf, isId, isObjectId,
  validateLead, validateOpportunity, validateActivity, validateContact, validateStages, validateSettings,
  normaliseStages, normaliseSettings,
  assignOwner, leadScore,
  moveKey, stageByKey, stageFor, orderOf, planAdvance, planUndo, planFollowUp,
  diffDays, dueState, staleOf, weightedValue, round2, funnel, analysis, followUpRange,
};
