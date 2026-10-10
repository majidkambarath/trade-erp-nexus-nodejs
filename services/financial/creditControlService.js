const mongoose = require("mongoose");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AgeingService = require("./ageingService");
const AuditService = require("../core/auditService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { allBranches } = require("../../utils/tenantContext");
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

  // What the customer owes the organisation now, as a negative number (the sign evaluate() reads). The ledger answers it:
  // invoices less receipts, returns, credit notes and what they hold on account. Customer.cashBalance cannot - it only
  // moves with sales and on-account receipts, so a customer who always pays their invoices looked as if they owed every sale
  // they ever made, and with credit control on every new order would breach. With ledger posting off the open invoices are the
  // nearest thing to it. Every branch counts: a customer owes the organisation.
  static async exposure(customer, partyId, { session } = {}) {
    const AccountConfigService = require("./accountConfigService");
    if (await AccountConfigService.isPostingEnabled({ session })) {
      const LedgerAccount = mongoose.model("LedgerAccount");
      const LedgerEntry = mongoose.model("LedgerEntry");
      const names = [`Customer - ${customer.customerName}`, `Customer Advance - ${customer.customerName}`];
      const found = LedgerAccount.find({ accountName: { $in: names } }).select("_id").lean();
      const accounts = await (session ? found.session(session) : found);
      if (accounts.length) {
        const agg = LedgerEntry.aggregate([
          { $match: { accountId: { $in: accounts.map((a) => a._id) }, isReversed: { $ne: true } } },
          { $group: { _id: null, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
        ]);
        const [r] = await allBranches(() => (session ? agg.session(session) : agg));
        return round2(-(r?.net || 0));
      }
    }
    const open = await allBranches(() => AgeingService.openInvoices({ type: "receivable", partyId, session }));
    return round2(-open.reduce((t, i) => t + i.outstanding, 0));
  }

  static async assertSaleAllowed(transaction, { session, acknowledged = false, req } = {}) {
    if (transaction.type !== "sales_order") return;
    const cfg = await this.settings(session);
    if (cfg.mode === "off") return;

    const Customer = mongoose.model("Customer");
    const q = Customer.findById(transaction.partyId).select("customerName creditLimit cashBalance paymentTerms").lean();
    const customer = await (session ? q.session(session) : q);
    if (!customer) return;

    // A customer owes the organisation, not a branch: the overdue check reads every branch's invoices whoever is selling.
    const overdue = cfg.overdueBlockDays > 0
      ? await allBranches(() => AgeingService.openInvoices({ type: "receivable", partyId: transaction.partyId, session }))
      : [];
    const breaches = this.evaluate({
      creditLimit: Number(customer.creditLimit) || 0,
      balance: await this.exposure(customer, transaction.partyId, { session }),
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
