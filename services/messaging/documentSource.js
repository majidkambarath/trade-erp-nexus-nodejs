// The documents that can be sent, each turned into one shape the sender understands:
//
//   { docType, sourceType, sourceId, documentNo, date, dueDate, total, currency, partyId, partyName,
//     contactPerson, recipients[], phone, company, snapshot }
//
// Stage 1 covers the tax invoice. Each later document is another function here and nothing else in the
// pipeline changes.
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
const { invoiceSnapshot } = require("../../utils/shareSnapshot");

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
    phoneNumber: c.phoneNumber,
    email: c.emailAddress,
    website: c.website,
    vatNumber: c.vatNumber,
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
  return {
    docType: "tax_invoice",
    sourceType: "Transaction",
    sourceId: tx._id,
    documentNo: tx.invoiceNumber || tx.transactionNo,
    date: tx.date,
    dueDate: tx.dueDate || null,
    total: tx.pricing?.grandTotal ?? tx.totalAmount,
    currency,
    partyId: customer._id,
    partyName: customer.customerName,
    contactPerson: customer.contactPerson || "",
    recipients: recipientsOf(customer),
    phone: customer.phone || (customer.contacts || []).find((c) => c.isPrimary)?.phone || "",
    company,
    snapshot: invoiceSnapshot({ transaction: tx, customer, company, currency }),
  };
}

const LOADERS = { tax_invoice: loadInvoice };
const SUPPORTED = Object.keys(LOADERS);

// docType + id -> the document, or a clear refusal.
async function load(docType, sourceId, req) {
  const fn = LOADERS[docType];
  if (!fn) throw new AppError(`Sending a ${docType || "document"} is not available`, 400, "UNKNOWN_DOC_TYPE");
  return fn(sourceId, req);
}

module.exports = { load, SUPPORTED, companyFor, recipientsOf };
