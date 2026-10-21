// Reading a spreadsheet of enquiries and of people into the CRM: the rules, as plain functions with no Mongoose and no
// request, so every awkward cell is a test rather than a support call.
//
// The screen reads the file in the browser and maps its columns (lib/crmImport.js); what arrives here is rows of named
// fields, and this decides what each row IS: one to create, one that cannot be (and why, in words a person can act on),
// or one we already hold. Nothing is written here and nothing is guessed silently: a source we do not recognise becomes
// "Other" with the original word kept in the note, an owner we cannot find is a warning rather than a refusal, and a
// number that is not a number is an error on THAT row, not a failed import.
//
// Everything is coerced through `text` / `num` first: a request body is not to be trusted (the security sweep posts
// `{ name: { $ne: "x" } }` at every route and requires a clean answer), so an object or an array reads as empty.
const crm = require("./crm");

const { text, num, validateLead, validateContact, round2 } = crm;

/** Rows per request. A bigger file is sent in lots by the screen; each row is a few writes, so this keeps one call short. */
const MAX_ROWS = 200;

const norm = (s) => text(s, 120).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// What people write in a "Source" column, and the source each means. Anything else is "Other", with the word kept.
const SOURCE_WORDS = {
  walk_in: ["walk in", "walkin", "showroom", "shop", "visitor", "visit"],
  phone: ["phone", "call", "phone call", "telephone", "cold call", "inbound call", "mobile"],
  whatsapp: ["whatsapp", "whats app", "wa", "wapp"],
  email: ["email", "e mail", "mail"],
  website: ["website", "web", "web form", "website form", "online", "landing page", "contact form"],
  referral: ["referral", "referred", "reference", "word of mouth", "friend", "recommendation"],
  exhibition: ["exhibition", "expo", "trade show", "tradeshow", "fair", "event", "gulfood"],
  repeat: ["repeat", "repeat customer", "existing customer", "returning", "returning customer"],
  other: ["other"],
};
const SOURCE_LOOKUP = new Map();
for (const [source, words] of Object.entries(SOURCE_WORDS)) {
  SOURCE_LOOKUP.set(norm(source), source);
  for (const w of words) SOURCE_LOOKUP.set(norm(w), source);
}

/** `{ source, note }`: the lead source a cell means, and the original word when it means none of ours. */
function sourceFrom(raw) {
  const t = text(raw, 80);
  if (!t) return { source: "other", note: "" };
  const hit = SOURCE_LOOKUP.get(norm(t));
  return hit ? { source: hit, note: "" } : { source: "other", note: t };
}

/**
 * An amount as people type it: "12500", "AED 12,500.50", "12 500", "1,20,000" (lakh grouping), "12,50" (a comma for the
 * decimal). `{ ok: false }` for a cell with no number in it. A blank cell is nothing, which is zero - not an error.
 */
function moneyFrom(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? { ok: true, value: round2(raw) } : { ok: false, value: 0 };
  const t = text(raw, 40);
  if (!t) return { ok: true, value: 0 };
  let s = t.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(s)) return { ok: false, value: 0 };
  const negative = s.includes("-");
  s = s.replace(/-/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // both appear: whichever comes last is the decimal point
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    s = s.split(group).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    // "12,500" and "1,20,000" group thousands; "12,50" is a decimal comma (one comma, one or two digits after it)
    const after = s.length - lastComma - 1;
    s = s.split(",").length === 2 && after > 0 && after <= 2 ? s.replace(",", ".") : s.split(",").join("");
  } else if (s.split(".").length > 2) {
    s = s.split(".").join(""); // "1.234.567"
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return { ok: false, value: 0 };
  return { ok: true, value: round2(negative ? -value : value) };
}

/** The last eight digits of a phone number, which is what two spellings of one number have in common. "" when too short. */
function phoneTail(raw) {
  const digits = text(raw, 40).replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(-8) : "";
}

const rowOf = (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) && !crm.isObjectId(raw) ? raw : {});
// A file's first row is its header, so the first record is line 2: what a person looks for in their spreadsheet.
const lineOf = (raw, i) => {
  const n = Math.round(num(rowOf(raw).line));
  return n > 0 ? n : i + 2;
};
const tooMany = () => ({ code: "IMPORT_TOO_MANY", message: `Send at most ${MAX_ROWS} rows in one go` });
const noRows = () => ({ code: "IMPORT_ROWS_REQUIRED", message: "There are no rows to import" });
const issue = (field, code, message) => ({ field, code, message });

function tally(rows) {
  const by = (s) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, create: by("create"), invalid: by("invalid"), duplicate: by("duplicate"), skipped: by("skipped") };
}

/**
 * Decide each lead row. `existing` is what we already hold - `{ leads: { emails, phones }, customers: { emails, phones } }`,
 * each a Set (emails lower-case, phones as `phoneTail`) - and `owners` is `[{ id, name }]` for the Owner column.
 *
 * Statuses: `create` (will be made), `invalid` (a field is wrong: `errors`), `duplicate` (the same email or phone as an
 * earlier row, an existing lead or an existing customer: `duplicateOf`). With `allowDuplicates` a duplicate is created
 * anyway and keeps `duplicateOf` as information. A later row never claims an email or phone an earlier row was refused for.
 */
function planLeadImport(rows, { existing = {}, owners = [], allowDuplicates = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: noRows() };
  if (rows.length > MAX_ROWS) return { error: tooMany() };

  const ownerByName = new Map((Array.isArray(owners) ? owners : []).map((o) => [norm(o.name), o]));
  const seenEmail = new Map();
  const seenPhone = new Map();
  const hold = (kind, which, key) => existing?.[kind]?.[which]?.has?.(key) === true;

  const planned = rows.map((raw, i) => {
    const r = rowOf(raw);
    const line = lineOf(raw, i);
    const { source, note } = sourceFrom(r.source);
    const money = moneyFrom(r.expectedValue);
    const fields = {
      name: text(r.name, 150),
      company: text(r.company, 150),
      phone: text(r.phone, 40),
      email: text(r.email, 150).toLowerCase(),
      city: text(r.city, 80),
      source,
      sourceNote: text(r.sourceNote, 200) || note,
      interest: text(r.interest, 500),
      expectedValue: money.value,
      notes: text(r.notes, 2000),
    };
    const errors = validateLead(fields).map((e) => issue(e.field, e.code, e.message));
    if (!money.ok) errors.push(issue("expectedValue", "LEAD_VALUE_INVALID", "That is not an amount"));

    const warnings = [];
    const wanted = norm(r.owner);
    if (wanted) {
      const owner = ownerByName.get(wanted);
      if (owner) fields.ownerId = owner.id;
      else warnings.push(issue("owner", "OWNER_NOT_FOUND", `Nobody called "${text(r.owner, 60)}" can be given CRM work: it was handed out as usual`));
    }

    if (errors.length) return { line, status: "invalid", fields, errors, warnings };

    const tail = phoneTail(fields.phone);
    let duplicateOf = null;
    if (fields.email) {
      if (seenEmail.has(fields.email)) duplicateOf = { kind: "file", line: seenEmail.get(fields.email), by: "email" };
      else if (hold("leads", "emails", fields.email)) duplicateOf = { kind: "lead", by: "email" };
      else if (hold("customers", "emails", fields.email)) duplicateOf = { kind: "customer", by: "email" };
    }
    if (!duplicateOf && tail) {
      if (seenPhone.has(tail)) duplicateOf = { kind: "file", line: seenPhone.get(tail), by: "phone" };
      else if (hold("leads", "phones", tail)) duplicateOf = { kind: "lead", by: "phone" };
      else if (hold("customers", "phones", tail)) duplicateOf = { kind: "customer", by: "phone" };
    }

    if (duplicateOf && !allowDuplicates) return { line, status: "duplicate", fields, errors: [], warnings, duplicateOf };
    if (fields.email) seenEmail.set(fields.email, line);
    if (tail) seenPhone.set(tail, line);
    return { line, status: "create", fields, errors: [], warnings, ...(duplicateOf ? { duplicateOf } : {}) };
  });

  return { rows: planned, summary: tally(planned) };
}

const same = (s) => norm(s);

/**
 * Decide each contact row. `customers` is `[{ id, name }]` - the customers whose name some row names - and `existing` is
 * what we already hold (`{ emails, phones, names }`, Sets: `names` is "name|customerId"). A contact's company is matched
 * to a customer by name, ignoring case and spacing: one match links the person to that customer, no match leaves the
 * person unlinked with the company kept in the notes (a business card is captured long before anyone is a customer), and
 * two matches is an error, because linking to the wrong one is worse than not linking. `unmatched: "skip"` leaves a person
 * whose company is not a customer out altogether.
 */
function planContactImport(rows, { customers = [], existing = {}, unmatched = "import" } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: noRows() };
  if (rows.length > MAX_ROWS) return { error: tooMany() };

  const byName = new Map();
  for (const c of Array.isArray(customers) ? customers : []) {
    const key = same(c.name);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) || []), { id: text(c.id, 24), name: text(c.name, 150) }]);
  }
  const seenEmail = new Map();
  const seenPhone = new Map();
  const seenName = new Map();

  const planned = rows.map((raw, i) => {
    const r = rowOf(raw);
    const line = lineOf(raw, i);
    const company = text(r.company, 150);
    const fields = {
      name: text(r.name, 100),
      designation: text(r.designation, 100),
      email: text(r.email, 120).toLowerCase(),
      phone: text(r.phone, 30),
      notes: text(r.notes, 1000),
    };
    const errors = validateContact(fields).map((e) => issue(e.field, e.code, e.message));
    const warnings = [];

    let customer = null;
    if (company) {
      const found = byName.get(same(company)) || [];
      if (found.length === 1) customer = found[0];
      else if (found.length > 1) errors.push(issue("company", "CONTACT_COMPANY_AMBIGUOUS", `More than one customer is called "${company}": link this person by hand`));
      else if (unmatched === "skip") return { line, status: "skipped", fields, errors: [], warnings, reason: `"${company}" is not a customer` };
      else {
        const tag = `Company: ${company}`;
        if (!fields.notes.includes(tag)) fields.notes = fields.notes ? `${tag}. ${fields.notes}` : tag;
        warnings.push(issue("company", "COMPANY_NOT_A_CUSTOMER", `"${company}" is not a customer yet: kept in the notes`));
      }
    }
    if (customer) fields.customerId = customer.id;
    if (errors.length) return { line, status: "invalid", fields, errors, warnings };

    const tail = phoneTail(fields.phone);
    const nameKey = `${same(fields.name)}|${fields.customerId || ""}`;
    let duplicateOf = null;
    if (fields.email) {
      if (seenEmail.has(fields.email)) duplicateOf = { kind: "file", line: seenEmail.get(fields.email), by: "email" };
      else if (existing?.emails?.has?.(fields.email)) duplicateOf = { kind: "contact", by: "email" };
    }
    if (!duplicateOf && tail) {
      if (seenPhone.has(tail)) duplicateOf = { kind: "file", line: seenPhone.get(tail), by: "phone" };
      else if (existing?.phones?.has?.(tail)) duplicateOf = { kind: "contact", by: "phone" };
    }
    // No email and no phone: the only thing two rows can share is a name at one customer.
    if (!duplicateOf && !fields.email && !tail) {
      if (seenName.has(nameKey)) duplicateOf = { kind: "file", line: seenName.get(nameKey), by: "name" };
      else if (existing?.names?.has?.(nameKey)) duplicateOf = { kind: "contact", by: "name" };
    }
    if (duplicateOf) return { line, status: "duplicate", fields, errors: [], warnings, duplicateOf };

    if (fields.email) seenEmail.set(fields.email, line);
    if (tail) seenPhone.set(tail, line);
    if (!fields.email && !tail) seenName.set(nameKey, line);
    return { line, status: "create", fields, errors: [], warnings };
  });

  return { rows: planned, summary: tally(planned) };
}

/** The rows a person has to look at - everything that will not simply be created - capped so a bad file cannot make a huge answer. */
const issuesOf = (rows, limit = 200) => rows.filter((r) => r.status !== "create" || r.warnings.length).slice(0, limit);

module.exports = {
  MAX_ROWS, SOURCE_WORDS,
  sourceFrom, moneyFrom, phoneTail, norm,
  planLeadImport, planContactImport, issuesOf,
};
