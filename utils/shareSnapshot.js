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
const LINE_KEYS = ["itemCode", "description", "qty", "rate", "vatPercent", "vatAmount", "taxKind", "lineTotal"];
const CHARGE_KEYS = ["code", "description", "amount", "vatPercent", "vatAmount"];
const PRICING_KEYS = ["gross", "lineDiscount", "net", "lineVat", "chargesNet", "chargesVat", "headerDiscount", "roundOff", "grandTotal"];
const DOCUMENT_KEYS = ["transactionNo", "invoiceNumber", "status", "date", "deliveryDate", "dueDate", "lpono", "docno", "serialNo", "discount", "totalAmount"];
// The job card an invoice was raised from, picked down to what the customer's own copy prints: the job
// number and the vehicle. NEVER jobCardId - that is a database id and has no business on a public page.
const JOB_CARD_KEYS = ["jobNo", "plateNumber", "chassisNo"];
const PARTY_KEYS = ["customerName", "customerId", "billingAddress", "phone", "email", "trnNumber", "paymentTerms"];
// The company block is the shape the invoice screen already prints from (useCompanyProfile).
const COMPANY_KEYS = [
  "companyName", "companyNameArabic", "addressLine1", "addressLine2", "city", "state", "country",
  "phoneNumber", "email", "website",
  "vatNumber", "logo", "bankName", "accountNumber", "accountName", "ibanNumber", "swiftCode", "branch",
];

const toPlain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

function invoiceSnapshot({ transaction, customer, company, currency = orgLocale.baseCurrency() }) {
  const tx = toPlain(transaction) || {};
  const c = toPlain(customer) || {};
  const document = {
    ...pick(tx, DOCUMENT_KEYS),
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
  top: ["kind", "document", "party", "company", "currency"],
};

// The same contract for the estimate: the test holds the output to exactly this list, so a field added
// to the job card, the vehicle or a line later is invisible here until someone adds it on purpose.
const ESTIMATE_ALLOWED = {
  top: ["kind", "job", "totals", "party", "company", "currency"],
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

module.exports = { invoiceSnapshot, INVOICE_ALLOWED, estimateSnapshot, ESTIMATE_ALLOWED, pick };
