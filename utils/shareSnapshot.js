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
const DOCUMENT_KEYS = ["transactionNo", "invoiceNumber", "status", "date", "deliveryDate", "dueDate", "lpono", "docno", "discount", "totalAmount"];
const PARTY_KEYS = ["customerName", "customerId", "billingAddress", "phone", "email", "trnNumber", "paymentTerms"];
// The company block is the shape the invoice screen already prints from (useCompanyProfile).
const COMPANY_KEYS = [
  "companyName", "companyNameArabic", "addressLine1", "addressLine2", "phoneNumber", "email", "website",
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
  const party = { ...pick(c, PARTY_KEYS) };
  // Only the registration number of a customer's VAT block, never the block itself.
  if (c.vat && c.vat.trn) party.vat = { trn: c.vat.trn };
  return {
    kind: "tax_invoice",
    document,
    party,
    company: pick(toPlain(company), COMPANY_KEYS),
    currency,
  };
}

// Every field path the invoice snapshot may ever contain. Exported so the test can hold the output
// to exactly this list.
const INVOICE_ALLOWED = {
  document: [...DOCUMENT_KEYS, "items", "charges", "pricing"],
  line: LINE_KEYS,
  charge: CHARGE_KEYS,
  pricing: PRICING_KEYS,
  party: [...PARTY_KEYS, "vat"],
  company: COMPANY_KEYS,
  top: ["kind", "document", "party", "company", "currency"],
};

module.exports = { invoiceSnapshot, INVOICE_ALLOWED, pick };
