// Pure rules for the customer / vendor master: VAT configuration, credit terms, contacts, bank
// accounts and KYC documents. No Mongoose here, so every rule is testable without a database; the
// callers (services/masters/partyMasterService.js) add the lookups that need one (bank master,
// document types, attachments, TRN uniqueness).
const AppError = require("./AppError");
const { isValidIban, normalizeIban } = require("./iban");
const { parseExpiry, diffDays } = require("./documentExpiry");

const VAT_STATUSES = ["registered", "unregistered", "exempt", "designated_zone"];
const TRN_REQUIRED_FOR = new Set(["registered", "designated_zone"]);
const TRN_RE = /^\d{15}$/;
// The party's tax number follows the ORGANISATION's country: a UAE TRN, an Indian GSTIN, else a plain tax number.
const TAX_ID_RULES = {
  AE: { label: "TRN", registered: "VAT", re: TRN_RE, message: "A UAE TRN is exactly 15 digits" },
  IN: { label: "GSTIN", registered: "GST", re: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, message: "A GSTIN is 15 characters: the 2-digit state code, the 10-character PAN, then 3 more (e.g. 27ABCDE1234F1Z5)" },
};
const OTHER_TAX_ID = { label: "Tax number", registered: "tax", re: /^[A-Z0-9]{5,20}$/, message: "A tax number is 5 to 20 letters and digits" };
const taxIdRule = (country) => TAX_ID_RULES[String(country || "AE").toUpperCase()] || OTHER_TAX_ID;
const SWIFT_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/; // BIC8 / BIC11
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9-]{4,34}$/;

const bad = (message, code, status = 400) => new AppError(message, status, code);
const text = (v, max) => String(v ?? "").trim().slice(0, max);

// ---- VAT ---------------------------------------------------------------------------------------

const normalizeTrn = (v) => {
  const s = String(v ?? "").replace(/[\s-]/g, "").toUpperCase();
  return s || null;
};
const isValidTrn = (v, country) => taxIdRule(country).re.test(String(v ?? ""));

// Works out the VAT block to store.
//   input      the `vat` object of the request (or undefined)
//   legacyTrn  the request's trnNumber / trnNO (undefined when the request did not carry it)
//   existing   { status, trn, tradeLicenseNo } already stored (undefined on create); `trn` falls
//              back to the legacy field, so parties saved before this block existed read correctly
// A party with a TRN and no stated status is "registered"; one with neither is "unregistered".
// The 15-digit rule is applied when the TRN or the status changes, so editing something unrelated
// on an older record with a loose TRN is not blocked.
function resolveVat({ input, legacyTrn, existing, country } = {}) {
  const rule = taxIdRule(country);
  const prev = existing || {};
  const prevStatus = prev.status || (prev.trn ? "registered" : "unregistered");
  const given = input && input.trn !== undefined ? input.trn : legacyTrn;
  const trn = given === undefined ? prev.trn || null : normalizeTrn(given);

  let status = input?.status;
  if (status !== undefined && status !== null && status !== "") {
    if (!VAT_STATUSES.includes(status)) throw bad(`VAT status must be one of: ${VAT_STATUSES.join(", ")}`, "INVALID_VAT_STATUS");
  } else {
    status = prevStatus;
    if (trn && status === "unregistered") status = "registered";
    if (!trn && TRN_REQUIRED_FOR.has(status)) status = "unregistered"; // the TRN was cleared
  }

  const changed = !existing || trn !== (prev.trn || null) || status !== prevStatus;
  if (changed) {
    if (TRN_REQUIRED_FOR.has(status)) {
      if (!trn) throw bad(`Enter the ${rule.label} of a ${rule.registered}-registered party`, "TRN_REQUIRED");
      if (!isValidTrn(trn, country)) throw bad(rule.message, "INVALID_TRN");
    } else if (status === "unregistered" && trn) {
      throw bad("An unregistered party has no TRN. Remove it, or choose Registered.", "TRN_NOT_ALLOWED");
    } else if (trn && !isValidTrn(trn, country)) {
      throw bad(rule.message, "INVALID_TRN");
    }
  }

  const licence = input && input.tradeLicenseNo !== undefined ? text(input.tradeLicenseNo, 60) : prev.tradeLicenseNo || "";
  return { status, trn, tradeLicenseNo: licence };
}

// ---- website -----------------------------------------------------------------------------------

// "" clears it; anything else must look like an address (www.example.ae or https://example.ae/shop).
function cleanWebsite(value) {
  const site = text(value, 200);
  if (site && !/^(https?:\/\/)?[^\s/$.?#]+\.[^\s]{2,}$/i.test(site)) throw bad("Enter a website such as www.example.ae", "INVALID_WEBSITE");
  return site;
}

// ---- credit terms ------------------------------------------------------------------------------

// Payment terms stay as the text the rest of the system reads ("Net 30", "45 days", "COD"); the
// number of days is derived from it by ageing, so credit.days and paymentTerms are kept in step here.
const STANDARD_TERMS = {
  customer: ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"],
  vendor: ["30 days", "Net 30", "45 days", "Net 60", "60 days", "COD"],
};
const DEFAULT_TERMS = { customer: "Net 30", vendor: "30 days" };
const MAX_CREDIT_DAYS = 365;

const termsToDays = (terms) => {
  const m = /(\d+)/.exec(String(terms || ""));
  return m ? Number(m[1]) : 0;
};
// A standard term, or "Net <days>" for any other number of days.
const isValidTerms = (kind, terms) => {
  if ((STANDARD_TERMS[kind] || []).includes(terms)) return true;
  const m = /^Net (\d{1,3})$/.exec(String(terms || ""));
  return Boolean(m && Number(m[1]) <= MAX_CREDIT_DAYS);
};
// The label that stands for `days`: the current one when it already means that many days.
function daysToTerms(kind, days, current) {
  if (current && isValidTerms(kind, current) && termsToDays(current) === days) return current;
  if (days === 0) return kind === "vendor" ? "COD" : "Cash on Delivery";
  return `Net ${days}`;
}

function resolveTerms({ kind, paymentTerms, creditDays, existing }) {
  const hasTerms = paymentTerms !== undefined && paymentTerms !== null && paymentTerms !== "";
  const hasDays = creditDays !== undefined && creditDays !== null && creditDays !== "";
  const stored = existing?.paymentTerms;
  if (hasTerms && !isValidTerms(kind, paymentTerms)) {
    throw bad(`Invalid paymentTerms. Use ${STANDARD_TERMS[kind].join(", ")} or Net <days>.`, "INVALID_PAYMENT_TERMS");
  }
  if (hasDays) {
    const days = Number(creditDays);
    if (!Number.isInteger(days) || days < 0 || days > MAX_CREDIT_DAYS) {
      throw bad(`Credit days must be a whole number from 0 to ${MAX_CREDIT_DAYS}`, "INVALID_CREDIT_DAYS");
    }
    return { paymentTerms: daysToTerms(kind, days, hasTerms ? paymentTerms : stored), days };
  }
  if (hasTerms) return { paymentTerms, days: termsToDays(paymentTerms) };
  const terms = stored && isValidTerms(kind, stored) ? stored : DEFAULT_TERMS[kind];
  return { paymentTerms: terms, days: existing?.credit?.days ?? termsToDays(terms) };
}

// ---- contacts / bank accounts ------------------------------------------------------------------

// Exactly one primary when there are any rows: none flagged makes the first one primary, more than
// one flagged is refused.
function settlePrimary(rows, what, code) {
  if (!rows.length) return rows;
  const primaries = rows.filter((r) => r.isPrimary).length;
  if (primaries > 1) throw bad(`Only one ${what} can be the primary one`, code);
  if (primaries === 0) rows[0].isPrimary = true;
  return rows;
}

function normalizeContacts(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw bad("contacts must be a list", "INVALID_CONTACTS");
  const rows = input.map((c, i) => {
    const n = i + 1;
    const name = text(c?.name, 100);
    const email = text(c?.email, 120).toLowerCase();
    const phone = text(c?.phone, 30);
    if (!name) throw bad(`Contact ${n}: enter a name`, "CONTACT_NAME_REQUIRED");
    if (email && !EMAIL_RE.test(email)) throw bad(`Contact ${n}: that email address is not valid`, "INVALID_EMAIL");
    if (phone && !PHONE_RE.test(phone)) throw bad(`Contact ${n}: that phone number is not valid`, "INVALID_PHONE");
    // An _id already on the row is KEPT. A contact row has a stable id (partyMasterSchemas.js declares `{ _id: true }`)
    // and things point at it - the CRM's own Contact record shares it, and every call logged against that person is
    // filed under it. Dropping it here let Mongoose mint a new one on every save, so editing a contact's job title
    // silently replaced the person and took their history with them.
    const row = { name, designation: text(c?.designation, 100), email, phone, isPrimary: Boolean(c?.isPrimary) };
    if (c?._id) row._id = c._id;
    return row;
  });
  return settlePrimary(rows, "contact", "MULTIPLE_PRIMARY_CONTACTS");
}

const isValidSwift = (v) => SWIFT_RE.test(String(v ?? "").replace(/\s+/g, "").toUpperCase());

// The checks that need no database. `bankName` is filled from the bank master by the caller when a
// bankId is chosen.
function normalizeBankAccounts(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw bad("bankAccounts must be a list", "INVALID_BANK_ACCOUNTS");
  const rows = input.map((b, i) => {
    const n = i + 1;
    const accountNumber = String(b?.accountNumber ?? "").replace(/\s+/g, "");
    const iban = normalizeIban(b?.iban);
    const swiftCode = String(b?.swiftCode ?? "").replace(/\s+/g, "").toUpperCase();
    const bankName = text(b?.bankName, 120);
    const bankId = b?.bankId || null;
    if (!bankId && !bankName) throw bad(`Bank account ${n}: choose the bank`, "BANK_REQUIRED");
    if (!accountNumber && !iban) throw bad(`Bank account ${n}: enter the account number or the IBAN`, "ACCOUNT_REQUIRED");
    if (accountNumber && !ACCOUNT_NUMBER_RE.test(accountNumber)) {
      throw bad(`Bank account ${n}: an account number has 4 to 34 letters, digits or dashes`, "INVALID_ACCOUNT_NUMBER");
    }
    if (iban && !isValidIban(iban)) throw bad(`Bank account ${n}: that IBAN is not valid. Check it for a typing mistake.`, "INVALID_IBAN");
    if (swiftCode && !SWIFT_RE.test(swiftCode)) throw bad(`Bank account ${n}: a SWIFT / BIC code has 8 or 11 characters`, "INVALID_SWIFT");
    return { bankId, bankName, accountNumber, iban, swiftCode, isPrimary: Boolean(b?.isPrimary) };
  });
  return settlePrimary(rows, "bank account", "MULTIPLE_PRIMARY_BANK_ACCOUNTS");
}

// ---- KYC documents -----------------------------------------------------------------------------

const dayToDate = (day) => (day ? new Date(`${day}T00:00:00.000Z`) : null);

// rows: [{ documentTypeId?, typeName?, number?, issueDate?, expiryDate?, attachmentId?, fileName?, isVerified? }]
// typesById: Map(String id -> { _id, name, requiresExpiry, minLength, maxLength }) for the ids in rows.
// A chosen type fills typeName, sets the number's length limits and says whether an expiry is needed.
function normalizeDocuments(input, typesById = new Map()) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw bad("documents must be a list", "INVALID_DOCUMENTS");
  return input.map((d, i) => {
    const n = i + 1;
    const type = d?.documentTypeId ? typesById.get(String(d.documentTypeId)) : null;
    if (d?.documentTypeId && !type) throw bad(`Document ${n}: that document type does not exist`, "DOCUMENT_TYPE_NOT_FOUND", 404);
    const typeName = type ? type.name : text(d?.typeName, 100);
    if (!typeName) throw bad(`Document ${n}: choose the document type`, "DOCUMENT_TYPE_REQUIRED");
    const number = text(d?.number, 60);
    if (type) {
      if (type.minLength && number.length < type.minLength) {
        throw bad(number ? `Document ${n} (${typeName}): the number needs at least ${type.minLength} characters` : `Document ${n} (${typeName}): enter the number`, "DOCUMENT_NUMBER_TOO_SHORT");
      }
      if (type.maxLength && number.length > type.maxLength) {
        throw bad(`Document ${n} (${typeName}): the number can have at most ${type.maxLength} characters`, "DOCUMENT_NUMBER_TOO_LONG");
      }
    }
    const issue = parseExpiry(d?.issueDate);
    const expiry = parseExpiry(d?.expiryDate);
    if (issue.invalid) throw bad(`Document ${n} (${typeName}): the issue date is not a valid date`, "INVALID_DATE");
    if (expiry.invalid) throw bad(`Document ${n} (${typeName}): the expiry date is not a valid date`, "INVALID_DATE");
    if (type?.requiresExpiry && !expiry.day) throw bad(`Document ${n} (${typeName}): this type needs an expiry date`, "EXPIRY_REQUIRED");
    if (issue.day && expiry.day && diffDays(issue.day, expiry.day) <= 0) {
      throw bad(`Document ${n} (${typeName}): the expiry date must be after the issue date`, "EXPIRY_BEFORE_ISSUE");
    }
    return {
      documentTypeId: type ? type._id : null,
      typeName,
      number,
      issueDate: dayToDate(issue.day),
      expiryDate: dayToDate(expiry.day),
      attachmentId: d?.attachmentId || null,
      fileName: text(d?.fileName, 200),
      isVerified: Boolean(d?.isVerified),
    };
  });
}

module.exports = {
  VAT_STATUSES, TRN_RE, SWIFT_RE, STANDARD_TERMS, DEFAULT_TERMS, MAX_CREDIT_DAYS,
  normalizeTrn, isValidTrn, resolveVat, cleanWebsite, TAX_ID_RULES, OTHER_TAX_ID, taxIdRule,
  termsToDays, isValidTerms, daysToTerms, resolveTerms,
  normalizeContacts, isValidSwift, normalizeBankAccounts, normalizeDocuments, settlePrimary,
};
