// India GST: place of supply and the split of a line's tax into CGST + SGST (inside one state) or IGST (between states).
// Pure, no database. Applies only to an organisation whose country is IN; the UAE VAT path never calls it.
//
// The line keeps ONE total tax (`vatAmount`) exactly as before, so totals, ageing, payments and every older report read the
// same figure. The split is a second view of that figure: cgst + sgst + igst always equals it, to the fils.
//
//   intra-state  supplier's state = place of supply   half CGST, half SGST (UTGST in a union territory)
//   inter-state  anything else                        all IGST
//
// Place of supply, for goods and services alike in this first version:
//   a sale      the customer's state; with none on file, the supplier's own (treated as intra-state)
//   a purchase  the company's state (the recipient): the supplier is the vendor, whose state decides intra or inter
// Special cases (exports, SEZ, an online service to an unregistered person, immovable property) are not modelled.
const { stateCodeOfGstin, isStateCode } = require("./gstStates");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The party's state: the code stored on the record, else the one inside its GSTIN, else null.
function partyState(party) {
  const stored = party?.stateCode;
  if (isStateCode(stored)) return String(stored);
  return stateCodeOfGstin(party?.vat?.trn || party?.trnNumber || party?.trnNO || party?.gstin);
}

/**
 * { companyState, party, side } -> { gstType: "intra" | "inter" | null, supplierState, placeOfSupply }
 *   side "sales":    supplier = the company, place of supply = the customer's state (else the company's)
 *   side "purchase": supplier = the vendor, place of supply = the company's state
 * gstType is null when the company's own state is unknown: no split can be made honestly, and the caller keeps total tax only.
 */
function placeOfSupply({ companyState, party, side }) {
  const own = isStateCode(companyState) ? String(companyState) : null;
  if (!own) return { gstType: null, supplierState: null, placeOfSupply: null };
  const theirs = partyState(party);
  if (side === "purchase") {
    const supplierState = theirs || own; // a vendor with no state on file is taken as local rather than guessed to be far away
    return { gstType: supplierState === own ? "intra" : "inter", supplierState, placeOfSupply: own };
  }
  const place = theirs || own;
  return { gstType: place === own ? "intra" : "inter", supplierState: own, placeOfSupply: place };
}

/**
 * Splits `tax` for a line or a document. Intra: CGST = SGST = half, an odd fil going to CGST; inter: all IGST.
 * cgst + sgst + igst === round2(tax) always.
 */
function splitGst(tax, gstType) {
  const total = round2(tax);
  if (gstType === "inter") return { cgst: 0, sgst: 0, igst: total };
  if (gstType !== "intra") return null;
  const sgst = round2(Math.floor((total * 100) / 2) / 100);
  return { cgst: round2(total - sgst), sgst, igst: 0 };
}

// An HSN (goods) or SAC (services) code: 4 to 8 digits (HSN is 2, 4, 6 or 8; SAC is 6, and the tax invoice rules ask for 4 digits
// or more depending on turnover). Returns the digits, "" for blank, or undefined for anything else (the caller refuses it).
function normaliseHsn(input) {
  const text = String(input ?? "").replace(/[\s.-]/g, "");
  if (!text) return "";
  return /^\d{4,8}$/.test(text) ? text : undefined;
}

const ZERO = () => ({ cgst: 0, sgst: 0, igst: 0 });
const addGst = (a, b) => ({ cgst: round2((a?.cgst || 0) + (b?.cgst || 0)), sgst: round2((a?.sgst || 0) + (b?.sgst || 0)), igst: round2((a?.igst || 0) + (b?.igst || 0)) });
const totalGst = (g) => round2((g?.cgst || 0) + (g?.sgst || 0) + (g?.igst || 0));

/**
 * Stamps a priced document with its GST view. `lines` are priced lines (vatAmount set), `charges` priced charges.
 * Each gets `gst {cgst, sgst, igst}`; the document total is the sum of those, so it equals lineVat + chargesVat.
 * A reverse-charge line has no VAT of its own (`vatAmount` 0): its assessed tax (`rcmVat`) is split the same way into `rcmGst`.
 */
function stampGst({ lines, charges = [], gstType }) {
  if (!gstType) return { lines, charges, gst: null, rcmGst: null };
  let gst = ZERO();
  let rcmGst = ZERO();
  const stampedLines = lines.map((l) => {
    const own = splitGst(l.vatAmount || 0, gstType);
    gst = addGst(gst, own);
    if (l.rcmVat > 0) {
      const rc = splitGst(l.rcmVat, gstType);
      rcmGst = addGst(rcmGst, rc);
      return { ...l, gst: own, rcmGst: rc };
    }
    return { ...l, gst: own };
  });
  const stampedCharges = charges.map((c) => {
    const own = splitGst(c.vatAmount || 0, gstType);
    gst = addGst(gst, own);
    return { ...c, gst: own };
  });
  return { lines: stampedLines, charges: stampedCharges, gst, rcmGst };
}

// The posting keys of the six component accounts. A document's tax is posted to these instead of the single VAT account.
const GST_KEYS = {
  output: { cgst: "gst-cgst-output", sgst: "gst-sgst-output", igst: "gst-igst-output" },
  input: { cgst: "gst-cgst-input", sgst: "gst-sgst-input", igst: "gst-igst-input" },
};
const ALL_GST_KEYS = [...Object.values(GST_KEYS.output), ...Object.values(GST_KEYS.input)];

/**
 * The posting keys a document needs, so the caller resolves just those accounts before anything is written.
 * type is the document type; `pricing` carries gst / rcmGst. [] when the document has no GST detail.
 */
function gstKeysNeeded(type, pricing) {
  const sale = type === "sales_order" || type === "sales_return";
  const kind = sale ? "output" : "input";
  const keys = new Set();
  const take = (g, k) => { for (const c of ["cgst", "sgst", "igst"]) if ((g?.[c] || 0) > 0) keys.add(GST_KEYS[k][c]); };
  take(pricing?.gst, kind);
  if (!sale) take(pricing?.rcmGst, "input"); // the self-assessed tax of a reverse-charge purchase is claimed as input tax too
  return [...keys];
}

/**
 * Replaces the single VAT leg of a posted document with one leg per GST component, on the same side, so the debits and credits
 * still balance. `figure` tags are kept (the "vat" leg for the document's tax, the "rcmVat" input leg for reverse charge).
 *   accountOf(key) -> ledger account id for a GST posting key (already resolved by the caller)
 *   inputAccountId the resolved "vat-purchase" account: the reverse-charge pair has two legs and only the INPUT one is split
 * A leg whose components do not add back to its amount (a document priced before the split, a rounding surprise) is left as it
 * was, so a posting never fails over the split.
 */
function routeGstLegs(entries, type, pricing, accountOf, { inputAccountId } = {}) {
  const sale = type === "sales_order" || type === "sales_return";
  const kind = sale ? "output" : "input";
  const split = (entry, comps, side) => {
    const amount = entry[side];
    const sum = round2((comps?.cgst || 0) + (comps?.sgst || 0) + (comps?.igst || 0));
    if (!comps || Math.abs(sum - amount) > 0.005) return null;
    const legs = [];
    for (const c of ["cgst", "sgst", "igst"]) {
      const v = round2(comps[c] || 0);
      if (!(v > 0)) continue;
      legs.push({ accountId: accountOf(GST_KEYS[kind][c]), debitAmount: side === "debitAmount" ? v : 0, creditAmount: side === "creditAmount" ? v : 0, figure: entry.figure });
    }
    return legs.length ? legs : null;
  };
  const out = [];
  for (const e of entries) {
    const side = e.debitAmount > 0 ? "debitAmount" : "creditAmount";
    let legs = null;
    if (e.figure === "vat") legs = split(e, pricing?.gst, side);
    else if (e.figure === "rcmVat" && inputAccountId && String(e.accountId) === String(inputAccountId)) legs = split(e, pricing?.rcmGst, side);
    if (legs) out.push(...legs); else out.push(e);
  }
  return out;
}

// The second half's name for a document: SGST, or UTGST when the place of supply is a union territory without a legislature.
const { secondHalfName } = require("./gstStates");
const secondHalfLabel = (placeCode) => secondHalfName(placeCode);

module.exports = { GST_KEYS, ALL_GST_KEYS, gstKeysNeeded, routeGstLegs, normaliseHsn, partyState, placeOfSupply, splitGst, addGst, totalGst, stampGst, secondHalfLabel };
