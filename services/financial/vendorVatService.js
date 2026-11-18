const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const AuditService = require("../core/auditService");
const orgLocale = require("../../utils/orgLocale");
const { orgTaxTerms } = require("../../utils/countryRules");
const { ACK_FIELD, unregisteredVendorWarning } = require("../../utils/vendorVat");

// The check made when a purchase bill is approved (TransactionService.processTransaction): a supplier that is not registered for the tax cannot
// charge it. It is a WARNING that must be acknowledged, never a refusal, and it uses the same answer as the credit-limit warning
// (409 RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED naming the field to send back), so every screen that already asks about a credit warning asks
// about this one.
class VendorVatService {
  static ACK_FIELD = ACK_FIELD;

  static async assertBillAllowed(transaction, { session, acknowledged = false, req } = {}) {
    if (transaction.type !== "purchase_order" || transaction.isOpening) return;
    // (test switch, like VAT_REGISTRATION_RULES: the older suites buy from suppliers with no tax number and approve; a deployment never sets this)
    if (process.env.VENDOR_VAT_WARNING === "off") return;
    const Vendor = mongoose.model("Vendor");
    const q = Vendor.findById(transaction.partyId).select("vendorName vat trnNO").lean();
    const vendor = await (session ? q.session(session) : q);
    const warning = unregisteredVendorWarning({
      doc: typeof transaction.toObject === "function" ? transaction.toObject() : transaction,
      vendor,
      taxName: orgTaxTerms().tax,
      currency: orgLocale.baseCurrency(),
    });
    if (!warning) return;
    if (!acknowledged) {
      throw new AppError(warning.message, 409, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED", {
        risk: {
          operation: "bill.unregistered_vendor_vat",
          acknowledgementField: ACK_FIELD,
          title: `${orgTaxTerms().tax} warning`,
          party: vendor?.vendorName || null,
          breaches: [{ code: "VENDOR_NOT_REGISTERED", message: warning.message, amount: warning.tax }],
        },
      });
    }
    await AuditService.log({
      req,
      action: "VENDOR_VAT_WARNING_ACKNOWLEDGED",
      entity: "Transaction",
      entityId: transaction._id,
      summary: `${transaction.transactionNo}: ${warning.message}`,
    });
  }
}

module.exports = VendorVatService;
