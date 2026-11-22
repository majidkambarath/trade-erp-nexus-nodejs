// The half of every spreadsheet import that does not depend on WHAT is being imported: how many rows a request may carry, how an
// untrusted cell is read, how a row is numbered, what an issue looks like and how a plan is tallied. Pure: no Mongoose, no request.
//
// Shared by utils/crmImport.js (enquiries and people) and utils/masterImport.js (customers, vendors and items), so each import's own
// file is only the rules of its own rows. The screen reads the file in the browser and maps its columns (lib/spreadsheetImport.js);
// what arrives is rows of named fields, and the import decides what each row IS: one to create, one that cannot be (and why, in
// words a person can act on), or one we already hold.
//
// Everything is coerced through `text` / `num` first: a request body is not to be trusted (the security sweep posts
// `{ name: { $ne: "x" } }` at every route and requires a clean answer), so an object or an array reads as empty.
const crm = require("./crm");

const { text, num, round2 } = crm;

/** Rows per PREVIEW request. A bigger file is sent in lots by the screen; each row is a few reads, so this keeps one call short. */
const MAX_ROWS = 200;
/**
 * Rows per WRITE request, for the imports that create a record with a ledger account and a number behind it (a customer is about a dozen
 * round trips to the database): 200 of them in one call would run into the proxy's timeout. The screen sends writes in lots of this size.
 */
const MAX_WRITE_ROWS = 50;

const norm = (s) => text(s, 120).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
const tooMany = (max = MAX_ROWS) => ({ code: "IMPORT_TOO_MANY", message: `Send at most ${max} rows in one go` });
const noRows = () => ({ code: "IMPORT_ROWS_REQUIRED", message: "There are no rows to import" });
const issue = (field, code, message) => ({ field, code, message });

/**
 * Run a rule that THROWS an AppError - the services' own pure rules do (resolveVat, resolveTerms, resolveAddress ...) - and turn what it
 * says into a row issue instead of a failed request. `{ value }` when it passed, `{ issue }` when it did not. Using the rule the form's
 * save uses, rather than a copy of it, is what keeps a preview and the real write from disagreeing.
 */
function attempt(field, fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { issue: issue(field, e?.code || "INVALID", e?.message || "That value is not valid") };
  }
}

function tally(rows) {
  const by = (s) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, create: by("create"), invalid: by("invalid"), duplicate: by("duplicate"), skipped: by("skipped") };
}

/** The rows a person has to look at - everything that will not simply be created - capped so a bad file cannot make a huge answer. */
const issuesOf = (rows, limit = 200) => rows.filter((r) => r.status !== "create" || r.warnings.length).slice(0, limit);

module.exports = { MAX_ROWS, MAX_WRITE_ROWS, norm, moneyFrom, phoneTail, rowOf, lineOf, tooMany, noRows, issue, attempt, tally, issuesOf };
