// The documents that can be sent, each turned into one shape the sender understands:
//
//   { docType, sourceType, sourceId, documentNo, date, dueDate, total, currency, partyId, partyName,
//     contactPerson, recipients[], phone, company, snapshot }
//
// The tax invoice, the garage estimate, the quotation, the delivery note and a customer's statement. Each document is one function here
// and nothing else in the pipeline changes.
//
// The company block is read the way the printed invoice reads it: the organisation's own letterhead
// (services/core/companyProfileService.js), whoever is sending.
// It is copied, not called, from EInvoiceService.build(): that also loads e-invoice settings and runs
// e-invoice validation, which would let a customer missing an e-invoice ID block an ordinary email.
const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const CompanyProfileService = require("../core/companyProfileService");
const orgLocale = require("../../utils/orgLocale");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { invoiceSnapshot, estimateSnapshot, quotationSnapshot, deliveryNoteSnapshot, statementSnapshot } = require("../../utils/shareSnapshot");
const Quotation = require("../../models/modules/quotationModel");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const StatementService = require("../financial/statementService");
const { quotationExpiry } = require("../../utils/salesDocuments");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const orgDay = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : toExpiryDay(v));
const JobCard = require("../../models/modules/garage/jobCardModel");
const rules = require("../../utils/garage");

const notSendable = (reason) => new AppError(reason, 422, "DOCUMENT_NOT_SENDABLE");
const clean = (v) => String(v ?? "").trim();
const uniq = (list) => [...new Set(list.map((e) => clean(e).toLowerCase()).filter(Boolean))];

// The company as the invoice prints it: the ORGANISATION's letterhead (services/core/companyProfileService.js), the same one
// the screens print from, whoever happens to be sending. (It used to be the sender's own copy of it.)
async function companyFor(req) {
  const { companyId } = getTenant(req);
  const [c, cs] = await Promise.all([
    CompanyProfileService.get(),
    CompanySettings.findOne({ companyId }).select("baseCurrency").lean(),
  ]);
  const bank = c.bankDetails || {};
  const company = {
    companyName: c.companyName,
    companyNameArabic: c.companyNameArabic,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    // The rest of the address. This mapping and the browser's own `useCompanyProfile` must carry the
    // same fields or the copy a customer is emailed prints a different letterhead from the one on screen.
    city: c.city,
    state: c.state,
    country: c.country,
    phoneNumber: c.phoneNumber,
    email: c.emailAddress,
    website: c.website,
    vatNumber: c.vatNumber,
    vatRegistered: c.vatRegistered,
    logo: c.companyLogo?.url || null,
    bankName: bank.bankName, accountNumber: bank.accountNumber, accountName: bank.accountName,
    ibanNumber: bank.ibanNumber, swiftCode: bank.swiftCode, branch: c.branch,
  };
  return { company, currency: cs?.baseCurrency || orgLocale.baseCurrency() };
}

// Where a document could go: the customer's own address, then the primary contact, then the rest.
function recipientsOf(customer) {
  const contacts = customer.contacts || [];
  const primary = contacts.filter((c) => c.isPrimary).map((c) => c.email);
  const others = contacts.filter((c) => !c.isPrimary).map((c) => c.email);
  return uniq([customer.email, ...primary, ...others]);
}

async function loadInvoice(sourceId, req) {
  if (!mongoose.isValidObjectId(sourceId)) throw new AppError("Document not found", 404, "DOCUMENT_NOT_FOUND");
  const tx = await Transaction.findById(sourceId).lean();
  if (!tx || tx.type !== "sales_order") throw new AppError("Document not found", 404, "DOCUMENT_NOT_FOUND");
  if (tx.isOpening) throw notSendable("An opening balance invoice was issued before go-live and is not sent from here");
  if (tx.status !== "APPROVED") {
    throw notSendable(tx.status === "DRAFT" ? "This order is not approved yet, so it is not a tax invoice. Approve it first." : `A ${String(tx.status).toLowerCase()} order cannot be sent`);
  }
  const customer = await Customer.findById(tx.partyId).lean();
  if (!customer) throw new AppError("The customer of this invoice was not found", 404, "CUSTOMER_NOT_FOUND");
  const { company, currency } = await companyFor(req);
  // An invoice made in a foreign currency carries that document beside the base one (Transaction.fx, services/financial/
  // fxDocumentService.js). The customer was quoted - and the PDF and the link show - the FOREIGN total, so the email says the
  // foreign total in the foreign currency, never the base-currency equivalent. (It used to: an invoice of 5,000 USD was announced
  // as "for 18,350.00 AED".) The snapshot keeps being given the base currency: it reads the foreign document itself.
  const foreign = tx.fx?.currency && Number.isFinite(Number(tx.fx.totalAmount)) ? tx.fx : null;
  return {
    docType: "tax_invoice",
    sourceType: "Transaction",
    sourceId: tx._id,
    documentNo: tx.invoiceNumber || tx.transactionNo,
    date: tx.date,
    dueDate: tx.dueDate || null,
    total: foreign ? foreign.totalAmount : tx.pricing?.grandTotal ?? tx.totalAmount,
    currency: foreign ? foreign.currency : currency,
    partyId: customer._id,
    partyName: customer.customerName,
    contactPerson: customer.contactPerson || "",
    recipients: recipientsOf(customer),
    phone: customer.phone || (customer.contacts || []).find((c) => c.isPrimary)?.phone || "",
    company,
    snapshot: invoiceSnapshot({ transaction: tx, customer, company, currency }),
  };
}

// The workshop's estimate, the one document here the customer is asked to ACT on rather than file.
// It is sendable only while a decision is actually outstanding: AWAITING_APPROVAL, or IN_PROGRESS with
// lines a revision added that nobody has decided yet (utils/garage.js recordApproval's "later decision").
// Sending a card that is already settled would invite a second approval of work in hand.
async function loadEstimate(sourceId, req) {
  if (!mongoose.isValidObjectId(sourceId)) throw new AppError("Job card not found", 404, "DOCUMENT_NOT_FOUND");
  const card = await JobCard.findById(sourceId).lean();
  if (!card) throw new AppError("Job card not found", 404, "DOCUMENT_NOT_FOUND");
  if (!card.lines?.length) throw notSendable("There is nothing to approve on this job card yet");
  const pending = card.status === "AWAITING_APPROVAL" || (card.status === "IN_PROGRESS" && card.lines.some((l) => l.approved === false));
  if (!pending) {
    throw notSendable(
      card.status === "DRAFT"
        ? "This estimate has not been sent for approval yet. Send the estimate first."
        : `This job is ${String(card.status).toLowerCase()}, so there is no decision outstanding`
    );
  }
  const customer = await Customer.findById(card.customerId).lean();
  if (!customer) throw new AppError("The customer of this job card was not found", 404, "CUSTOMER_NOT_FOUND");
  const { company, currency } = await companyFor(req);
  // Worked out here, server-side, and frozen into the snapshot: the page never adds money up itself.
  const kinds = rules.jobTotals(card);
  const vat = (card.lines || []).filter(rules.isApproved).reduce((sum, l) => sum + (Number(l.vatAmount) || 0), 0);
  const net = Number(kinds.total) || 0;
  const totals = { part: kinds.part, labour: kinds.labour, sublet: kinds.sublet, consumable: kinds.consumable, net, vat: Math.round(vat * 100) / 100, total: Math.round((net + vat) * 100) / 100 };
  const vehicleText = [card.vehicle?.plateNumber, [card.vehicle?.make, card.vehicle?.model].filter(Boolean).join(" ")].filter(Boolean).join(" - ");
  return {
    docType: "job_estimate",
    sourceType: "JobCard",
    sourceId: card._id,
    documentNo: card.jobNo || "",
    date: card.receivedAt,
    dueDate: null,
    total: totals.total,
    currency,
    vehicleText, // the email says which car, because a customer may have several with us
    partyId: customer._id,
    partyName: customer.customerName,
    contactPerson: customer.contactPerson || "",
    recipients: recipientsOf(customer),
    phone: card.customer?.phone || customer.phone || (customer.contacts || []).find((c) => c.isPrimary)?.phone || "",
    company,
    snapshot: estimateSnapshot({ card, customer, company, totals, currency }),
  };
}

const customerOf = async (id, what) => {
  const customer = await Customer.findById(id).lean();
  if (!customer) throw new AppError(`The customer of this ${what} was not found`, 404, "CUSTOMER_NOT_FOUND");
  return customer;
};
const phoneOf = (customer) => customer.phone || (customer.contacts || []).find((c) => c.isPrimary)?.phone || "";

// An offer. Sendable while the customer could still act on it: a draft (sending it marks it Sent, services/messaging/messagingService.js),
// one already sent or accepted. A lapsed, declined, replaced or converted one is not an offer any more.
async function loadQuotation(sourceId, req) {
  if (!mongoose.isValidObjectId(sourceId)) throw new AppError("Quotation not found", 404, "DOCUMENT_NOT_FOUND");
  const q = await Quotation.findById(sourceId).lean();
  if (!q) throw new AppError("Quotation not found", 404, "DOCUMENT_NOT_FOUND");
  if (!["DRAFT", "SENT", "ACCEPTED"].includes(q.status)) {
    throw notSendable(`A ${String(q.status).toLowerCase()} quotation is not sent. ${q.status === "CONVERTED" ? "It has become an order." : "Revise it to offer it again."}`);
  }
  if (!q.items?.length) throw notSendable("A quotation with no items cannot be sent");
  if (quotationExpiry(q).expired) throw notSendable("Its validity has passed. Change the 'valid until' date first, or revise it.");
  const customer = await customerOf(q.partyId, "quotation");
  const { company, currency } = await companyFor(req);
  return {
    docType: "quotation", sourceType: "Quotation", sourceId: q._id, documentNo: q.quotationNo, date: q.date, dueDate: null, validUntil: q.validUntil,
    total: q.pricing?.grandTotal ?? q.totalAmount, currency, partyId: customer._id, partyName: customer.customerName,
    contactPerson: customer.contactPerson || "", recipients: recipientsOf(customer), phone: phoneOf(customer), company,
    snapshot: quotationSnapshot({ quotation: q, customer, company, currency }),
  };
}

// The paper that travels with the goods: sendable once the goods are on the road or signed for. A draft is not yet a document anyone holds.
async function loadDeliveryNote(sourceId, req) {
  if (!mongoose.isValidObjectId(sourceId)) throw new AppError("Delivery note not found", 404, "DOCUMENT_NOT_FOUND");
  const n = await DeliveryNote.findById(sourceId).lean();
  if (!n) throw new AppError("Delivery note not found", 404, "DOCUMENT_NOT_FOUND");
  if (!["DISPATCHED", "DELIVERED"].includes(n.status)) {
    throw notSendable(n.status === "DRAFT" ? "This delivery note has not been dispatched yet. Dispatch it first." : `A ${String(n.status).toLowerCase()} delivery note is not sent`);
  }
  const customer = await customerOf(n.partyId, "delivery note");
  const { company, currency } = await companyFor(req);
  return {
    docType: "delivery_note", sourceType: "DeliveryNote", sourceId: n._id, documentNo: n.deliveryNoteNo, date: n.date, dueDate: null,
    total: n.pricing?.grandTotal ?? n.totalAmount, currency, partyId: customer._id, partyName: customer.customerName,
    contactPerson: n.contactPerson || customer.contactPerson || "", recipients: recipientsOf(customer), phone: n.contactPhone || phoneOf(customer), company,
    snapshot: deliveryNoteSnapshot({ note: n, customer, company, currency }),
  };
}

// A customer's statement of account for a period, to chase a balance or agree one. Customers only: a supplier's statement is theirs to send.
// The source is the CUSTOMER (nothing is stored for a statement); the period comes with the request and defaults to this calendar year to date.
async function loadStatement(sourceId, req, options = {}) {
  if (!mongoose.isValidObjectId(sourceId)) throw new AppError("Customer not found", 404, "DOCUMENT_NOT_FOUND");
  const customer = await Customer.findById(sourceId).lean();
  if (!customer) throw new AppError("Customer not found", 404, "DOCUMENT_NOT_FOUND");
  const today = todayInOrg();
  const from = options.from ? orgDay(options.from) : `${today.slice(0, 4)}-01-01`;
  const to = options.to ? orgDay(options.to) : today;
  if (!from || !to) throw new AppError("That period is not valid", 400, "INVALID_DATE");
  if (from > to) throw new AppError("The period starts after it ends", 400, "INVALID_RANGE");
  const statement = await StatementService.getStatement({ partyId: customer._id, partyType: "Customer", from, to: `${to}T23:59:59.999Z` }); // the whole last day, whatever time of day a posting was stamped
  const { company, currency } = await companyFor(req);
  return {
    docType: "statement", sourceType: "Customer", sourceId: customer._id, documentNo: `Statement ${from} to ${to}`, date: to, dueDate: null,
    period: { from, to }, total: statement.closing, currency, partyId: customer._id, partyName: customer.customerName,
    contactPerson: customer.contactPerson || "", recipients: recipientsOf(customer), phone: phoneOf(customer), company,
    snapshot: statementSnapshot({ statement: { ...statement, from, to }, customer, company, currency }),
  };
}

const LOADERS = { tax_invoice: loadInvoice, job_estimate: loadEstimate, quotation: loadQuotation, delivery_note: loadDeliveryNote, statement: loadStatement };
const SUPPORTED = Object.keys(LOADERS);

// docType + id -> the document, or a clear refusal.
async function load(docType, sourceId, req, options = {}) {
  const fn = LOADERS[docType];
  if (!fn) throw new AppError(`Sending a ${docType || "document"} is not available`, 400, "UNKNOWN_DOC_TYPE");
  return fn(sourceId, req, options);
}

module.exports = { load, SUPPORTED, companyFor, recipientsOf };
