const { Voucher } = require("../../models/modules/financial/financialModels");
const { Currency } = require("../../models/modules/financial/currencyModels");
const CurrencyService = require("./currencyService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { decimalPlaces, convertToBase, deviationPercent, roundTo, splitForeign, dubaiDay, dubaiDayStart, dubaiDayEnd, isCalendarDay, RATE_DECIMALS } = require("../../utils/fx");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (Number.isFinite(n) ? n : 0);

// Receipts from customers and payments to vendors in a foreign currency.
//
// The ledger is kept ONLY in the base currency (AED). A foreign voucher is converted once, at the
// moment it is made: totalAmount = round2(foreignAmount x exchangeRate) in AED, and from there
// everything - allocation against invoices, advances, the payment-mode legs, the cheque register,
// card fees and limits, reversal and deletion - runs on that AED amount exactly as it does for an
// AED voucher. The foreign amount, the rate and where the rate came from are recorded on the
// voucher, and the money-side ledger entries are stamped with currency / exchangeRate /
// amountForeign so a bank account's foreign movements can be read back.
//
// PHASE 1 LIMIT: invoices are still AED documents, so a foreign receipt settles them at the voucher's
// rate and no exchange difference arises. Foreign-currency invoices, the realised exchange gain or
// loss when an invoice is settled at a rate other than the one it was raised at, and month-end
// revaluation of open foreign balances (IAS 21) are phase 2.
class FxVoucherService {
  // Turns the foreign-currency fields of a receipt / payment request into what the voucher stores.
  //   data: { currency, foreignAmount, exchangeRate, rateOverrideReason, totalAmount, date, _fxKeep, _fxExisting }
  // For the base currency the request's amount is returned untouched and every foreign field is
  // cleared (so an edit that turns a foreign voucher back into AED leaves nothing stale behind).
  static async resolve(data = {}, { session, req } = {}) {
    const base = await CurrencyService.baseCode({ session, req });
    const code = String(data.currency || base).trim().toUpperCase();
    const baseFields = {
      currency: base, exchangeRate: 1, foreignAmount: undefined, rateDate: undefined,
      rateSource: undefined, rateOverridden: undefined, rateOverrideReason: undefined,
    };
    if (code === base) return { foreign: false, currency: base, totalAmount: data.totalAmount, fields: baseFields };

    if (!/^[A-Z]{3}$/.test(code)) throw new AppError("A currency code is three letters, for example USD", 400, "INVALID_CURRENCY_CODE");
    const { companyId } = getTenant(req);
    const currency = await Currency.findOne({ companyId, code }).session(session || null).lean();
    if (!currency) throw new AppError(`${code} is not in the currency list. Add it under Currencies.`, 404, "CURRENCY_NOT_FOUND");
    if (!currency.isActive) throw new AppError(`${code} is switched off. Enable it under Currencies to use it on a voucher.`, 422, "CURRENCY_INACTIVE");

    // the amount, in the currency's own minor units
    const rawAmount = Number(data.foreignAmount);
    if (data.foreignAmount === undefined || data.foreignAmount === null || data.foreignAmount === "" || !Number.isFinite(rawAmount) || rawAmount <= 0) {
      throw new AppError(`Enter the amount in ${code}`, 400, "FOREIGN_AMOUNT_REQUIRED");
    }
    if (decimalPlaces(rawAmount) > currency.decimals) {
      throw new AppError(`${code} amounts have at most ${currency.decimals} decimal place${currency.decimals === 1 ? "" : "s"}`, 400, "INVALID_AMOUNT");
    }
    const foreignAmount = roundTo(rawAmount, currency.decimals);

    const date = data.date || new Date();
    const keep = data._fxKeep && data._fxExisting && data._fxExisting.currency === code && Number(data._fxExisting.exchangeRate) > 0;
    let exchangeRate;
    let rateDate;
    let rateSource;
    let rateOverridden = false;
    let rateOverrideReason;

    if (keep) {
      // An edit that leaves the rate and the date alone keeps the rate the voucher was made at, even
      // if the master has moved since, and is not judged against the master again.
      const e = data._fxExisting;
      exchangeRate = Number(e.exchangeRate);
      ({ rateDate, rateSource } = e);
      rateOverridden = Boolean(e.rateOverridden);
      rateOverrideReason = e.rateOverrideReason || undefined;
    } else {
      // The master rate in force that day. No rate at all is refused, even when the caller typed
      // one: a rate with nothing to check it against is how a mistyped 36.725 gets posted.
      const master = await CurrencyService.rateOn(code, date, { session, req });
      const typed = data.exchangeRate;
      if (typed === undefined || typed === null || typed === "") {
        exchangeRate = master.rate;
        rateSource = master.source;
        rateDate = master.rateDate;
      } else {
        exchangeRate = Number(typed);
        if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new AppError("Enter an exchange rate greater than zero", 400, "INVALID_RATE");
        if (decimalPlaces(exchangeRate) > RATE_DECIMALS) throw new AppError(`An exchange rate can have at most ${RATE_DECIMALS} decimal places`, 400, "INVALID_RATE");
        rateDate = master.rateDate;
        if (exchangeRate === master.rate) {
          rateSource = master.source;
        } else {
          rateSource = "voucher";
          const { fxTolerancePercent } = await CurrencyService.getSettings(req, { session });
          const away = deviationPercent(exchangeRate, master.rate);
          if (away > fxTolerancePercent + 1e-9) {
            const reason = String(data.rateOverrideReason ?? "").trim();
            if (reason.length < 3) {
              throw new AppError(
                `The rate ${exchangeRate} is ${roundTo(away, 2)}% away from the ${code} rate on file (${master.rate}); ${fxTolerancePercent}% is allowed. Give a reason to use it.`,
                422, "RATE_OUT_OF_TOLERANCE",
                { rate: exchangeRate, masterRate: master.rate, deviationPercent: roundTo(away, 4), tolerancePercent: fxTolerancePercent }
              );
            }
            rateOverridden = true;
            rateOverrideReason = reason.slice(0, 250);
          }
        }
      }
    }

    const totalAmount = convertToBase(foreignAmount, exchangeRate, { decimals: currency.decimals });
    if (!(totalAmount > 0)) throw new AppError("That amount is too small to be worth AED 0.01 at this rate", 400, "INVALID_AMOUNT");
    return {
      foreign: true, currency: code, decimals: currency.decimals, exchangeRate, foreignAmount, totalAmount,
      fields: { currency: code, exchangeRate, foreignAmount, rateDate, rateSource, rateOverridden, rateOverrideReason },
    };
  }

  // Journals, contras, expenses and debit / credit notes are base-currency only in phase 1. Refuse a
  // request that names another currency rather than post its figure as if it were AED.
  static async assertBaseCurrencyOnly(data = {}, { session, req } = {}) {
    const named = String(data.currency || "").trim().toUpperCase();
    if (!named && !(Number(data.foreignAmount) > 0)) return;
    const base = await CurrencyService.baseCode({ session, req });
    if ((named && named !== base) || Number(data.foreignAmount) > 0) {
      throw new AppError("Only receipts and payments can be made in a foreign currency", 400, "FOREIGN_CURRENCY_NOT_SUPPORTED");
    }
  }

  // The money-side legs of a foreign voucher, each stamped with the currency, the rate and its
  // share of the foreign amount (the shares add back to the foreign amount exactly). The ledger
  // amounts themselves are untouched AED. AED legs pass through unchanged.
  static stampLegs(legs, fx) {
    if (!fx?.foreign) return legs;
    const shares = splitForeign(fx.foreignAmount, legs.map((l) => num(l.debitAmount) + num(l.creditAmount)), { decimals: fx.decimals });
    return legs.map((l, i) => ({ ...l, currency: fx.currency, exchangeRate: fx.exchangeRate, amountForeign: shares[i] }));
  }

  // Called from updateVoucher before a receipt / payment is re-processed. `processData` is the
  // stored voucher with the request laid over it, so a rate the caller did not send is still the old
  // one - and would then be mistaken for a typed rate. Decide here which it is.
  static prepareEdit(old, data, processData) {
    if (!["receipt", "payment"].includes(old.voucherType)) return;
    const existing = {
      currency: old.currency, exchangeRate: old.exchangeRate, rateDate: old.rateDate, rateSource: old.rateSource,
      rateOverridden: old.rateOverridden, rateOverrideReason: old.rateOverrideReason,
    };
    processData._fxExisting = existing;
    // an old reason never justifies a rate it was not given for
    if (data.rateOverrideReason === undefined) delete processData.rateOverrideReason;
    const typed = data.exchangeRate !== undefined && data.exchangeRate !== null && data.exchangeRate !== "";
    const sameCurrency = String(data.currency || old.currency || "").toUpperCase() === String(old.currency || "").toUpperCase();
    const sameDay = data.date === undefined || dubaiDay(data.date) === dubaiDay(old.date);
    // a form that sends the voucher's own rate back changes nothing about it
    if (sameCurrency && sameDay && (!typed || Number(data.exchangeRate) === Number(old.exchangeRate))) processData._fxKeep = true;
    else if (!typed) delete processData.exchangeRate; // look it up for the new currency or day
    // else: a different rate was typed, and it is judged like one on a new voucher
  }

  // ------------------------------------------------------------------------------ the register

  // Foreign-currency receipts and payments in a period, with totals per currency and direction.
  // Only posted vouchers count towards the totals; cancelled or bounced ones are listed, marked.
  static async register(req, { from, to, currency, type } = {}) {
    const match = { foreignAmount: { $exists: true, $gt: 0 } };
    if (type) {
      if (!["receipt", "payment"].includes(type)) throw new AppError("The type is receipt or payment", 400, "INVALID_TYPE");
      match.voucherType = type;
    } else {
      match.voucherType = { $in: ["receipt", "payment"] };
    }
    if (currency) {
      const c = String(currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) throw new AppError("A currency code is three letters, for example USD", 400, "INVALID_CURRENCY_CODE");
      match.currency = c;
    }
    const day = (v, label) => {
      if (!isCalendarDay(v)) throw new AppError(`Enter the ${label} as YYYY-MM-DD`, 400, "INVALID_DATE");
      return v;
    };
    if (from || to) {
      match.date = {};
      if (from) match.date.$gte = dubaiDayStart(day(from, "from date"));
      if (to) match.date.$lt = dubaiDayEnd(day(to, "to date"));
    }

    const CAP = 5000;
    const [rows, totals] = await Promise.all([
      Voucher.find(match)
        .sort({ date: 1, voucherNo: 1 })
        .limit(CAP + 1)
        .select("voucherNo voucherType date partyType partyId partyName currency foreignAmount exchangeRate totalAmount rateDate rateSource rateOverridden rateOverrideReason paymentMode paymentDetails status")
        .lean(),
      Voucher.aggregate([
        { $match: { ...match, status: "approved" } },
        { $group: { _id: { currency: "$currency", type: "$voucherType" }, count: { $sum: 1 }, foreign: { $sum: "$foreignAmount" }, aed: { $sum: "$totalAmount" } } },
        { $sort: { "_id.currency": 1, "_id.type": 1 } },
      ]),
    ]);
    const truncated = rows.length > CAP;
    if (truncated) rows.length = CAP;
    return {
      rows,
      truncated,
      totals: totals.map((t) => ({
        currency: t._id.currency, type: t._id.type, count: t.count,
        foreign: roundTo(t.foreign, 4), aed: round2(t.aed),
        // weighted by amount: total base received per unit of foreign currency
        averageRate: t.foreign > 0 ? roundTo(t.aed / t.foreign, 6) : null,
      })),
    };
  }
}

module.exports = FxVoucherService;
