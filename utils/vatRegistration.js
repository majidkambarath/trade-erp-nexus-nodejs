// Whether the organisation is registered for VAT, on a given day, and what that means for a document (pure).
//
// Applies to UAE organisations only: the registration, the TRN and the 5% standard rate are the UAE's. Any other country answers
// "not governed", and every caller then behaves exactly as it did before this module existed (an Indian organisation's GST is its
// own business, see utils/countryRules.js).
//
// "Registered" is three facts, all of which must hold on the document's day:
//   - the organisation has a tax number on file (profile.trn),
//   - it has not been marked as deregistered (profile.vatRegistered, absent = registered, as the model has always read it), and
//   - the day is on or after the registration date (profile.vatRegisteredFrom, "YYYY-MM-DD"; absent = registered from the start).
// The registration date is what lets an organisation that registers in March keep its January invoices exactly as they were issued.
//
// Not part of utils/plans.js / permissions.js, so it needs no mirror in zarvia-platform.

const GOVERNED_COUNTRY = "AE";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const text = (v) => String(v ?? "").trim();

/**
 * { governs, registered } for a document dated `day` ("YYYY-MM-DD", the organisation's own calendar day).
 * `governs` is false outside the UAE: nothing is forced, nothing is stamped.
 */
function stateOn(profile, country, day) {
  if (String(country || "").toUpperCase() !== GOVERNED_COUNTRY) return { governs: false, registered: true };
  const p = profile || {};
  const from = text(p.vatRegisteredFrom);
  const started = !from || !day || text(day) >= from;
  return { governs: true, registered: Boolean(text(p.trn)) && p.vatRegistered !== false && started };
}

/** Is this purchase one whose VAT cannot be claimed back (its document was stamped as made while not registered)? */
const vatIsCost = (transaction) =>
  Boolean(transaction) && transaction.vatRegistered === false && /^purchase_(order|return)$/.test(String(transaction.type || ""));

const plain = (x) => (x && typeof x.toObject === "function" ? x.toObject() : x);

/**
 * The figures of a purchase when its VAT is part of the cost: the VAT of the lines goes into the goods (Inventory or the item's
 * expense account), the VAT of the charges into the charges, and no VAT is left for the Input VAT leg. What the supplier is owed
 * does not change, so the entry still balances.
 */
function foldVat(figures, transaction) {
  const p = plain(transaction)?.pricing;
  let lineVat;
  let chargesVat;
  if (p && p.grandTotal != null) {
    lineVat = round2(p.lineVat || 0);
    chargesVat = round2(p.chargesVat || 0);
  } else {
    lineVat = round2((plain(transaction)?.items || []).reduce((t, i) => t + (Number(i.vatAmount) || 0), 0));
    chargesVat = 0;
  }
  return {
    ...figures,
    netLines: round2(figures.netLines + lineVat),
    charges: round2(figures.charges + chargesVat),
    vat: round2(figures.vat - lineVat - chargesVat),
  };
}

/** The lines as a purchase sees them when its VAT is cost: each line's value includes its VAT and carries none. */
const itemsWithVat = (items) =>
  (items || []).map((i) => {
    const line = plain(i);
    return { ...line, taxableAmount: round2((Number(line.taxableAmount) || 0) + (Number(line.vatAmount) || 0)), vatAmount: 0 };
  });

module.exports = { GOVERNED_COUNTRY, stateOn, vatIsCost, foldVat, itemsWithVat };
