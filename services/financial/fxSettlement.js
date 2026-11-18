const AppError = require("../../utils/AppError");
const { carryingFor } = require("../../utils/fxDocument");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EPS = 0.01;

// Settling invoices that were made in a foreign currency (utils/fxDocument.js). The ledger carries such an invoice in the base currency; the
// customer or supplier owes it in its own. A receipt or payment in THAT currency allocates foreign amounts to it:
//   - the invoice's open foreign amount falls by what was allocated, its open BASE amount by the same share of what the ledger carries
//     (all of it when the last part is settled, so nothing is stranded by rounding)
//   - the money is worth, in base, the share of the voucher's base total that went to invoices; the difference from the carrying value is the
//     exchange gain or loss, posted to its own account
//   - what is not allocated stays on account at its base value
// Pure arithmetic lives in plan(); the voucher processors call it. An invoice in the base currency is not touched by any of this.
class FxSettlement {
  /**
   * `rows`: [{ invoice (a Transaction document), linked: { invoiceId, amount, balance } }] in request order, already checked to belong to the party.
   * `fx`: FxVoucherService.resolve output for the voucher. -> null when no allocated invoice is foreign (the caller carries on as before), else
   *   { links, totalAllocated (base carrying), settledBase, onAccountAmount, difference }
   */
  static plan(rows, fx) {
    const foreign = rows.filter((r) => r.invoice.fx?.currency);
    if (!foreign.length) return null; // (a foreign receipt against base invoices keeps working as phase 1 made it)
    if (foreign.length !== rows.length) {
      throw new AppError("Invoices in a foreign currency are settled on their own: do not mix them with invoices in another currency in one voucher.", 400, "MIXED_INVOICE_CURRENCIES");
    }
    const code = foreign[0].invoice.fx.currency;
    if (foreign.some((r) => r.invoice.fx.currency !== code)) {
      throw new AppError("These invoices are in different currencies: settle each currency with its own voucher.", 400, "MIXED_INVOICE_CURRENCIES");
    }
    if (!fx?.foreign || fx.currency !== code) {
      throw new AppError(`These invoices are in ${code}: settle them with a voucher in ${code}.`, 400, "FOREIGN_INVOICE_NEEDS_CURRENCY");
    }

    const links = foreign.map(({ invoice, linked }) => {
      const allocated = round2(linked.amount);
      const open = round2(invoice.fx.outstandingAmount);
      if (Math.abs(open - (allocated + round2(linked.balance))) > EPS) {
        throw new AppError(`Invoice balance mismatch for ${invoice.transactionNo}. Expected: ${open} ${code}, Provided: ${round2(allocated + round2(linked.balance))} ${code}`, 409, "INVOICE_CHANGED");
      }
      if (allocated > open + EPS) throw new AppError(`${invoice.transactionNo} has only ${open} ${code} open`, 400, "ALLOCATION_EXCEEDS_INVOICE");
      const carrying = carryingFor(allocated, open, invoice.outstandingAmount);
      return {
        invoiceId: invoice._id,
        allocatedAmount: carrying, // base: what the ledger carried for this part, so every base figure downstream reads as before
        previousBalance: round2(invoice.outstandingAmount),
        newBalance: round2(invoice.outstandingAmount - carrying),
        allocatedForeign: allocated,
        previousForeign: open,
        newForeign: round2(open - allocated),
      };
    });

    const totalForeign = round2(links.reduce((t, l) => t + l.allocatedForeign, 0));
    if (totalForeign > fx.foreignAmount + EPS) throw new AppError("Allocated amount cannot exceed total amount", 400);
    const totalAllocated = round2(links.reduce((t, l) => t + l.allocatedAmount, 0));
    const settledBase = totalForeign >= fx.foreignAmount - EPS ? fx.totalAmount : round2((fx.totalAmount * totalForeign) / fx.foreignAmount);

    // what each invoice's part of the money was worth; the last takes the remainder so the parts add to the whole
    let left = settledBase;
    links.forEach((l, i) => {
      l.settledBase = i === links.length - 1 ? round2(left) : round2((settledBase * l.allocatedForeign) / totalForeign);
      left -= l.settledBase;
      l.exchangeDifference = round2(l.settledBase - l.allocatedAmount);
    });

    return {
      links, totalAllocated, settledBase,
      onAccountAmount: round2(fx.totalAmount - settledBase),
      difference: round2(settledBase - totalAllocated),
    };
  }

  // The ledger leg for the exchange difference. `direction` is "receipt" (more base received than carried = gain, credit) or "payment"
  // (more base paid than carried = loss, debit).
  static async leg(direction, difference, description, { session }) {
    if (!difference) return null;
    const { LedgerAccount } = require("../../models/modules/financial/financialModels");
    const id = await require("./postingService").fxGainLossAccount({ session });
    const acc = await LedgerAccount.findById(id).select("accountName").session(session || null).lean();
    const gain = direction === "receipt" ? difference > 0 : difference < 0;
    const amount = Math.abs(difference);
    return {
      accountId: id, accountName: acc.accountName,
      debitAmount: gain ? 0 : amount, creditAmount: gain ? amount : 0,
      description: `${gain ? "Exchange gain" : "Exchange loss"}: ${description}`,
    };
  }
}

module.exports = FxSettlement;
