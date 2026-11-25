// Our flat PINT-AE payload (utils/eInvoice.js buildPayload) -> the JSON body Wafeq's /invoices and /credit-notes take. Pure, no I/O.
//
// Wafeq builds the XML and works out the totals itself; the seller is taken from the taxpayer's registered profile, so it is never sent.
// What we send must therefore reproduce OUR totals exactly: `wafeqTotals` repeats Wafeq's arithmetic (a line is quantity x unit price
// rounded half-up; VAT is rounded once per category and rate) and any fils of difference is a local issue that stops the send.
// Behaviour here was measured against the Wafeq sandbox on 20 Nov 2026 (see CLAUDE.md, "E-invoicing through Wafeq").
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const EMIRATE_CODES = {
  "abu dhabi": "AUH", dubai: "DXB", sharjah: "SHJ", ajman: "AJM", "umm al quwain": "UAQ", "ras al khaimah": "RAK", fujairah: "FUJ",
};
const EMIRATE_SET = new Set(Object.values(EMIRATE_CODES));
const emirateCode = (v) => {
  const t = String(v || "").trim();
  if (EMIRATE_SET.has(t.toUpperCase())) return t.toUpperCase();
  return EMIRATE_CODES[t.toLowerCase().replace(/\s+/g, " ")] || "";
};

// The exemption reason codes Wafeq documents for an exempt line (Federal Decree-Law 8 of 2017, art. 46), and the one for out of scope.
const EXEMPT_REASON_CODES = ["DL8.46.1", "DL8.46.2", "DL8.46.3", "DL8.46.4"];
const OUT_OF_SCOPE_REASON_CODE = "VATEX-AE-OOS";

// A GTIN is 8, 12, 13 or 14 digits ending in a valid GS1 check digit.
function validGtin(v) {
  const d = String(v ?? "").trim();
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) return false;
  const digits = d.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((t, n, i) => t + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

/** Wafeq's own arithmetic over a body it would receive: -> { net, tax, total } */
function wafeqTotals(lines) {
  let net = 0;
  const groups = new Map();
  for (const l of lines) {
    const amount = round2(Number(l.quantity) * Number(l.unit_price));
    net = round2(net + amount);
    const key = `${l.tax_category}|${Number(l.tax_percent) || 0}`;
    const g = groups.get(key) || { rate: Number(l.tax_percent) || 0, net: 0 };
    g.net = round2(g.net + amount);
    groups.set(key, g);
  }
  let tax = 0;
  for (const g of groups.values()) tax = round2(tax + (g.net * g.rate) / 100);
  return { net, tax, total: round2(net + tax) };
}

/**
 * payload: the flat payload from ei.buildPayload.
 * ctx: {
 *   dueDate "YYYY-MM-DD", sourceId,
 *   buyer: { emirate, street?, identifier?, legalRegistration? },
 *   reasons: [exemption reason code per payload line, or undefined],
 *   original: { wafeqDocumentId?, number?, issueDate? }   (credit notes)
 * }
 * -> { kind: "invoice" | "credit_note", path, body, issues: [{field, message}], totals }
 */
function toWafeqDocument(payload, ctx = {}) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  const isCredit = payload.invoiceTransactionType === "creditNote";
  const buyerCountry = String(payload.buyerCountryCode || "AE").toUpperCase();

  if (payload.documentCurrencyCode && payload.documentCurrencyCode !== "AED") {
    add("documentCurrencyCode", "A foreign-currency invoice cannot be sent through Wafeq yet");
  }

  const reasons = ctx.reasons || [];
  const lines = (payload.lines || []).map((l, i) => {
    const category = l.taxCategory;
    const zeroRate = ["Z", "E", "O"].includes(category);
    // an odd quantity x price pair (priceBaseQty != 1) is sent as one unit at the net, the quantity kept in the words
    const odd = Number(l.priceBaseQty) !== 1;
    const out = {
      description: odd ? `${l.itemName} (${l.quantity} ${l.quantityUom || "EA"})` : String(l.itemName || ""),
      quantity: odd ? 1 : Number(l.quantity),
      unit_price: odd ? Number(l.lineNetAmount) : Number(l.unitPrice),
      tax_category: category,
      tax_percent: zeroRate ? 0 : Number(l.taxRatePercent) || 0,
    };
    const reason = reasons[i];
    if (category === "E") {
      if (blank(reason) || !EXEMPT_REASON_CODES.includes(reason)) add(`line ${i + 1}.tax_exemption_reason_code`, `line ${i + 1}: an exempt line needs an exemption reason (set it on the tax code)`);
      else out.tax_exemption_reason_code = reason;
    }
    if (category === "O") out.tax_exemption_reason_code = blank(reason) ? OUT_OF_SCOPE_REASON_CODE : reason;
    if (category === "AE") {
      if (blank(l.reverseChargeGoodsType)) add(`line ${i + 1}.reverse_charge_goods_type`, `line ${i + 1}: a reverse-charge line needs its goods type (set it on the tax code)`);
      else out.reverse_charge_goods_type = l.reverseChargeGoodsType;
      if (blank(l.gtin)) add(`line ${i + 1}.gtin`, `line ${i + 1}: a reverse-charge line needs the item's GTIN (barcode)`);
      else out.gtin = String(l.gtin);
    }
    return out;
  });

  // customer
  const b = ctx.buyer || {};
  const registered = !blank(payload.buyerVatTrn);
  const emirate = emirateCode(b.emirate);
  // Wafeq refuses an empty element (PINT ibr-079), so a part we do not hold is left out; a UAE buyer with no city on file is in their emirate's
  const street = b.street || payload.buyerAddressLine1;
  const city = !blank(payload.buyerCity) ? payload.buyerCity : buyerCountry === "AE" && emirate ? b.emirate : "";
  const customer = { name: payload.buyerName, address: { ...(blank(street) ? {} : { street }), ...(blank(city) ? {} : { city }), country: buyerCountry } };
  if (buyerCountry === "AE") {
    if (!emirate) add("buyerEmirate", "Customer emirate is missing (choose it on the customer's address)");
    else customer.address.country_subentity = emirate;
  }
  if (registered) {
    customer.vat_number = payload.buyerVatTrn;
    if (!blank(payload.customerParticipantId)) customer.id = payload.customerParticipantId;
  } else if (!blank(b.identifier)) {
    customer.identifier = String(b.identifier).trim(); // no id: the document goes to the tax authority only
  } else {
    add("buyerIdentifier", "A customer with no TRN needs an identifier such as a trade licence number (add it on the customer's e-invoice details)");
  }
  if (b.legalRegistration && !blank(b.legalRegistration.type) && !blank(b.legalRegistration.id)) {
    customer.legal_registration = { type: b.legalRegistration.type, id: b.legalRegistration.id, ...(b.legalRegistration.authority ? { authority: b.legalRegistration.authority } : {}) };
  }

  const exemptOnly = lines.length > 0 && lines.every((l) => l.tax_category === "E");
  const body = {
    ...(isCredit ? { credit_note_number: payload.documentId } : { invoice_number: payload.documentId }),
    issue_date: payload.issueDate,
    ...(ctx.sourceId ? { source_id: String(ctx.sourceId) } : {}),
    currency: "AED",
    customer,
    line_items: lines,
  };
  if (!isCredit) body.due_date = ctx.dueDate || payload.issueDate;
  if (exemptOnly) body.document_type_code = isCredit ? "81" : "480"; // rule IBR-151-AE: an exempt-only document is a commercial one

  if (isCredit) {
    const o = ctx.original || {};
    if (o.wafeqDocumentId) {
      body.previous_document_id = o.wafeqDocumentId;
      body.previous_invoice_source = "ap";
    } else if (!blank(o.number || payload.invoiceRef)) {
      body.previous_invoice_source = "external";
      body.previous_invoice_number = o.number || payload.invoiceRef;
      if (o.issueDate) body.previous_invoice_issue_date = o.issueDate;
    } else {
      add("invoiceRef", "A credit note must reference the invoice it credits");
    }
  }

  // The e-invoice must say what our books say.
  const totals = wafeqTotals(lines);
  if (totals.net !== round2(payload.lineExtensionTotal) || totals.tax !== round2(payload.taxAmount)) {
    add("totals", `Wafeq would total this document as ${totals.net.toFixed(2)} + ${totals.tax.toFixed(2)} VAT, but the books say ${round2(payload.lineExtensionTotal).toFixed(2)} + ${round2(payload.taxAmount).toFixed(2)} VAT`);
  }
  if (Math.abs(round2(payload.roundingAmount || 0)) > 0) {
    add("roundingAmount", "A round-off amount cannot be sent through Wafeq");
  }

  return { kind: isCredit ? "credit_note" : "invoice", path: isCredit ? "/credit-notes" : "/invoices", body, issues, totals };
}

module.exports = { validGtin, toWafeqDocument, wafeqTotals, emirateCode, EMIRATE_CODES, EXEMPT_REASON_CODES, OUT_OF_SCOPE_REASON_CODE };
