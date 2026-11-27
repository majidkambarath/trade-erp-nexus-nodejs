// Reading a spreadsheet of customers, vendors and items for an organisation going live: the rules, as plain functions with no Mongoose
// and no request, so every awkward cell is a test rather than a support call. The shared half (row caps, how a cell and a line are
// read, the issue, the tally) is utils/importRules.js; the CRM's own is utils/crmImport.js.
//
// The screen reads the file in the browser and maps its columns (lib/masterImport.js); what arrives here is rows of named fields, and
// this decides what each row IS: one to create, one that cannot be (and why, in words a person can act on), or one we already hold.
// Nothing is written here and nothing is guessed silently.
//
// THE RULE THAT KEEPS A PREVIEW HONEST: a row is judged by the SAME pure rules the form's save uses - resolveVat, resolveTerms,
// cleanWebsite, resolveAddress, normaliseHsn - not by a copy of them. What the preview calls valid is then what the save accepts, and what
// it refuses carries the save's own words. The only rules written here are the ones the save applies in a SERVICE (a name is unique, a
// category exists), which need the books and so arrive as `existing` sets from the caller.
//
// ADD ONLY. A row for a record we already hold is reported as a duplicate and left alone: nothing existing is ever updated by an import.
const { text } = require("./crm");
const { cleanBarcode } = require("./barcodes");
const R = require("./importRules");
const { resolveVat, resolveTerms, cleanWebsite, VAT_STATUSES, STANDARD_TERMS } = require("./partyMaster");
const { resolveAddress, emirateOf } = require("./partyAddress");
const { normaliseHsn } = require("./gst");

const { issue, attempt } = R;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** A name as the books compare it: case and spacing ignored (services/masters/partyMasterService.js assertUniqueName). */
const same = (s) => text(s, 200).toLowerCase().replace(/\s+/g, " ");

// ---- words people write in a cell ------------------------------------------------------------------------------------------------

const COUNTRY_ALIASES = {
  uae: "AE", "u a e": "AE", emirates: "AE", "ksa": "SA", uk: "GB", "great britain": "GB", england: "GB", usa: "US", "u s a": "US", america: "US",
  "united states of america": "US", "south korea": "KR", "russia": "RU", "vietnam": "VN", "turkey": "TR", "czech republic": "CZ",
  // how a country is written in an address book, where the runtime's own name differs (Congo is left out on purpose: it names two countries)
  "ivory coast": "CI", burma: "MM", swaziland: "SZ", "east timor": "TL", "cape verde": "CV", macedonia: "MK", palestine: "PS", syria: "SY", iran: "IR",
  laos: "LA", moldova: "MD", tanzania: "TZ", bolivia: "BO", venezuela: "VE", brunei: "BN", "hong kong": "HK", macau: "MO", taiwan: "TW", holland: "NL",
  netherlands: "NL", "the netherlands": "NL", "north korea": "KP", "republic of korea": "KR",
};
// The ISO 3166-1 alpha-2 codes (249 of them), written out. Not derived from the runtime's region names: those also answer for reserved codes
// that are not countries (UK, EU, UN, QO, ZZ ...), and "UK" even took "United Kingdom" away from GB.
const ISO_REGIONS = ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ "
  + "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ "
  + "LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW "
  + "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" ");
const REGION_CODES = new Set(ISO_REGIONS);
let COUNTRY_LOOKUP = null;
/** Every country by its English name ("India" -> IN), built once: the runtime's own names for the ISO codes, plus the everyday aliases above. */
function countryLookup() {
  if (COUNTRY_LOOKUP) return COUNTRY_LOOKUP;
  const map = new Map();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of ISO_REGIONS) {
      let name;
      try { name = names.of(code); } catch (_) { continue; }
      if (name && name !== code) map.set(R.norm(name), code);
    }
  } catch (_) { /* no region names in this runtime: two-letter codes and the aliases below still work */ }
  for (const [word, code] of Object.entries(COUNTRY_ALIASES)) map.set(R.norm(word), code);
  COUNTRY_LOOKUP = map;
  return map;
}

/**
 * The ISO 3166 alpha-2 a Country cell means: `{ ok, code }`. A blank cell is `{ ok: true, code: undefined }`: nothing was said.
 * A name or an everyday alias is looked up FIRST: "UK" is two letters and the way everybody writes the United Kingdom, but its ISO code is GB,
 * so reading it as a code would have saved a country that does not exist. A two-letter code is taken only when it is a real country's.
 */
function countryFrom(raw) {
  const t = text(raw, 60);
  if (!t) return { ok: true, code: undefined };
  const named = countryLookup().get(R.norm(t));
  if (named) return { ok: true, code: named };
  if (/^[A-Za-z]{2}$/.test(t)) {
    const code = t.toUpperCase();
    return REGION_CODES.has(code) ? { ok: true, code } : { ok: false, code: undefined };
  }
  return { ok: false, code: undefined };
}

const EMIRATE_ABBREVIATIONS = { dxb: "Dubai", auh: "Abu Dhabi", shj: "Sharjah", ajm: "Ajman", uaq: "Umm Al Quwain", rak: "Ras Al Khaimah", fuj: "Fujairah" };
/** The emirate a cell means (written out, or DXB / AUH / SHJ ...), or the text as typed so the address rule can refuse it in its own words. undefined when blank. */
function emirateFrom(raw) {
  const t = text(raw, 40);
  if (!t) return undefined;
  return emirateOf(t) || EMIRATE_ABBREVIATIONS[R.norm(t)] || t;
}

const VAT_WORDS = {
  registered: ["registered", "yes", "y", "vat registered", "gst registered", "taxable", "true"],
  unregistered: ["unregistered", "not registered", "no", "n", "none", "false"],
  exempt: ["exempt"],
  designated_zone: ["designated zone", "designated_zone", "free zone", "freezone", "dz"],
};
/** A VAT-status cell: `{ given, value }`. A word we do not know is `{ given: true, value: null }` and becomes the status rule's own refusal. */
function vatStatusFrom(raw) {
  const t = text(raw, 40);
  if (!t) return { given: false, value: undefined };
  const key = R.norm(t);
  for (const [status, words] of Object.entries(VAT_WORDS)) if (words.some((w) => R.norm(w) === key)) return { given: true, value: status };
  return { given: true, value: null };
}

/**
 * A payment-terms cell, spelt the way the books spell it: "net 30", "30", "30 days" and "Net30" are "Net 30"; "cod" is "Cash on Delivery"
 * for a customer and "COD" for a vendor. Anything else is handed on as typed, so resolveTerms refuses it with the list of what is allowed.
 */
function termsFrom(kind, raw) {
  const t = text(raw, 30);
  if (!t) return undefined;
  const key = R.norm(t);
  const standard = (STANDARD_TERMS[kind] || []).find((s) => R.norm(s) === key);
  if (standard) return standard;
  if (["cod", "c o d", "cash on delivery"].includes(key)) return kind === "vendor" ? "COD" : "Cash on Delivery";
  if (["advance", "pre paid", "prepaid", "payment in advance"].includes(key) && kind === "customer") return "Prepaid";
  const days = /^(?:net\s*)?(\d{1,3})(?:\s*days?)?$/i.exec(t.trim());
  if (days) return `Net ${Number(days[1])}`;
  return t;
}

const STATUS_WORDS = {
  customer: { Active: ["active", "yes", "y", "1", "true", "open"], Inactive: ["inactive", "no", "n", "0", "false", "closed", "disabled", "blocked"] },
  vendor: {
    Compliant: ["compliant", "active", "yes", "y", "1", "true", "ok"],
    "Non-compliant": ["non compliant", "noncompliant", "not compliant"],
    Pending: ["pending", "new", "awaiting"],
    Expired: ["expired", "lapsed"],
  },
  item: { Active: ["active", "yes", "y", "1", "true"], Inactive: ["inactive", "no", "n", "0", "false", "disabled", "discontinued"] },
};
/** A status cell for a customer, a vendor or an item: `{ given, value }`; an unknown word is `{ given: true, value: null }` (the row is refused). */
function statusFrom(kind, raw) {
  const t = text(raw, 30);
  if (!t) return { given: false, value: undefined };
  const key = R.norm(t);
  for (const [status, words] of Object.entries(STATUS_WORDS[kind] || {})) if (words.some((w) => R.norm(w) === key)) return { given: true, value: status };
  return { given: true, value: null };
}

/** An item-type cell: goods when blank; `null` for a word we do not know. */
function itemTypeFrom(raw) {
  const t = text(raw, 30);
  if (!t) return "goods";
  const key = R.norm(t);
  if (["goods", "good", "stock", "stocked", "product", "products", "item", "items", "material"].includes(key)) return "goods";
  if (["service", "services", "svc", "labour", "labor"].includes(key)) return "service";
  return null;
}

// ---- customers and vendors -------------------------------------------------------------------------------------------------------

const NOUN = { customer: "customer", vendor: "vendor" };

/**
 * Decide each customer or vendor row.
 *   kind      "customer" | "vendor"
 *   existing  what we already hold: { names, trns, emails, phones } - Sets: names as `same`, trns normalised, emails lower-case, phones as
 *             `phoneTail`
 *   country   the ORGANISATION's country: a UAE TRN, an Indian GSTIN, else a plain tax number
 *
 * Statuses: `create` (will be made), `invalid` (a field is wrong: `errors`, each with the save's own words), `duplicate` (the same name or
 * tax number as an earlier row or a record we hold: `duplicateOf`). A repeated EMAIL or PHONE is only a warning - outlets of one group
 * share an accounts mailbox. A later row never claims a name an earlier row was refused for.
 *
 * `fields` is what the service's create takes, so the write is the form's own save.
 */
function planPartyImport(kind, rows, { existing = {}, country = "AE" } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: R.noRows() };
  if (rows.length > R.MAX_ROWS) return { error: R.tooMany() };
  const noun = NOUN[kind];
  const held = (which, key) => existing?.[which]?.has?.(key) === true;
  const seenName = new Map();
  const seenTrn = new Map();
  const seenEmail = new Map();
  const seenPhone = new Map();

  const planned = rows.map((raw, i) => {
    const r = R.rowOf(raw);
    const line = R.lineOf(raw, i);
    const errors = [];
    const warnings = [];
    const fields = {};

    const name = text(r.name, 150);
    if (!name) errors.push(issue("name", "NAME_REQUIRED", `Enter the ${noun}'s name`));
    fields[kind === "customer" ? "customerName" : "vendorName"] = name;

    fields.contactPerson = text(r.contactPerson, 100) || undefined;
    const email = text(r.email, 120).toLowerCase();
    if (email && !EMAIL_RE.test(email)) errors.push(issue("email", "INVALID_EMAIL", "That email address is not valid"));
    else if (email) fields.email = email;
    const phone = text(r.phone, 30);
    if (phone && !R.phoneTail(phone)) errors.push(issue("phone", "INVALID_PHONE", "That does not look like a phone number"));
    else if (phone) fields.phone = phone;

    // customers keep a billing and a shipping address; a vendor has the one address, which the books require
    const address = text(r.address, 300) || text(r.billingAddress, 300);
    if (kind === "customer") {
      if (address) fields.billingAddress = address;
      const shipping = text(r.shippingAddress, 300);
      if (shipping) fields.shippingAddress = shipping;
      const limit = R.moneyFrom(r.creditLimit);
      if (!limit.ok) errors.push(issue("creditLimit", "INVALID_AMOUNT", "That is not an amount"));
      else if (limit.value < 0) errors.push(issue("creditLimit", "NEGATIVE_AMOUNT", "A credit limit cannot be negative"));
      else if (limit.value > 0) fields.creditLimit = limit.value;
      const salesPerson = text(r.salesPerson, 80);
      if (salesPerson) fields.salesPerson = salesPerson;
    } else if (!address) {
      errors.push(issue("address", "ADDRESS_REQUIRED", "Enter the vendor's address"));
    } else {
      fields.address = address;
    }

    const status = statusFrom(kind, r.status);
    if (status.given && status.value === null) errors.push(issue("status", "INVALID_STATUS", `"${text(r.status, 30)}" is not a ${noun} status`));
    else if (status.value) fields.status = status.value;

    // the tax number and VAT status, judged by the organisation's country exactly as the form's save judges them
    const trnText = text(r.trn, 40);
    const licence = text(r.tradeLicense, 60);
    const vatWord = vatStatusFrom(r.vatStatus);
    if (vatWord.given && vatWord.value === null) {
      errors.push(issue("vatStatus", "INVALID_VAT_STATUS", `VAT status must be one of: ${VAT_STATUSES.join(", ")}`));
    } else if (trnText || vatWord.value || licence) {
      const input = { ...(trnText ? { trn: trnText } : {}), ...(vatWord.value ? { status: vatWord.value } : {}), ...(licence ? { tradeLicenseNo: licence } : {}) };
      const vat = attempt("trn", () => resolveVat({ input, legacyTrn: undefined, existing: undefined, country }));
      if (vat.issue) errors.push(vat.issue);
      else fields.vat = vat.value;
    }

    // payment terms and credit days, by the same rule
    const termsWord = termsFrom(kind, r.paymentTerms);
    const creditDays = text(r.creditDays, 6);
    if (termsWord !== undefined || creditDays !== "") {
      const terms = attempt("paymentTerms", () => resolveTerms({ kind, paymentTerms: termsWord, creditDays: creditDays === "" ? undefined : creditDays, existing: undefined }));
      if (terms.issue) errors.push(terms.issue);
      else Object.assign(fields, { paymentTerms: terms.value.paymentTerms, credit: { days: terms.value.days } });
    }

    if (text(r.website, 200)) {
      const site = attempt("website", () => cleanWebsite(r.website));
      if (site.issue) errors.push(site.issue);
      else fields.website = site.value;
    }

    // country, emirate (UAE) or GST state (India), and the city; a city that names an emirate fills a missing one
    const where = countryFrom(r.country);
    if (!where.ok) errors.push(issue("country", "INVALID_COUNTRY", `"${text(r.country, 60)}" is not a country we recognise: use its name or its two-letter code`));
    const city = text(r.city, 80);
    if (city) fields.city = city;
    const stateText = text(r.state, 40);
    let emirate = emirateFrom(r.emirate);
    const inUae = (where.code || (stateText ? "IN" : "AE")) === "AE"; // the country resolveAddress will fall back to when none is named
    if (emirate === undefined && inUae && !stateText && (where.code === "AE" || (where.code === undefined && country === "AE"))) emirate = emirateOf(city) || undefined;
    if (where.ok && (where.code !== undefined || emirate !== undefined || stateText)) {
      if (inUae && emirate === undefined) {
        // "UAE" and no emirate: the save would refuse it, and a whole file should not fail over a cell nobody filled. The record is made
        // with no country or emirate (as every record from before they existed), and the person is told.
        warnings.push(issue("emirate", "EMIRATE_MISSING", "No emirate: the country and emirate were left blank on this record"));
      } else {
        const place = attempt("country", () => resolveAddress({ country: where.code, emirate, stateCode: stateText || undefined }, undefined));
        if (place.issue) {
          // the rule's field is "country", but what a person fixes is the cell its message names
          errors.push(issue(/emirate/i.test(place.issue.message) ? "emirate" : /state|territory/i.test(place.issue.message) ? "state" : "country", place.issue.code, place.issue.message));
        } else if (place.value) {
          Object.assign(fields, place.value);
        }
      }
    }
    // India: a party with no GST state is treated as local (CGST + SGST); the state comes from a GSTIN when there is one, else somebody must say
    if ((where.code || country) === "IN" && !fields.stateCode && !errors.length) {
      const fromGstin = fields.vat?.trn && /^\d{2}/.test(fields.vat.trn);
      if (!fromGstin) warnings.push(issue("state", "STATE_MISSING", "No GST state: tax on its invoices will be split as for a local customer until a state is entered"));
    }

    if (errors.length) return { line, status: "invalid", fields, errors, warnings };

    // duplicates: the name (the books' own rule) or the tax number, against earlier rows and against what we hold
    const nameKey = same(name);
    const trn = fields.vat?.trn || null;
    let duplicateOf = null;
    if (seenName.has(nameKey)) duplicateOf = { kind: "file", line: seenName.get(nameKey), by: "name" };
    else if (held("names", nameKey)) duplicateOf = { kind, by: "name" };
    else if (trn && seenTrn.has(trn)) duplicateOf = { kind: "file", line: seenTrn.get(trn), by: "trn" };
    else if (trn && held("trns", trn)) duplicateOf = { kind, by: "trn" };
    if (duplicateOf) return { line, status: "duplicate", fields, errors: [], warnings, duplicateOf };

    // a repeated mailbox or number is told, not refused
    const tail = R.phoneTail(fields.phone);
    if (fields.email && (seenEmail.has(fields.email) || held("emails", fields.email))) {
      warnings.push(issue("email", "EMAIL_SHARED", `The same email as ${seenEmail.has(fields.email) ? `line ${seenEmail.get(fields.email)}` : `another ${noun} we hold`}`));
    }
    if (tail && (seenPhone.has(tail) || held("phones", tail))) {
      warnings.push(issue("phone", "PHONE_SHARED", `The same phone as ${seenPhone.has(tail) ? `line ${seenPhone.get(tail)}` : `another ${noun} we hold`}`));
    }

    seenName.set(nameKey, line);
    if (trn) seenTrn.set(trn, line);
    if (fields.email && !seenEmail.has(fields.email)) seenEmail.set(fields.email, line);
    if (tail && !seenPhone.has(tail)) seenPhone.set(tail, line);
    return { line, status: "create", fields, errors: [], warnings };
  });

  return { rows: planned, summary: R.tally(planned) };
}

const planCustomerImport = (rows, options) => planPartyImport("customer", rows, options);
const planVendorImport = (rows, options) => planPartyImport("vendor", rows, options);

// ---- items -----------------------------------------------------------------------------------------------------------------------

/**
 * Decide each item row (goods or service).
 *   existing        { skus: Set (lower-case), names: Set (`same`), codes: Set (exact: every barcode and SKU) } of the items we hold
 *   categories      [{ id, name }] we hold; units [{ id, unitName, shortCode }]; vendors [{ id, name }]
 *   addCategories   a category the file names that we do not hold is made (listed in `newCategories`); else the row is refused
 *   canSeeCost      false leaves the Purchase price column out: a person who may not see what items cost may not set it either
 *
 * A UNIT is never made from a file: its kind (weight, volume, quantity ...) cannot be guessed from a name, so a row naming an unknown unit
 * is refused and the unit is listed in `missing.units` for the person to add first. No quantity on hand is ever imported: an opening
 * quantity has to reach the books, which Opening balances > Stock does and an item's own form does not.
 */
function planItemImport(rows, { existing = {}, categories = [], units = [], vendors = [], addCategories = true, canSeeCost = true } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: R.noRows() };
  if (rows.length > R.MAX_ROWS) return { error: R.tooMany() };

  const catByName = new Map((Array.isArray(categories) ? categories : []).map((c) => [R.norm(c.name), c]));
  const unitByKey = new Map();
  for (const u of Array.isArray(units) ? units : []) unitByKey.set(R.norm(u.shortCode), u);
  for (const u of Array.isArray(units) ? units : []) unitByKey.set(R.norm(u.unitName), u); // a unit's name beats another's short code
  const vendorByName = new Map((Array.isArray(vendors) ? vendors : []).map((v) => [R.norm(v.name), v]));
  const newCategories = new Map();
  const missingUnits = new Map();
  const seenSku = new Map();
  const seenName = new Map();
  const seenBarcode = new Map();
  let costIgnored = false;

  const planned = rows.map((raw, i) => {
    const r = R.rowOf(raw);
    const line = R.lineOf(raw, i);
    const errors = [];
    const warnings = [];
    const fields = {};

    const name = text(r.name, 150);
    if (!name) errors.push(issue("name", "NAME_REQUIRED", "Enter the item's name"));
    fields.itemName = name;

    const type = itemTypeFrom(r.type);
    if (type === null) errors.push(issue("type", "INVALID_ITEM_TYPE", "Item type must be goods or service"));
    fields.itemType = type || "goods";
    const service = type === "service";

    // the category: matched by name; a new one is made when allowed
    const categoryText = text(r.category, 100);
    if (!categoryText) errors.push(issue("category", "CATEGORY_REQUIRED", "Enter the item's category"));
    else {
      const hit = catByName.get(R.norm(categoryText));
      if (hit) fields.categoryId = String(hit.id);
      else if (addCategories) fields.categoryName = categoryText;
      else errors.push(issue("category", "CATEGORY_NOT_FOUND", `There is no category called "${categoryText}"`));
    }

    // the unit: matched by name or short code, never made
    const unitText = text(r.unit, 40);
    if (!unitText) errors.push(issue("unit", "UNIT_REQUIRED", "Enter the item's unit (for example Kg, Box, Hour)"));
    else {
      const hit = unitByKey.get(R.norm(unitText));
      if (hit) fields.unitOfMeasure = String(hit.id);
      else {
        errors.push(issue("unit", "UNIT_NOT_FOUND", `There is no unit called "${unitText}". Add it under Inventory > Units first.`));
        if (!missingUnits.has(R.norm(unitText))) missingUnits.set(R.norm(unitText), unitText);
      }
    }

    const sku = text(r.sku, 40);
    if (sku) fields.sku = sku;
    else fields.autoSku = true; // the server numbers it, as the item form's automatic SKU does

    // a barcode: goods only, matched exactly. Two items cannot share one (a scanner would find both), so a barcode
    // repeated in the file, or one an item we hold already answers to, refuses the row rather than calling it a duplicate
    const barcode = cleanBarcode(text(r.barcode, 200)); // text(): a number keeps its digits, anything else reads as blank
    if (barcode.error) errors.push(issue("barcode", "INVALID_BARCODE", barcode.error));
    else if (barcode.value && service) warnings.push(issue("barcode", "SERVICE_NO_BARCODE", "A service has no barcode: it was left out"));
    else if (barcode.value) {
      if (seenBarcode.has(barcode.value)) errors.push(issue("barcode", "BARCODE_REPEATED", `Line ${seenBarcode.get(barcode.value)} has the same barcode`));
      else if (existing?.codes?.has?.(barcode.value)) errors.push(issue("barcode", "BARCODE_TAKEN", "Another item already has this barcode"));
      else fields.barcodeQrCode = barcode.value;
    }

    const sales = R.moneyFrom(r.salesPrice);
    if (!sales.ok) errors.push(issue("salesPrice", "INVALID_AMOUNT", "That is not an amount"));
    else if (sales.value < 0) errors.push(issue("salesPrice", "NEGATIVE_AMOUNT", "A price cannot be negative"));
    else fields.salesPrice = sales.value;

    const cost = R.moneyFrom(r.purchasePrice);
    if (!canSeeCost) {
      if (text(r.purchasePrice, 40)) costIgnored = true;
    } else if (!cost.ok) errors.push(issue("purchasePrice", "INVALID_AMOUNT", "That is not an amount"));
    else if (cost.value < 0) errors.push(issue("purchasePrice", "NEGATIVE_AMOUNT", "A price cannot be negative"));
    else fields.purchasePrice = cost.value;

    const reorder = R.moneyFrom(r.reorderLevel);
    if (!reorder.ok) errors.push(issue("reorderLevel", "INVALID_AMOUNT", "That is not a number"));
    else if (reorder.value < 0) errors.push(issue("reorderLevel", "NEGATIVE_AMOUNT", "A reorder level cannot be negative"));
    else if (service) {
      if (reorder.value > 0) warnings.push(issue("reorderLevel", "SERVICE_NO_REORDER", "A service has no reorder level: it was left out"));
    } else fields.reorderLevel = reorder.value;

    const hsn = normaliseHsn(r.hsn);
    if (hsn === undefined) errors.push(issue("hsn", "INVALID_HSN", "An HSN / SAC code is 4 to 8 digits. In Excel, format the column as text so a leading zero is kept."));
    else if (hsn) fields.hsnCode = hsn;

    const origin = text(r.origin, 60);
    const brand = text(r.brand, 60);
    if (!service) {
      if (origin) fields.origin = origin;
      if (brand) fields.brand = brand;
    }

    const supplier = text(r.supplier, 150);
    if (supplier) {
      const hit = vendorByName.get(R.norm(supplier));
      if (hit) fields.vendorId = String(hit.id);
      else warnings.push(issue("supplier", "VENDOR_NOT_FOUND", `"${supplier}" is not a vendor we hold: the supplier was left blank`));
    }

    const status = statusFrom("item", r.status);
    if (status.given && status.value === null) errors.push(issue("status", "INVALID_STATUS", `"${text(r.status, 30)}" is not an item status`));
    else if (status.value) fields.status = status.value;

    if (errors.length) return { line, status: "invalid", fields, errors, warnings };

    // duplicates: the SKU when one is given, else the name
    const skuKey = sku.toLowerCase();
    const nameKey = same(name);
    let duplicateOf = null;
    if (sku && seenSku.has(skuKey)) duplicateOf = { kind: "file", line: seenSku.get(skuKey), by: "sku" };
    else if (sku && existing?.skus?.has?.(skuKey)) duplicateOf = { kind: "item", by: "sku" };
    else if (seenName.has(nameKey)) duplicateOf = { kind: "file", line: seenName.get(nameKey), by: "name" };
    else if (existing?.names?.has?.(nameKey)) duplicateOf = { kind: "item", by: "name" };
    if (duplicateOf) return { line, status: "duplicate", fields, errors: [], warnings, duplicateOf };

    if (sku) seenSku.set(skuKey, line);
    if (fields.barcodeQrCode) seenBarcode.set(fields.barcodeQrCode, line);
    seenName.set(nameKey, line);
    if (fields.categoryName && !newCategories.has(R.norm(fields.categoryName))) newCategories.set(R.norm(fields.categoryName), fields.categoryName);
    return { line, status: "create", fields, errors: [], warnings };
  });

  // a category is only "new" while a row that will be made names it
  const notes = [];
  if (costIgnored) notes.push("The Purchase price column was left out: you may not set what items cost.");
  return {
    rows: planned,
    summary: R.tally(planned),
    newCategories: [...newCategories.values()],
    missing: { units: [...missingUnits.values()] },
    notes,
  };
}

module.exports = {
  planCustomerImport, planVendorImport, planPartyImport, planItemImport,
  countryFrom, emirateFrom, termsFrom, vatStatusFrom, statusFrom, itemTypeFrom, same,
};
