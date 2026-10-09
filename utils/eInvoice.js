// e-Invoicing rules for the UAE (PINT AE / Peppol). Pure functions: no I/O, no Mongoose.
//
// The payload uses flat UBL-style names (sellerVatTrn, customerParticipantId, taxCategory...) so
// it maps one-to-one onto a PINT AE access-point API. Rules and messages follow the readiness
// and pre-submit validation documented in docs/ERP_FEATURE_SPEC.md section 7.
const crypto = require("crypto");
const { priceLine } = require("./pricing");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// UAE TRN: 15 digits. Peppol participant id: "<scheme>:<id>", 0235 being the UAE TIN scheme.
const TRN_RE = /^\d{15}$/;
const PARTICIPANT_RE = /^\d+:\d+$/;

// Tax category codes (UN/CEFACT 5305 as used by PINT AE): S standard, Z zero-rated, E exempt,
// O out of scope, AE reverse charge. Blank means "could not be resolved" and BLOCKS the invoice
// rather than being sent as S/0%.
const CATEGORY_BY_KIND = { standard: "S", zero_rated: "Z", exempt: "E", out_of_scope: "O", reverse_charge: "AE" };

function taxCategoryFor(item) {
  if (item.taxKind && CATEGORY_BY_KIND[item.taxKind]) return CATEGORY_BY_KIND[item.taxKind];
  // Lines saved before tax codes: infer only the unambiguous case.
  return Number(item.vatPercent) > 0 ? "S" : "";
}

// UAE e-invoicing (PINT AE) is defined in UAE terms: the issue date is the UAE calendar date and the document currency is
// AED. So this is deliberately NOT the organisation's own zone and currency (utils/orgLocale.js): the e-invoicing feature
// is for UAE organisations, and the mandate fixes both. A UTC slice would back-date anything issued between 00:00 and
// 04:00 local.
const dubaiDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(d));

const isUae = (code, country) =>
  String(code || "").toUpperCase() === "AE" || /^(uae|u\.a\.e|united arab emirates)$/i.test(String(country || "").trim());

// Is a customer required to carry e-invoice details? Only a VAT-registered buyer in the UAE (or a
// buyer with no country recorded, which legacy rows are, and which we flag rather than assume).
function buyerRequiresDetails(customer) {
  const registered = Boolean(String(customer.trnNumber || "").trim());
  const country = customer.eInvoice?.countryCode;
  return registered && (!country || isUae(country));
}

const PARTY_CHECKLIST = [
  ["Party Name", (c) => c.customerName],
  ["Address Line 1", (c) => c.billingAddress],
  ["Country", (c) => c.eInvoice?.countryCode],
  ["City", (c) => c.eInvoice?.city],
  ["VAT Number", (c) => c.trnNumber],
  ["Participant ID", (c) => c.eInvoice?.participantId],
];

function partyReadiness(customer) {
  const required = buyerRequiresDetails(customer);
  const missing = required
    ? PARTY_CHECKLIST.filter(([, get]) => !String(get(customer) ?? "").trim()).map(([label]) => label)
    : [];
  const problems = [];
  if (required) {
    const trn = String(customer.trnNumber || "").trim();
    if (trn && !TRN_RE.test(trn)) problems.push("VAT Number must be 15 digits");
    const pid = String(customer.eInvoice?.participantId || "").trim();
    if (pid && !PARTICIPANT_RE.test(pid)) problems.push("Participant ID must look like 0235:100123456700003");
  }
  return { required, missing, problems, ready: missing.length === 0 && problems.length === 0 };
}

// Build the payload from a posted document, its party and the company profile.
function buildPayload({ transaction, customer, seller, sellerParticipantId }) {
  const isCredit = transaction.type === "sales_return";
  const lines = [];

  (transaction.items || []).forEach((item) => {
    const p = priceLine(item);
    const qty = Number(item.qty) || 0;
    const net = round2(item.taxableAmount ?? p.taxable);
    // unitPrice x qty must reproduce the net to the cent; if rounding the unit price breaks that
    // (fractional unit prices), send the line as qty 1 unit-price = net via priceBaseQty.
    let unitPrice = qty > 0 ? round2(net / qty) : 0;
    let priceBaseQty = 1;
    if (round2((qty * unitPrice) / priceBaseQty) !== net) {
      unitPrice = net;
      priceBaseQty = qty || 1;
    }
    lines.push({
      itemTypeGoodsServices: "G",
      itemName: item.description,
      sellerItemId: item.itemCode || String(item.itemId || ""),
      quantity: qty,
      quantityUom: item.uom || "EA",
      unitPrice,
      priceBaseQty,
      priceBaseQtyUom: item.uom || "EA",
      lineNetAmount: net,
      taxScheme: "VAT",
      taxCategory: taxCategoryFor(item),
      taxRatePercent: Number(item.vatPercent) || 0,
      lineTaxAmount: round2(item.vatAmount ?? p.vat),
      inclVatamount: round2(net + (item.vatAmount ?? p.vat)),
    });
  });

  // Header charges (freight etc.) are service lines.
  (transaction.charges || []).forEach((c) => {
    const net = round2(c.amount);
    const rate = Number(c.vatPercent) || 0;
    const tax = round2(c.vatAmount ?? (net * rate) / 100);
    lines.push({
      itemTypeGoodsServices: "S", itemName: c.description || c.code || "Charge", sellerItemId: c.code || "",
      quantity: 1, quantityUom: "EA", unitPrice: net, priceBaseQty: 1, priceBaseQtyUom: "EA",
      lineNetAmount: net, taxScheme: "VAT", taxCategory: rate > 0 ? "S" : "", taxRatePercent: rate,
      lineTaxAmount: tax, inclVatamount: round2(net + tax),
    });
  });
  lines.forEach((l, i) => (l.lineNumber = i + 1));

  const lineExtensionTotal = round2(lines.reduce((t, l) => t + l.lineNetAmount, 0));
  const taxAmount = round2(lines.reduce((t, l) => t + l.lineTaxAmount, 0));
  const totalIncludingTax = round2(lineExtensionTotal + taxAmount);
  const roundingAmount = round2(transaction.pricing?.roundOff || 0);

  // VAT breakdown by category and rate (the VAT return and PINT both need this block).
  const groups = new Map();
  for (const l of lines) {
    const k = `${l.taxCategory}|${l.taxRatePercent}`;
    const g = groups.get(k) || { taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent, taxableAmount: 0, taxAmount: 0 };
    g.taxableAmount = round2(g.taxableAmount + l.lineNetAmount);
    g.taxAmount = round2(g.taxAmount + l.lineTaxAmount);
    groups.set(k, g);
  }

  const buyerRegistered = Boolean(String(customer?.trnNumber || "").trim()) && isUae(customer?.eInvoice?.countryCode || "AE");
  return {
    documentId: transaction.transactionNo,
    issueDate: dubaiDate(transaction.date || Date.now()),
    invoiceTypeCode: isCredit ? "381" : "380",
    invoiceTransactionType: isCredit ? "creditNote" : "sale",
    documentCurrencyCode: "AED",
    invoiceRef: isCredit ? transaction.returnOf?.transactionNo || "" : undefined,
    sellerName: seller.legalName, sellerRegisteredName: seller.legalName, sellerVatTrn: seller.trn,
    sellerAddressLine1: seller.addressLine1, sellerCity: seller.city, sellerCountryCode: seller.countryCode || "AE",
    sellerParticipantId,
    buyerName: customer?.customerName, buyerRegisteredName: customer?.customerName, buyerVatTrn: customer?.trnNumber,
    buyerAddressLine1: customer?.billingAddress, buyerCity: customer?.eInvoice?.city,
    buyerCountryCode: customer?.eInvoice?.countryCode || "AE",
    buyerVatRegistered: buyerRegistered,
    customerParticipantId: customer?.eInvoice?.participantId,
    lineExtensionTotal, taxAmount, totalIncludingTax, roundingAmount,
    payableAmount: round2(totalIncludingTax + roundingAmount),
    taxBreakdown: [...groups.values()],
    lines,
  };
}

const REQUIRED_INVOICE = [
  "documentId", "issueDate", "invoiceTransactionType", "documentCurrencyCode", "sellerName", "sellerVatTrn",
  "sellerRegisteredName", "sellerAddressLine1", "sellerCity", "sellerCountryCode", "lineExtensionTotal",
  "taxAmount", "totalIncludingTax", "payableAmount",
];
const REQUIRED_BUYER = ["buyerName", "buyerVatTrn", "buyerAddressLine1", "buyerCity", "buyerCountryCode", "customerParticipantId"];
const REQUIRED_LINE = ["lineNumber", "itemName", "quantity", "quantityUom", "unitPrice", "lineNetAmount", "taxCategory", "taxRatePercent", "lineTaxAmount", "inclVatamount"];

const LABELS = {
  sellerVatTrn: "Seller VAT TRN", sellerName: "Seller name", sellerRegisteredName: "Seller registered name",
  sellerAddressLine1: "Seller address", sellerCity: "Seller city", sellerCountryCode: "Seller country",
  buyerName: "Customer name", buyerVatTrn: "Customer VAT TRN", buyerAddressLine1: "Customer address",
  buyerCity: "Customer city", buyerCountryCode: "Customer country", customerParticipantId: "Customer Participant ID",
  documentId: "Document number", issueDate: "Issue date", invoiceRef: "Original invoice reference",
};
const label = (k) => LABELS[k] || k;
const blank = (v) => v === undefined || v === null || v === "" || v === "-" || (typeof v === "number" && Number.isNaN(v)) || (Array.isArray(v) && v.length === 0);

// -> [{ field, message }]  (empty = ready to send). Messages are the ones users see.
function validatePayload(p, { headerDiscount = 0 } = {}) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });

  for (const k of REQUIRED_INVOICE) if (blank(p[k])) add(k, `${label(k)} is missing`);
  if (blank(p.lines)) add("lines", "The invoice has no lines");
  if (p.buyerVatRegistered) for (const k of REQUIRED_BUYER) if (blank(p[k])) add(k, `${label(k)} is missing`);
  if (p.invoiceTransactionType === "creditNote" && blank(p.invoiceRef)) {
    add("invoiceRef", "A credit note must reference the invoice it credits");
  }
  if (p.sellerVatTrn && !TRN_RE.test(String(p.sellerVatTrn))) add("sellerVatTrn", "Seller VAT TRN must be 15 digits");
  if (p.buyerVatRegistered && p.buyerVatTrn && !TRN_RE.test(String(p.buyerVatTrn))) add("buyerVatTrn", "Customer VAT TRN must be 15 digits");
  if (p.customerParticipantId && !PARTICIPANT_RE.test(String(p.customerParticipantId))) {
    add("customerParticipantId", "Customer Participant ID must look like 0235:100123456700003");
  }
  if (Number(headerDiscount) > 0) {
    add("headerDiscount", "A header discount cannot be sent on an e-invoice; use line discounts");
  }

  (p.lines || []).forEach((l, i) => {
    const at = `line ${i + 1}`;
    for (const k of REQUIRED_LINE) if (blank(l[k])) add(`${at}.${k}`, `${at}: ${k} is missing`);
    if (!(Number(l.quantity) > 0)) add(`${at}.quantity`, `${at}: quantity must be greater than zero`);
    if (!["S", "AE", "Z", "O", "E"].includes(l.taxCategory)) {
      add(`${at}.taxCategory`, "E-Invoice tax category could not be resolved from the ERP VAT treatment.");
    } else if (l.taxCategory === "S" && !(Number(l.taxRatePercent) > 0)) {
      add(`${at}.taxRatePercent`, "Standard-rated E-Invoice line must have a VAT rate greater than 0.");
    }
    if (l.lineNetAmount < 0) add(`${at}.lineNetAmount`, "Line net amount cannot be negative.");
    if (l.lineTaxAmount < 0) add(`${at}.lineTaxAmount`, "Line tax amount cannot be negative.");
    if (!(Number(l.priceBaseQty) > 0)) add(`${at}.priceBaseQty`, "Price base quantity must be greater than 0.");
    else if (round2((l.quantity * l.unitPrice) / l.priceBaseQty) !== round2(l.lineNetAmount)) {
      add(`${at}.lineNetAmount`, "Line net amount must equal quantity multiplied by unit price divided by price base quantity.");
    }
    if (round2(l.lineNetAmount + l.lineTaxAmount) !== round2(l.inclVatamount)) {
      add(`${at}.inclVatamount`, "Amount including VAT must equal line net amount plus line tax amount.");
    }
  });

  const sum = (k) => round2((p.lines || []).reduce((t, l) => t + (Number(l[k]) || 0), 0));
  if (round2(p.lineExtensionTotal) !== sum("lineNetAmount")) add("lineExtensionTotal", "Line Extension Total must equal the sum of line net amounts.");
  if (round2(p.taxAmount) !== sum("lineTaxAmount")) add("taxAmount", "Tax Amount must equal the sum of line tax amounts.");
  if (round2(p.totalIncludingTax) !== round2(p.lineExtensionTotal + p.taxAmount)) {
    add("totalIncludingTax", "Total Including Tax must equal Line Extension Total plus Tax Amount.");
  }
  if (round2(p.payableAmount) !== round2(p.totalIncludingTax + (p.roundingAmount || 0))) {
    add("payableAmount", "Sale E-Invoice totals do not reconcile. Please review the transaction and try again.");
  }
  const breakdownTax = round2((p.taxBreakdown || []).reduce((t, g) => t + g.taxAmount, 0));
  if (breakdownTax !== round2(p.taxAmount)) add("taxBreakdown", "The VAT breakdown does not add up to the invoice tax.");
  return issues;
}

// A canonical hash of what was sent, so a submitted invoice can be proven unchanged.
const stable = (v) =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, stable(v[k])]))
    : v;
const payloadHash = (payload) => crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");

// Submission status machine. Corrections after submission are a credit note plus a new invoice,
// never an edit, so REJECTED and REPORTED are terminal.
const STATUSES = ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED", "FAILED", "REJECTED"];
const TRANSITIONS = {
  QUEUED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "FAILED"],
  ACKNOWLEDGED: ["REPORTED", "REJECTED"],
  FAILED: ["QUEUED"], // a retry
  REJECTED: [],
  REPORTED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

module.exports = {
  TRN_RE, PARTICIPANT_RE, CATEGORY_BY_KIND, STATUSES, TRANSITIONS,
  taxCategoryFor, dubaiDate, isUae, buyerRequiresDetails, partyReadiness,
  buildPayload, validatePayload, payloadHash, canTransition,
};
