// The documents that can be sent, each turned into one shape the sender understands:
//
//   { docType, sourceType, sourceId, documentNo, date, dueDate, total, currency, partyId, partyName,
//     contactPerson, recipients[], phone, company, snapshot }
//
// Stage 1 covers the tax invoice. Each later document is another function here and nothing else in the
// pipeline changes.
//
// The company block is read the way the printed invoice reads it: from the profile of the person who
// is sending (the same profile their screen prints from), with the company settings filling any gap.
// It is copied, not called, from EInvoiceService.build(): that also loads e-invoice settings and runs
// e-invoice validation, which would let a customer missing an e-invoice ID block an ordinary email.
const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Admin = require("../../models/core/adminModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { invoiceSnapshot } = require("../../utils/shareSnapshot");

const notSendable = (reason) => new AppError(reason, 422, "DOCUMENT_NOT_SENDABLE");
const clean = (v) => String(v ?? "").trim();
const uniq = (list) => [...new Set(list.map((e) => clean(e).toLowerCase()).filter(Boolean))];

// The company as the invoice prints it. A value on the sender's own profile wins; the company
// settings fill what that profile leaves empty.
async function companyFor(req) {
  const { companyId } = getTenant(req);
  const [admin, cs] = await Promise.all([
    req?.admin?.id && mongoose.isValidObjectId(req.admin.id) ? Admin.findById(req.admin.id).select("companyInfo").lean() : null,
    CompanySettings.findOne({ companyId }).select("profile baseCurrency").lean(),
  ]);
  const c = admin?.companyInfo || {};
  const bank = c.bankDetails || {};
  const p = cs?.profile || {};
  const company = {
    companyName: clean(c.companyName) || clean(p.legalName),
    companyNameArabic: clean(c.companyNameArabic),
    addressLine1: clean(c.addressLine1) || clean(p.addressLine1),
    addressLine2: clean(c.addressLine2),
    phoneNumber: clean(c.phoneNumber) || clean(p.phone),
    email: clean(c.emailAddress) || clean(p.email),
    website: clean(c.website),
    vatNumber: clean(c.vatNumber) || clean(p.trn),
    logo: c.companyLogo?.url || null,
    bankName: clean(bank.bankName), accountNumber: clean(bank.accountNumber), accountName: clean(bank.accountName),
    ibanNumber: clean(bank.ibanNumber), swiftCode: clean(bank.swiftCode), branch: clean(c.branch),
  };
  return { company, currency: cs?.baseCurrency || "AED" };
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
