const mongoose = require("mongoose");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AgeingService = require("./ageingService");
const AuditService = require("../core/auditService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { round2 } = require("../../utils/accounting");

const ACK_FIELD = "riskAck_limit_party_credit";

// Credit control gates SALES only, and only when approving: that is the point where exposure to a
// customer actually grows. Returns, payments and purchases never pass through here - a
// transaction that reduces exposure is never blocked.
//
// Modes (per company):  off  - no check
//                       warn - 409 until the caller resends with riskAck_limit_party_credit: true
//                       block - 403, no override
// Two tests: the customer's credit limit, and an overdue-invoice limit.
class CreditControlService {
  static ACK_FIELD = ACK_FIELD;

  static async settings(session) {
    const q = CompanySettings.findOne({ companyId: getTenant().companyId }).select("creditControl").lean();
    const s = await (session ? q.session(session) : q);
    return { mode: "off", overdueBlockDays: 0, ...(s?.creditControl || {}) };
  }

  // Pure rule, separated so it can be tested without a database.
  //   balance: the customer's running balance, negative = they owe us (Customer.cashBalance)
  static evaluate({ creditLimit, balance, orderTotal, overdueInvoices = [], overdueBlockDays = 0 }) {
    const breaches = [];
    const owed = Math.max(0, -(Number(balance) || 0));
    const projected = round2(owed + (Number(orderTotal) || 0));
    if (creditLimit > 0 && projected > creditLimit + 0.005) {
      breaches.push({
        kind: "credit_limit",
        message: `Credit limit ${creditLimit.toFixed(2)} would be exceeded: owes ${owed.toFixed(2)}, this order ${Number(orderTotal).toFixed(2)}, total ${projected.toFixed(2)}`,
        creditLimit, owed: round2(owed), orderTotal: round2(orderTotal), projected,
      });
    }
    if (overdueBlockDays > 0) {
      const late = overdueInvoices.filter((i) => i.daysPastDue > overdueBlockDays);
      if (late.length) {
        breaches.push({
          kind: "overdue",
          message: `${late.length} invoice(s) more than ${overdueBlockDays} days overdue (${late.map((i) => i.transactionNo).join(", ")})`,
          invoices: late.map((i) => ({ transactionNo: i.transactionNo, daysPastDue: i.daysPastDue, outstanding: i.outstanding })),
        });
      }
    }
    return breaches;
  }

  static async assertSaleAllowed(transaction, { session, acknowledged = false, req } = {}) {
    if (transaction.type !== "sales_order") return;
    const cfg = await this.settings(session);
    if (cfg.mode === "off") return;

    const Customer = mongoose.model("Customer");
    const q = Customer.findById(transaction.partyId).select("customerName creditLimit cashBalance paymentTerms").lean();
    const customer = await (session ? q.session(session) : q);
    if (!customer) return;

    const overdue = cfg.overdueBlockDays > 0
      ? await AgeingService.openInvoices({ type: "receivable", partyId: transaction.partyId, session })
      : [];
    const breaches = this.evaluate({
      creditLimit: Number(customer.creditLimit) || 0,
      balance: customer.cashBalance,
      orderTotal: transaction.totalAmount,
      overdueInvoices: overdue,
      overdueBlockDays: cfg.overdueBlockDays,
    });
    if (!breaches.length) return;

    const details = { risk: { operation: "limit.party_credit", acknowledgementField: ACK_FIELD, party: customer.customerName, breaches } };
    const summary = breaches.map((b) => b.message).join("; ");

    if (cfg.mode === "block") {
      await AuditService.log({ req, action: "CREDIT_BLOCKED", entity: "Transaction", entityId: transaction._id, summary: `${transaction.transactionNo}: ${summary}` });
      throw new AppError(`Credit check failed for ${customer.customerName}: ${summary}`, 403, "RISK_LIMIT_BLOCKED", details);
    }
    // warn
    if (!acknowledged) {
      throw new AppError(`Credit warning for ${customer.customerName}: ${summary}`, 409, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED", details);
    }
    await AuditService.log({ req, action: "CREDIT_WARNING_ACKNOWLEDGED", entity: "Transaction", entityId: transaction._id, summary: `${transaction.transactionNo}: ${summary}` });
  }
}

module.exports = CreditControlService;
