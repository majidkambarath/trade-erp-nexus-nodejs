const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const FxVoucherService = require("./fxVoucherService");
const CurrencyService = require("./currencyService");
const { MAX_DOCUMENT_DECIMALS } = require("../../utils/fxDocument");
const { orgDay } = require("../../utils/fx");

// The currency a sales or purchase INVOICE (or its return) is made in. The rules are the receipt's (services/financial/fxVoucherService.js): the
// currency must be on the list and switched on, the rate is the master's on the document's day unless one is typed, and a typed rate far from the
// master needs a reason. What is new is only what a document needs on top:
//   - a RETURN is made in the currency, and at the rate, of the invoice it returns (a credit note undoes what that invoice charged, so no exchange
//     difference arises between them); it cannot be in another currency
//   - an opening invoice, and a document made from an offer, a delivery, an order or a job card, stay in the base currency (its prices were set
//     there); a foreign invoice is entered directly
//   - only currencies the engine can price exactly: two decimals or fewer (KWD, BHD, OMR are not supported on a document)
//   - the plan must include foreign currency
class FxDocumentService {
  /**
   * -> null for a base-currency document, else { currency, decimals, exchangeRate, fields } where `fields` is what is stored on Transaction.fx
   *   input: { currency, exchangeRate, rateOverrideReason, date, returnOf: { transactionId }, isOpening, linked, existing }
   *   `existing` is the fx block already on the document being edited: its rate is kept unless the currency, the day or the rate is changed.
   */
  static async resolve(input = {}, { session, req } = {}) {
    const base = await CurrencyService.baseCode({ session, req });
    const asked = String(input.currency || "").trim().toUpperCase();

    // a return follows its invoice
    if (input.returnOf?.transactionId) {
      const Transaction = mongoose.model("Transaction");
      const q = Transaction.findById(input.returnOf.transactionId).select("fx").lean();
      const original = await (session ? q.session(session) : q);
      if (original?.fx?.currency) {
        if (asked && asked !== original.fx.currency) {
          throw new AppError(`This return is for an invoice in ${original.fx.currency}, so it is made in ${original.fx.currency} at the invoice's rate.`, 422, "RETURN_CURRENCY_MISMATCH");
        }
        const { currency, rate: exchangeRate, decimals, rateDate, rateSource, rateOverridden, rateOverrideReason } = original.fx;
        return { currency, decimals, exchangeRate, fields: { currency, rate: exchangeRate, decimals, rateDate, rateSource, rateOverridden, rateOverrideReason } };
      }
      if (asked && asked !== base) {
        throw new AppError(`This return is for an invoice in ${base}, so it is made in ${base}.`, 422, "RETURN_CURRENCY_MISMATCH");
      }
      return null;
    }

    if (!asked || asked === base) return null;

    if (input.isOpening || input.linked) {
      throw new AppError(
        "An invoice in a foreign currency is entered directly: an opening invoice, or one made from an offer, an order, a delivery or a job card, is in " + base + ".",
        422, "FOREIGN_INVOICE_STANDALONE"
      );
    }
    await require("../core/usageService").assertFeature("currencies"); // foreign currency is a plan feature

    const keep = input.existing?.currency === asked
      && (input.exchangeRate === undefined || input.exchangeRate === null || input.exchangeRate === "" || Number(input.exchangeRate) === Number(input.existing.rate))
      && input.date && orgDay(input.date) === orgDay(input.existing.rateDate || input.date);
    const r = await FxVoucherService.resolve(
      {
        currency: asked, foreignAmount: 1, exchangeRate: input.exchangeRate, rateOverrideReason: input.rateOverrideReason, date: input.date || new Date(),
        ...(keep ? { _fxKeep: true, _fxExisting: { currency: input.existing.currency, exchangeRate: input.existing.rate, rateDate: input.existing.rateDate, rateSource: input.existing.rateSource, rateOverridden: input.existing.rateOverridden, rateOverrideReason: input.existing.rateOverrideReason } } : {}),
      },
      { session, req }
    );
    if (r.decimals > MAX_DOCUMENT_DECIMALS) {
      throw new AppError(`${asked} has ${r.decimals} decimal places; invoices can be made in currencies with two or fewer.`, 422, "FOREIGN_DECIMALS_UNSUPPORTED");
    }
    const { currency, exchangeRate, rateDate, rateSource, rateOverridden, rateOverrideReason } = r.fields;
    return { currency, decimals: r.decimals, exchangeRate, fields: { currency, rate: exchangeRate, decimals: r.decimals, rateDate, rateSource, rateOverridden, rateOverrideReason } };
  }
}

module.exports = FxDocumentService;
