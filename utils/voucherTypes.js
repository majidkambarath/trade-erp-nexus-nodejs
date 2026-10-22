// What a document's number looks like, and which rules a kind of document obeys. Pure: no Mongoose, no
// tenant, no clock. The database half is services/core/voucherTypeService.js and the generator is
// services/core/numberSeriesService.js.
//
// Until this existed the 29 series were a hardcoded table in the generator, the format was a single
// template literal, and the yearly reset was an accident of the counter's unique key rather than a
// choice anybody could make. SEED below reproduces those defaults EXACTLY, so seeding an organisation
// that has been trading for a year changes none of its numbers.

const HEAD_OFFICE = "main";

// How the Numbering screen groups the list, and what a group is allowed to do.
const KINDS = ["voucher", "trade", "inventory", "crm", "system"];
const RESET_POLICIES = ["yearly", "never"];

// The label a continuous series counts under. A counter is identified by the label it PRINTS (see labelOf),
// and a required field cannot hold "", so a series that never restarts needs a sentinel of its own.
const CONTINUOUS = "ALL";
const METHODS = ["auto", "auto_override"];
const SEPARATORS = ["-", "/", ""];

// The most characters a number may run to where a tax authority reads it: India CGST Rule 46(b) caps an
// invoice's serial at 16. Checked against the WIDEST number a series can ever produce, not the next one.
const STATUTORY_MAX_LENGTH = 16;

// Every series the app issues. `postsAs` is the engine's own voucherType / transaction type, so a named
// variant can carry its own number while posting exactly as its parent. `statutory` marks a document WE
// issue bearing tax: its number can never be handed to a second document (see mayReuse).
const SEED = [
  // Sales and purchase. The invoice series (SO / PO) are the ones that post; SORD / PORD are the
  // commitments in front of them and post nothing.
  { key: "SO",   name: "Sales invoice",          kind: "trade",     postsAs: "sales_order",      prefix: "SO",   statutory: true  },
  { key: "PO",   name: "Purchase invoice",       kind: "trade",     postsAs: "purchase_order",   prefix: "PO",   statutory: false },
  { key: "SR",   name: "Sales return",           kind: "trade",     postsAs: "sales_return",     prefix: "SR",   statutory: true  },
  { key: "PR",   name: "Purchase return",        kind: "trade",     postsAs: "purchase_return",  prefix: "PR",   statutory: false },
  { key: "SORD", name: "Sales order",            kind: "trade",     postsAs: null,               prefix: "SORD", statutory: false },
  { key: "PORD", name: "Purchase order",         kind: "trade",     postsAs: null,               prefix: "PORD", statutory: false },
  { key: "QT",   name: "Quotation",              kind: "trade",     postsAs: null,               prefix: "QT",   statutory: false },
  { key: "DLN",  name: "Delivery note",          kind: "trade",     postsAs: null,               prefix: "DLN",  statutory: false },
  { key: "GRN",  name: "Goods received note",    kind: "trade",     postsAs: null,               prefix: "GRN",  statutory: false },
  // Finance vouchers. A debit or credit note is a tax document we issue, so it is statutory; the other
  // five are internal records.
  { key: "RV",   name: "Receipt",                kind: "voucher",   postsAs: "receipt",          prefix: "RV",   statutory: false },
  { key: "PV",   name: "Payment",                kind: "voucher",   postsAs: "payment",          prefix: "PV",   statutory: false },
  { key: "JV",   name: "Journal",                kind: "voucher",   postsAs: "journal",          prefix: "JV",   statutory: false },
  { key: "CV",   name: "Contra",                 kind: "voucher",   postsAs: "contra",           prefix: "CV",   statutory: false },
  { key: "EV",   name: "Expense",                kind: "voucher",   postsAs: "expense",          prefix: "EV",   statutory: false },
  { key: "DN",   name: "Debit note",             kind: "voucher",   postsAs: "debit_note",       prefix: "DN",   statutory: true  },
  { key: "CN",   name: "Credit note",            kind: "voucher",   postsAs: "credit_note",      prefix: "CN",   statutory: true  },
  // Stock and production.
  { key: "SA",   name: "Stock adjustment",       kind: "inventory", postsAs: null,               prefix: "SA",   statutory: false },
  { key: "WO",   name: "Stock write-off",        kind: "inventory", postsAs: null,               prefix: "WO",   statutory: false },
  { key: "PRD",  name: "Production",             kind: "inventory", postsAs: null,               prefix: "PRD",  statutory: false },
  { key: "JWC",  name: "Job work challan",       kind: "inventory", postsAs: null,               prefix: "JWC",  statutory: false },
  { key: "PRO",  name: "Process order",          kind: "inventory", postsAs: null,               prefix: "PRO",  statutory: false },
  // CRM.
  { key: "LD",   name: "Lead",                   kind: "crm",       postsAs: null,               prefix: "LD",   statutory: false },
  { key: "OPP",  name: "Opportunity",            kind: "crm",       postsAs: null,               prefix: "OPP",  statutory: false },
  // Written by the engine itself: go-live balances, a proven bank reconciliation, the year-end entry.
  // Nobody types one of these, so they take no manual override and no reuse (see mayOverride).
  { key: "OBV",  name: "Opening balance",        kind: "system",    postsAs: null,               prefix: "OBV",  statutory: false },
  { key: "OSI",  name: "Opening sales invoice",  kind: "system",    postsAs: null,               prefix: "OSI",  statutory: false },
  { key: "OPI",  name: "Opening purchase invoice", kind: "system",  postsAs: null,               prefix: "OPI",  statutory: false },
  { key: "OST",  name: "Opening stock",          kind: "system",    postsAs: null,               prefix: "OST",  statutory: false },
  { key: "BRC",  name: "Bank reconciliation",    kind: "system",    postsAs: null,               prefix: "BRC",  statutory: false },
  { key: "YEC",  name: "Year-end closing",       kind: "system",    postsAs: null,               prefix: "YEC",  statutory: false },
];

// The defaults every seeded row starts with. They are today's hardcoded behaviour: a four-digit counter
// that restarts each fiscal year, the branch code in front for any branch but head office, and no
// manual numbers.
const DEFAULTS = {
  suffix: "",
  separator: "-",
  includeYear: true,
  numberLength: 4,
  resetPolicy: "yearly",
  branchPrefix: "auto",
  method: "auto",
  allowReuse: false,
};

const seedOf = (row) => ({ ...DEFAULTS, ...row, parentKey: null, isSystem: true, isActive: true });

/** Every built-in series as a complete row, ready to upsert. */
const seedRows = () => SEED.map(seedOf);

const byKey = new Map(SEED.map((r) => [r.key, r]));
const seedFor = (key) => byKey.get(String(key || "").toUpperCase()) || null;

const KIND_LABELS = {
  voucher: "Finance vouchers",
  trade: "Sales and purchase",
  inventory: "Stock and production",
  crm: "CRM",
  system: "Written by the system",
};

// ---------------------------------------------------------------------------
// What a type is allowed to do
// ---------------------------------------------------------------------------

/**
 * May a number freed by a deletion be handed to the next document of this type?
 *
 * Never for a document we issue bearing tax (India CGST Rule 46(b) wants one unchanging number per
 * document, and an e-invoiced number is already lodged with the tax authority), and never for a series
 * the engine writes for itself. Otherwise it is the organisation's choice, off by default.
 *
 * This is only half the test: the document itself also has a veto, because one already sent to the
 * customer has spent its number whatever the type says. See NumberSeriesService.release.
 */
const mayReuse = (type) => Boolean(type) && type.statutory !== true && type.kind !== "system" && type.allowReuse === true;

/**
 * May a person type the number instead of taking the allocated one?
 *
 * Allowed on a statutory series on purpose: a business moving onto the product mid-year has to be able
 * to carry on from its paper invoice book. The risk of a typed number is a duplicate, and that is met by
 * checking uniqueness and floating the counter past it - not by forbidding it. A system series takes no
 * override because nobody enters a year-end closing entry by hand.
 */
const mayOverride = (type) => Boolean(type) && type.kind !== "system" && type.method === "auto_override";

// ---------------------------------------------------------------------------
// Rendering a number
// ---------------------------------------------------------------------------

const widthOf = (type) => Math.min(10, Math.max(3, Math.trunc(Number(type?.numberLength) || DEFAULTS.numberLength)));
const separatorOf = (type) => (SEPARATORS.includes(type?.separator) ? type.separator : DEFAULTS.separator);
const clean = (v) => String(v == null ? "" : v).trim().toUpperCase();

/**
 * The branch segment, or "" for none. Head office never carries one: a document number is unique across
 * the ORGANISATION, not per branch (a tax invoice number must be unique for the taxpayer), so the branch
 * code in front is what keeps two branches from minting the same number - and head office, being the
 * original, keeps the bare prefix so no existing number changes.
 */
function branchPartOf(type, branchId) {
  if (!type || type.branchPrefix === "none") return "";
  const code = clean(branchId);
  if (!code || code === clean(HEAD_OFFICE)) return "";
  const own = (type.branchPrefixes || []).find((b) => clean(b?.branchId) === code);
  return clean(own?.prefix || code);
}

/**
 * The prefix as the counter row records it - the branch part and the prefix joined, "SO" or "SHJ-SO".
 * Kept on the row so the Numbering screen can show what format minted its latest number; the number
 * itself is always rendered from the type, never from this copy.
 */
function renderPrefixFor(type, branchId) {
  const branch = branchPartOf(type, branchId);
  return branch ? [branch, clean(type?.prefix)].join(separatorOf(type)) : clean(type?.prefix);
}

/** The finished number, e.g. "SO-2026-0001" or "SHJ-SO-2026-0001". */
function renderNumber({ type, branchId, yearCode, seq }) {
  const sep = separatorOf(type);
  const parts = [];
  const branch = branchPartOf(type, branchId);
  if (branch) parts.push(branch);
  parts.push(clean(type?.prefix));
  if (type?.includeYear !== false && clean(yearCode)) parts.push(clean(yearCode));
  parts.push(String(Math.max(0, Math.trunc(Number(seq) || 0))).padStart(widthOf(type), "0"));
  if (clean(type?.suffix)) parts.push(clean(type.suffix));
  return parts.join(sep);
}

/**
 * Which place in this series' sequence a typed number occupies, or null if it is not in this series'
 * format at all.
 *
 * The ONLY number-parsing in the product, and deliberately narrow: it reads a number a person has just
 * typed, against the format that series is configured with, so the counter can be floated past it. It
 * never parses a stored number - nothing does, and a document's number stays an opaque identifier
 * everywhere else. A typed number outside the format is recorded but belongs to no sequence, which is
 * the honest answer: "INV/OLD/77" carried over from a paper book is not the series' 77th document.
 */
function seqOf({ type, branchId, yearCode, number }) {
  const sep = separatorOf(type);
  const width = widthOf(type);
  const head = [branchPartOf(type, branchId), clean(type?.prefix), type?.includeYear !== false ? clean(yearCode) : ""]
    .filter(Boolean)
    .join(sep);
  const want = clean(number);
  const start = head + sep;
  if (!head || !want.startsWith(start)) return null;
  let rest = want.slice(start.length);
  const tail = clean(type?.suffix);
  if (tail) {
    const tailPart = sep + tail;
    if (!rest.endsWith(tailPart)) return null;
    rest = rest.slice(0, rest.length - tailPart.length);
  }
  if (rest.length !== width || !/^[0-9]+$/.test(rest)) return null;
  const n = Number(rest);
  return n >= 1 ? n : null;
}

/**
 * The LONGEST number this series can ever produce, which is what a length limit has to be judged
 * against - not the next number, which is short while a company is new.
 */
function longestNumber(type, { branchId, yearCode = "2026" } = {}) {
  const widest = Math.pow(10, widthOf(type)) - 1;
  return renderNumber({ type, branchId, yearCode, seq: widest });
}

// ---------------------------------------------------------------------------
// Which counter a date belongs to
// ---------------------------------------------------------------------------

/**
 * The counter's label - the middle segment of the number - and whether it is printed.
 *
 * THE INVARIANT THIS PROTECTS: for one (organisation, branch, series), the printed label identifies the
 * counter. The label is the counter's key, so "same label, same counter" is true by construction and two
 * documents can never be handed one number.
 *
 * That is why the reset policy changes the LABEL rather than some key beside it. An earlier design keyed
 * the counter on the fiscal year's _id while still printing its code, which looks tidier and is wrong:
 * numbers issued before any fiscal year was configured print the calendar year "2026", and the moment
 * somebody then created a year coded 2026 the counter forked while the label stayed the same - restarting
 * at 0001 and duplicating SO-2026-0001. Keying on the label cannot do that.
 *
 * `yearly` counts under the fiscal year's code (the calendar year before any year is configured, which is
 * how numbering works on day one). `never` counts under one label for good, and prints no year at all.
 */
function labelOf({ type, fiscalYear, year }) {
  const policy = RESET_POLICIES.includes(type?.resetPolicy) ? type.resetPolicy : DEFAULTS.resetPolicy;
  if (policy === "never") return { policy, label: CONTINUOUS, yearCode: "" };
  const yearCode = fiscalYear?.code ? clean(fiscalYear.code) : clean(year);
  return { policy, label: yearCode, yearCode };
}

/** How a counter row says what it counts. */
const labelText = (label) => (clean(label) === CONTINUOUS ? "Every year (continuous)" : `Year ${clean(label)}`);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEY_RE = /^[A-Z0-9]{2,8}$/;
const PREFIX_RE = /^[A-Z0-9]{1,10}$/;
const SUFFIX_RE = /^[A-Z0-9]{0,6}$/;
const isInt = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;

/**
 * Field errors as `{field: message}`, the convention the forms in this codebase use. Things that are
 * merely unusual are not errors - see warningsFor.
 */
function validateVoucherType(input = {}, { takenKeys = [], parent = null, branches = [] } = {}) {
  const e = {};
  const key = clean(input.key);
  if (!key) e.key = "A code is needed.";
  else if (!KEY_RE.test(key)) e.key = "The code is 2 to 8 letters or digits.";
  else if (takenKeys.map(clean).includes(key)) e.key = "That code is already in use.";

  const name = String(input.name || "").trim();
  if (!name) e.name = "A name is needed.";
  else if (name.length > 60) e.name = "The name is 60 characters at most.";

  const prefix = clean(input.prefix);
  if (!prefix) e.prefix = "A prefix is needed.";
  else if (!PREFIX_RE.test(prefix)) e.prefix = "The prefix is 1 to 10 letters or digits, and carries no separator of its own.";

  if (!SUFFIX_RE.test(clean(input.suffix))) e.suffix = "The suffix is up to 6 letters or digits.";
  if (!SEPARATORS.includes(input.separator)) e.separator = "Choose a separator.";
  if (!isInt(input.numberLength, 3, 10)) e.numberLength = "The counter is 3 to 10 digits.";
  if (!RESET_POLICIES.includes(input.resetPolicy)) e.resetPolicy = "Choose when the counter restarts.";
  if (!["auto", "none"].includes(input.branchPrefix)) e.branchPrefix = "Choose how the branch appears.";
  if (!METHODS.includes(input.method)) e.method = "Choose how the number is given.";
  if (input.resetPolicy === "never" && input.includeYear !== false) {
    e.includeYear = "A counter that never restarts cannot carry the year: the year would move while the count carried on, and the two would disagree about which counter a number came from.";
  }

  // A variant is a second name and a second series for a type that already exists; it cannot change what
  // that type POSTS, which is the whole reason it is safe.
  if (input.parentKey && !parent) e.parentKey = "That parent type does not exist.";
  if (input.parentKey && parent && parent.parentKey) e.parentKey = "A variant cannot have a variant of its own.";

  const statutory = Boolean(parent ? parent.statutory : input.statutory);
  const kind = parent ? parent.kind : input.kind;
  if (input.allowReuse === true && statutory) {
    e.allowReuse = "A document we issue bearing tax keeps its number for good, so it cannot be re-used.";
  }
  if (input.allowReuse === true && kind === "system") e.allowReuse = "The system writes this series itself, so there is nothing to re-use.";
  if (input.method === "auto_override" && kind === "system") e.method = "The system writes this series itself, so it cannot be typed.";

  // Length is judged against the widest number the series can EVER reach - the last number of the
  // longest-coded branch - not the next one, which is short while a company is new.
  if (!e.prefix && !e.numberLength && !e.separator) {
    const widestBranch = branches
      .map((b) => (typeof b === "string" ? b : b?.code))
      .filter(Boolean)
      .reduce((longestSoFar, code) => (branchPartOf({ ...DEFAULTS, ...input }, code).length > branchPartOf({ ...DEFAULTS, ...input }, longestSoFar).length ? code : longestSoFar), HEAD_OFFICE);
    const longest = longestNumber({ ...DEFAULTS, ...input, prefix, statutory }, { branchId: widestBranch });
    const where = branchPartOf({ ...DEFAULTS, ...input }, widestBranch) ? ` in ${String(widestBranch).toUpperCase()}` : "";
    if (statutory && longest.length > STATUTORY_MAX_LENGTH) {
      e.numberLength = `At its longest this reads ${longest}${where} (${longest.length} characters). A tax document's number is ${STATUTORY_MAX_LENGTH} at most.`;
    } else if (longest.length > 24) {
      e.numberLength = `At its longest this reads ${longest}${where} (${longest.length} characters), which is too long to print.`;
    }
  }
  return e;
}

/** Things worth saying out loud that are nobody's mistake. */
function warningsFor(input = {}, { branches = [] } = {}) {
  const out = [];
  if (input.resetPolicy === "never") {
    out.push("The counter carries on across years, so the number will not say which year a document belongs to.");
  }
  if (input.branchPrefix === "none" && branches.length > 1) {
    out.push("Without the branch in front, two branches can reach the same number. A document number should be unique across the organisation.");
  }
  if (input.separator === "") out.push("With no separator the parts of the number run together.");
  return out;
}

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

/**
 * Is this series' sequence unbroken, and where it is not, why.
 *
 * India's guidance is to keep records of cancelled and unused numbers rather than quietly close the gap,
 * which is exactly what this answers. `rows` are the register's rows for ONE series and scope, each
 * `{seq, status, number, reason, docType, docId, at}`.
 *
 * Three kinds of gap, and the difference matters to whoever has to explain it:
 *   RELEASED   - deleted and the number handed back to be used again
 *   CANCELLED  - deleted and the number retired, so the gap is permanent
 *   UNRECORDED - no record at all: a transaction that rolled back after taking a number, or a document
 *                issued before the register existed
 */
function gapsOf(rows = [], { upTo } = {}) {
  const at = new Map();
  for (const r of rows) {
    const seq = Math.trunc(Number(r?.seq) || 0);
    if (seq > 0) at.set(seq, r);
  }
  const highest = Math.max(0, Math.trunc(Number(upTo) || 0), ...at.keys());
  const gaps = [];
  let issued = 0;
  for (let seq = 1; seq <= highest; seq++) {
    const row = at.get(seq);
    if (row && row.status === "issued") { issued += 1; continue; }
    if (!row) { gaps.push({ seq, code: "UNRECORDED", reason: "No record of this number being used." }); continue; }
    gaps.push({
      seq,
      code: row.status === "released" ? "RELEASED" : "CANCELLED",
      reason: String(row.reason || "").trim() || (row.status === "released" ? "Deleted; the number was handed back." : "Deleted; the number was retired."),
      number: row.number || null,
    });
  }
  return { highest, issued, gaps, continuous: gaps.length === 0 };
}

// ---------------------------------------------------------------------------
// Finding the series for a document
// ---------------------------------------------------------------------------

/**
 * Which series numbers a document that posts as `postsAs` (a voucherType such as "payment", or a
 * transaction type such as "sales_order").
 *
 * A variant is chosen explicitly by its own key; otherwise the built-in wins. That ordering is what lets
 * "Petty cash payment" exist without any of the twenty-odd places that compare voucherType against
 * "payment" having to learn about it.
 */
function seriesFor({ voucherTypeKey, postsAs, types = [] }) {
  const wanted = clean(voucherTypeKey);
  if (wanted) {
    const own = types.find((t) => clean(t.key) === wanted && t.isActive !== false);
    if (own) return own;
  }
  const posts = String(postsAs || "").trim();
  if (!posts) return null;
  return types.find((t) => t.postsAs === posts && !t.parentKey && t.isActive !== false) || null;
}

/** The variants of a built-in, for the chooser on a voucher form. */
const variantsOf = (key, types = []) => types.filter((t) => clean(t.parentKey) === clean(key) && t.isActive !== false);

module.exports = {
  HEAD_OFFICE,
  KINDS,
  KIND_LABELS,
  RESET_POLICIES,
  METHODS,
  SEPARATORS,
  STATUTORY_MAX_LENGTH,
  SEED,
  DEFAULTS,
  seedRows,
  seedFor,
  mayReuse,
  mayOverride,
  widthOf,
  separatorOf,
  branchPartOf,
  renderPrefixFor,
  renderNumber,
  seqOf,
  longestNumber,
  CONTINUOUS,
  labelOf,
  labelText,
  validateVoucherType,
  warningsFor,
  gapsOf,
  seriesFor,
  variantsOf,
};
