// What a customer may see at the public link to a document. Pure.
//
// THIS FILE IS THE SECURITY BOUNDARY of the share link. The public page reads one frozen copy and
// nothing else, and that copy is built here from an explicit list of fields, never by spreading a
// record. The records are full of things a customer must not see: an order line carries the unit
// cost, the margin and the batches it was taken from; a customer carries a credit limit, bank
// accounts and KYC files; an order carries internal notes and, if it was closed short, a whole copy
// of its earlier self. A field added to a model later is therefore invisible here until someone adds
// it on purpose, and utils/__tests__/shareSnapshot.test.js fails if the output ever grows by itself.
//
// The shapes mirror what the printed sheet reads (components/PurchaseOrder/shared/invoiceDocuments.js),
// so the page and the PDF attachment are drawn by the same builder from the same data.

const orgLocale = require("./orgLocale");

const pick = (src, keys) => {
  const out = {};
  for (const k of keys) if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return out;
};

// ---- the tax invoice ---------------------------------------------------------------------
// taxKind is there so the page and the PDF can say "reverse charge applies" on a line the customer accounts for the VAT on
// (UAE VAT Executive Regulation Art. 59(1)(l)): it is a treatment label, not a cost or a margin.
// India GST (hsnCode, gst, placeOfSupply, gstType): what a tax invoice must show the buyer - the item's HSN / SAC code, the tax by
// component and where the supply is made. The seller's own state code (supplierState) stays behind: it is not printed.
const LINE_KEYS = ["itemCode", "description", "qty", "rate", "vatPercent", "vatAmount", "taxKind", "lineTotal", "hsnCode", "gst"];
const CHARGE_KEYS = ["code", "description", "amount", "vatPercent", "vatAmount", "gst"];
const PRICING_KEYS = ["gross", "lineDiscount", "net", "lineVat", "chargesNet", "chargesVat", "headerDiscount", "roundOff", "grandTotal"];
const DOCUMENT_KEYS = ["transactionNo", "invoiceNumber", "status", "date", "deliveryDate", "dueDate", "lpono", "docno", "serialNo", "discount", "totalAmount", "placeOfSupply", "gstType"];
// The job card an invoice was raised from, picked down to what the customer's own copy prints: the job
// number and the vehicle. NEVER jobCardId - that is a database id and has no business on a public page.
const JOB_CARD_KEYS = ["jobNo", "plateNumber", "chassisNo"];
const PARTY_KEYS = ["customerName", "customerId", "billingAddress", "phone", "email", "trnNumber", "paymentTerms"];
// The company block is the shape the invoice screen already prints from (useCompanyProfile).
const COMPANY_KEYS = [
  "companyName", "companyNameArabic", "addressLine1", "addressLine2", "city", "state", "country",
  "phoneNumber", "email", "website",
  // `vatRegistered` rides beside the number because the heading is built from BOTH: without it the
  // customer's own copy could head a document "Tax invoice" that the sender's screen and PDF call an
  // "Invoice". It is a fact about us that is already printed on the sheet, not anything of theirs.
  "vatNumber", "vatRegistered", "logo", "bankName", "accountNumber", "accountName", "ibanNumber", "swiftCode", "branch",
];

// How the SENDING organisation writes a date, what calendar it writes it in, and which country it is
// in - so the customer's own copy reads exactly what the sender printed. Without this the public page
// renders in the VISITOR's browser: their date format, and Asia/Dubai regardless of where the seller
// is, which can print the wrong calendar DAY for any organisation outside that zone. None of the three
// is customer-sensitive; they are facts already printed on the document.
const LOCALE_KEYS = ["dateFormat", "timezone", "country"];
const localeBlock = () => ({ dateFormat: orgLocale.dateFormat(), timezone: orgLocale.timezone(), country: orgLocale.country() });

const toPlain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

// An invoice made in a foreign currency is stored in the base currency with the same document in its own beside it (utils/fxDocument.js): the customer
// is shown the document they were invoiced, in its currency, with the rate and the tax in the base currency (which is what the tax authority is paid in).
const FOREIGN_KEYS = ["currency", "exchangeRate", "baseVat"];
function foreignView(tx) {
  const fx = tx.fx;
  const lines = (tx.items || []).map((i) => {
    const l = toPlain(i);
    return l?.fx ? { ...l, rate: l.fx.taxableAmount ?? l.rate, vatAmount: l.fx.vatAmount ?? l.vatAmount, lineTotal: l.fx.lineTotal ?? l.lineTotal } : l;
  });
  const charges = (tx.charges || []).map((x) => {
    const c = toPlain(x);
    return c?.fx ? { ...c, amount: c.fx.amount, vatAmount: c.fx.vatAmount } : c;
  });
  const baseVat = Math.round((((tx.pricing?.lineVat) || 0) + ((tx.pricing?.chargesVat) || 0) + Number.EPSILON) * 100) / 100;
  return { ...tx, items: lines, charges, pricing: fx.pricing || tx.pricing, totalAmount: fx.totalAmount ?? tx.totalAmount, currency: fx.currency, exchangeRate: fx.rate, baseVat };
}

function invoiceSnapshot({ transaction, customer, company, currency = orgLocale.baseCurrency() }) {
  const raw = toPlain(transaction) || {};
  const tx = raw.fx?.currency ? foreignView(raw) : raw;
  const c = toPlain(customer) || {};
  const document = {
    ...pick(tx, DOCUMENT_KEYS),
    ...(raw.fx?.currency ? pick(tx, FOREIGN_KEYS) : {}),
    items: (tx.items || []).map((i) => pick(toPlain(i), LINE_KEYS)),
    charges: (tx.charges || []).map((x) => pick(toPlain(x), CHARGE_KEYS)),
    pricing: pick(toPlain(tx.pricing), PRICING_KEYS),
  };
  // The job card, when this invoice came from one, so the customer's copy names the car exactly as the
  // printed sheet does. Picked, never spread: the id stays behind.
  if (tx.jobCardRef) {
    const job = pick(toPlain(tx.jobCardRef), JOB_CARD_KEYS);
    if (Object.keys(job).length) document.jobCardRef = job;
  }
  const party = { ...pick(c, PARTY_KEYS) };
  // Only the registration number and the registration status of a customer's VAT block, never the block itself: the invoice
  // prints "TRN ..." and "VAT status Registered" under the customer's name, and the status is the customer's own fact.
  const vat = c.vat || {};
  const status = typeof vat.status === "string" && vat.status ? vat.status : null;
  if (vat.trn || status) party.vat = { ...(status ? { status } : {}), ...(vat.trn ? { trn: vat.trn } : {}) };
  // Where the customer is, for the locality line under their address. The two fields a tax invoice needs
  // and nothing else from the e-invoice block - above all never `participantId`, which is a Peppol routing
  // address and is no part of a printed document.
  const ei = c.eInvoice || {};
  if (ei.city || ei.countryCode) {
    party.eInvoice = { ...(ei.city ? { city: ei.city } : {}), ...(ei.countryCode ? { countryCode: ei.countryCode } : {}) };
  }
  return {
    kind: "tax_invoice",
    document,
    party,
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
    locale: localeBlock(),
  };
}

// ---- the job card's estimate -------------------------------------------------------------------
// What a workshop customer sees before they approve the work, and the ONE snapshot a customer may act
// on rather than only read (routes/messaging/shareRoutes.js estimate-decision).
//
// THE LINE _id IS DELIBERATELY INCLUDED HERE, and it is the only id in any snapshot. A decision names
// the lines it approves, so the id has to make the round trip. It is a subdocument id of a line on a
// card whose secret link the caller already holds, it addresses nothing on its own, and every id that
// comes back is checked against the live card again (utils/garage.js checkApproval) before anything is
// written. Every OTHER id stays behind exactly as it does for the invoice - above all itemId, which
// points at a Stock record.
//
// What a line must never carry to a customer: `vendorId`/`vendorName` (who we sublet the work to is
// ours, not theirs), `issuedQty` and `invoiced` (internal progress), `itemId`/`taxCodeId` (database
// ids), and anything the costing engine knows. The parts of a job card that are purely internal -
// tasks, who is working on it, purchase orders raised, the claim, estimateHistory, notes - are not
// listed at all, so they cannot appear by accident.
const ESTIMATE_LINE_KEYS = [
  "_id", "kind", "description", "qty", "price", "discountPercent", "discountAmount",
  "vatPercent", "vatAmount", "lineTotal", "approved", "complaintId", "addedInVersion",
];
// The 3 Cs, less the third: "correction" is what was done to fix it, which is not yet a fact when the
// customer is being asked to approve the work. `status` is the workshop's own progress word.
const COMPLAINT_KEYS = ["seq", "concern", "cause"];
// An inspection item the customer is being shown the evidence for. `photos` are attachment ids, fetched
// back through the token-scoped photo route - never a URL to the authenticated attachment door.
const INSPECTION_KEYS = ["_id", "item", "condition", "note", "photos"];
const VEHICLE_KEYS = ["plateNumber", "plateCode", "plateEmirate", "make", "model", "year", "colour", "chassisNo"];
const ESTIMATE_KEYS = ["version", "total", "sentAt", "decidedAt", "method"];
const JOB_KEYS = ["jobNo", "status", "receivedAt", "promisedAt", "odometerIn"];
// The customer's own name and how to reach them. A workshop customer is a Customer record like any
// other, so the same rule applies: never the credit limit, the balance, the bank accounts or the KYC.
const ESTIMATE_PARTY_KEYS = ["customerName", "phone", "email", "trnNumber"];
const TOTAL_KEYS = ["part", "labour", "sublet", "consumable", "net", "vat", "total"];

function estimateSnapshot({ card, customer, company, totals, currency = orgLocale.baseCurrency() }) {
  const c = toPlain(card) || {};
  const party = toPlain(customer) || {};
  const job = {
    ...pick(c, JOB_KEYS),
    vehicle: pick(toPlain(c.vehicle), VEHICLE_KEYS),
    estimate: pick(toPlain(c.estimate), ESTIMATE_KEYS),
    complaints: (c.complaints || []).map((x) => pick(toPlain(x), COMPLAINT_KEYS)),
    lines: (c.lines || []).map((l) => pick(toPlain(l), ESTIMATE_LINE_KEYS)),
    inspection: (c.inspection || []).map((i) => pick(toPlain(i), INSPECTION_KEYS)),
  };
  return {
    kind: "job_estimate",
    job,
    // What the lines come to, worked out server-side (utils/garage.js jobTotals) and passed in, so the
    // page never adds money up for itself and a tampered line cannot change a total.
    totals: pick(totals, TOTAL_KEYS),
    party: pick(party, ESTIMATE_PARTY_KEYS),
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
    locale: localeBlock(),
  };
}

// Every field path the invoice snapshot may ever contain. Exported so the test can hold the output
// to exactly this list.
const INVOICE_ALLOWED = {
  document: [...DOCUMENT_KEYS, "items", "charges", "pricing", "jobCardRef"],
  jobCardRef: JOB_CARD_KEYS,
  line: LINE_KEYS,
  charge: CHARGE_KEYS,
  pricing: PRICING_KEYS,
  party: [...PARTY_KEYS, "vat", "eInvoice"],
  eInvoice: ["city", "countryCode"],
  company: COMPANY_KEYS,
  locale: LOCALE_KEYS,
  top: ["kind", "document", "party", "company", "currency", "locale"],
};

// The same contract for the estimate: the test holds the output to exactly this list, so a field added
// to the job card, the vehicle or a line later is invisible here until someone adds it on purpose.
const ESTIMATE_ALLOWED = {
  locale: LOCALE_KEYS,
  top: ["kind", "job", "totals", "party", "company", "currency", "locale"],
  job: [...JOB_KEYS, "vehicle", "estimate", "complaints", "lines", "inspection"],
  vehicle: VEHICLE_KEYS,
  estimate: ESTIMATE_KEYS,
  complaint: COMPLAINT_KEYS,
  line: ESTIMATE_LINE_KEYS,
  inspection: INSPECTION_KEYS,
  totals: TOTAL_KEYS,
  party: ESTIMATE_PARTY_KEYS,
  company: COMPANY_KEYS,
};

// ---- the quotation ---------------------------------------------------------------------------
// The customer's copy of an offer: the same document the printed sheet draws (components/salesDocs/documents.js
// buildQuotationDocument), priced by the server. The internal `notes` and who prepared it stay behind; `terms` is printed on the offer.
const QUOTE_LINE_KEYS = ["itemCode", "description", "qty", "price", "discountPercent", "taxableAmount", "vatPercent", "vatAmount", "taxKind", "lineTotal", "hsnCode", "gst"];
const QUOTE_DOCUMENT_KEYS = ["quotationNo", "date", "validUntil", "reference", "status", "terms", "discount", "totalAmount", "placeOfSupply", "gstType"];

function quotationSnapshot({ quotation, customer, company, currency = orgLocale.baseCurrency() }) {
  const q = toPlain(quotation) || {};
  return {
    kind: "quotation",
    document: {
      ...pick(q, QUOTE_DOCUMENT_KEYS),
      items: (q.items || []).map((i) => pick(toPlain(i), QUOTE_LINE_KEYS)),
      charges: (q.charges || []).map((x) => pick(toPlain(x), CHARGE_KEYS)),
      pricing: pick(toPlain(q.pricing), PRICING_KEYS),
    },
    party: partyBlock(customer),
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
    locale: localeBlock(),
  };
}

// ---- the delivery note -----------------------------------------------------------------------
// The paper that travels with the goods. It prints NO prices (buildDeliveryNoteDocument showPrices is false), so none are sent: a
// customer's copy of a note carries quantities, the delivery particulars and the proof of receipt.
const NOTE_LINE_KEYS = ["itemCode", "description", "qty", "deliveredQty", "shortReason"];
const NOTE_DOCUMENT_KEYS = [
  "deliveryNoteNo", "date", "status", "reference", "deliveryAddress", "contactPerson", "contactPhone", "vehicleNo", "driverName", "driverPhone",
  "notes", "deliveredAt", "receivedBy", "proofNote",
];
const NOTE_SOURCE_KEYS = ["kind", "no"];

function deliveryNoteSnapshot({ note, customer, company, currency = orgLocale.baseCurrency() }) {
  const n = toPlain(note) || {};
  const document = { ...pick(n, NOTE_DOCUMENT_KEYS), items: (n.items || []).map((i) => pick(toPlain(i), NOTE_LINE_KEYS)) };
  const source = pick(toPlain(n.source), NOTE_SOURCE_KEYS);
  if (source.no) document.source = source;
  return {
    kind: "delivery_note",
    document,
    party: { ...partyBlock(customer), ...pick(toPlain(customer) || {}, ["shippingAddress"]) },
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
    locale: localeBlock(),
  };
}

// ---- the statement of account ----------------------------------------------------------------
// What the customer owes us over a period, row by row. `balance` is signed for the customer (positive = they owe us). A voucher's
// internal id and the ledger account behind it stay behind: the customer sees the date, our reference, what it was and the amounts.
const STATEMENT_ROW_KEYS = ["date", "voucherNo", "voucherType", "narration", "debit", "credit", "balance"];
const STATEMENT_KEYS = ["from", "to", "opening", "closing", "totals"];
const STATEMENT_TOTAL_KEYS = ["debit", "credit"];
const MAX_STATEMENT_ROWS = 1000;

function statementSnapshot({ statement, customer, company, currency = orgLocale.baseCurrency() }) {
  const s = toPlain(statement) || {};
  return {
    kind: "statement",
    statement: {
      ...pick(s, STATEMENT_KEYS),
      totals: pick(toPlain(s.totals), STATEMENT_TOTAL_KEYS),
      rows: (s.rows || []).slice(0, MAX_STATEMENT_ROWS).map((r) => pick(toPlain(r), STATEMENT_ROW_KEYS)),
      truncated: (s.rows || []).length > MAX_STATEMENT_ROWS,
    },
    party: pick(toPlain(customer) || {}, ["customerName", "customerId", "billingAddress", "trnNumber"]),
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
    locale: localeBlock(),
  };
}

// The customer block the printed documents read: name, code, address, how to reach them, tax number and terms (never credit, balance, banks, KYC).
function partyBlock(customer) {
  const c = toPlain(customer) || {};
  const party = { ...pick(c, PARTY_KEYS) };
  const vat = c.vat || {};
  const status = typeof vat.status === "string" && vat.status ? vat.status : null;
  if (vat.trn || status) party.vat = { ...(status ? { status } : {}), ...(vat.trn ? { trn: vat.trn } : {}) };
  const ei = c.eInvoice || {};
  if (ei.city || ei.countryCode) party.eInvoice = { ...(ei.city ? { city: ei.city } : {}), ...(ei.countryCode ? { countryCode: ei.countryCode } : {}) };
  return party;
}

const QUOTATION_ALLOWED = {
  top: ["kind", "document", "party", "company", "currency", "locale"],
  document: [...QUOTE_DOCUMENT_KEYS, "items", "charges", "pricing"],
  line: QUOTE_LINE_KEYS, charge: CHARGE_KEYS, pricing: PRICING_KEYS,
  party: [...PARTY_KEYS, "vat", "eInvoice"], eInvoice: ["city", "countryCode"], company: COMPANY_KEYS, locale: LOCALE_KEYS,
};
const DELIVERY_NOTE_ALLOWED = {
  top: ["kind", "document", "party", "company", "currency", "locale"],
  document: [...NOTE_DOCUMENT_KEYS, "items", "source"],
  line: NOTE_LINE_KEYS, source: NOTE_SOURCE_KEYS,
  party: [...PARTY_KEYS, "vat", "eInvoice", "shippingAddress"], eInvoice: ["city", "countryCode"], company: COMPANY_KEYS, locale: LOCALE_KEYS,
};
const STATEMENT_ALLOWED = {
  top: ["kind", "statement", "party", "company", "currency", "locale"],
  statement: [...STATEMENT_KEYS, "rows", "truncated"], row: STATEMENT_ROW_KEYS, totals: STATEMENT_TOTAL_KEYS,
  party: ["customerName", "customerId", "billingAddress", "trnNumber"], company: COMPANY_KEYS, locale: LOCALE_KEYS,
};

module.exports = {
  invoiceSnapshot, INVOICE_ALLOWED, estimateSnapshot, ESTIMATE_ALLOWED, pick,
  quotationSnapshot, QUOTATION_ALLOWED, deliveryNoteSnapshot, DELIVERY_NOTE_ALLOWED, statementSnapshot, STATEMENT_ALLOWED,
};
