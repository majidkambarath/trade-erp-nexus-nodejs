const { BankMatch, BankReconciliation } = require("../../models/modules/banking/reconciliationModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

// A voucher whose bank entry has been matched to a statement line is something the bank has
// confirmed. Editing, deleting or bouncing it would quietly change a reconciled figure, so those
// are refused until the line is unmatched (or, when the reconciliation is completed, reopened).
// FinancialService.reverseLedgerEntries calls this: every path that undoes a voucher's postings
// (edit, delete, a cheque bouncing or being cancelled) goes through it.
class ReconciliationGuard {
  static async assertNotMatched(voucherId, { session, req } = {}) {
    if (!voucherId) return;
    const { companyId } = getTenant(req);
    const q = BankMatch.findOne({ companyId, status: "active", "entries.voucherId": voucherId }).select("reconciliationId").lean();
    const match = await (session ? q.session(session) : q);
    if (!match) return;
    if (match.reconciliationId) {
      const rec = await BankReconciliation.findById(match.reconciliationId).select("number asOf").lean();
      throw new AppError(
        `This voucher was reconciled with the bank${rec ? ` (${rec.number}, as of ${rec.asOf})` : ""}. Reopen that reconciliation first.`,
        409,
        "BANK_RECONCILED"
      );
    }
    throw new AppError(
      "This voucher is matched to a bank statement line. Unmatch the line in Bank reconciliation first, then try again.",
      409,
      "BANK_MATCHED"
    );
  }
}

module.exports = ReconciliationGuard;
