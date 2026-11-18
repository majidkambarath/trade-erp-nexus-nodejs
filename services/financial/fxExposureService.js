const Transaction = require("../../models/modules/transactionModel");
const CurrencyService = require("./currencyService");
const AppError = require("../../utils/AppError");
const { convertToBase } = require("../../utils/fx");
const { orgDay } = require("../../utils/fx");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// What the business is exposed to in foreign currency: the open foreign-currency invoices, each valued at the rate on a given day against what the
// ledger carries for it. Read-only. The difference is UNREALISED: nothing is posted for it (the realised gain or loss is posted when the invoice is
// settled, services/financial/fxSettlement.js). Receivables gain when the foreign currency has risen against the base; payables lose.
class FxExposureService {
  static async report({ asOn } = {}, req) {
    const day = asOn ? orgDay(asOn) : orgDay(new Date());
    if (asOn && !day) throw new AppError("That date is not valid", 400, "INVALID_DATE");
    const base = await CurrencyService.baseCode({ req });

    const invoices = await Transaction.find({
      type: { $in: ["sales_order", "purchase_order"] },
      status: "APPROVED",
      "fx.currency": { $exists: true, $ne: null },
      "fx.outstandingAmount": { $gt: 0.004 },
      date: { $lte: new Date(`${day}T23:59:59.999Z`) },
    })
      .select("transactionNo type date partyId partyType fx outstandingAmount")
      .sort({ date: 1, _id: 1 })
      .lean();

    const rates = new Map();
    const rateFor = async (code) => {
      if (!rates.has(code)) {
        try {
          const r = await CurrencyService.rateOn(code, day, { req });
          rates.set(code, { rate: r.rate, rateDay: r.rateDay, source: r.source });
        } catch (err) {
          if (err.code !== "NO_RATE") throw err;
          rates.set(code, null); // no rate on or before that day: those invoices are listed, not valued
        }
      }
      return rates.get(code);
    };

    const names = await this.#partyNames(invoices);
    const rows = [];
    for (const inv of invoices) {
      const r = await rateFor(inv.fx.currency);
      const receivable = inv.type === "sales_order";
      const carrying = round2(inv.outstandingAmount);
      const valued = r ? convertToBase(inv.fx.outstandingAmount, r.rate, { decimals: inv.fx.decimals ?? 2 }) : null;
      // positive = better off: a receivable is worth more, or a payable costs less
      const difference = valued === null ? null : round2(receivable ? valued - carrying : carrying - valued);
      rows.push({
        id: inv._id, number: inv.transactionNo, date: inv.date, side: receivable ? "receivable" : "payable",
        party: names.get(String(inv.partyId)) || "", currency: inv.fx.currency, rateAtInvoice: inv.fx.rate,
        foreignOpen: round2(inv.fx.outstandingAmount), carrying, rateNow: r?.rate ?? null, valued, difference,
      });
    }

    const byCurrency = {};
    for (const row of rows) {
      const c = (byCurrency[row.currency] ||= { currency: row.currency, rateNow: row.rateNow, receivable: 0, payable: 0, net: 0, carrying: 0, valued: 0, difference: 0, unvalued: 0 });
      const sign = row.side === "receivable" ? 1 : -1;
      c.receivable += row.side === "receivable" ? row.foreignOpen : 0;
      c.payable += row.side === "payable" ? row.foreignOpen : 0;
      c.net += sign * row.foreignOpen;
      if (row.difference === null) { c.unvalued += 1; continue; }
      c.carrying += sign * row.carrying;
      c.valued += sign * row.valued;
      c.difference += row.difference;
    }
    const currencies = Object.values(byCurrency).map((c) => ({
      ...c, receivable: round2(c.receivable), payable: round2(c.payable), net: round2(c.net),
      carrying: round2(c.carrying), valued: round2(c.valued), difference: round2(c.difference),
    }));
    return {
      asOn: day, baseCurrency: base, rows, currencies,
      totalDifference: round2(currencies.reduce((t, c) => t + c.difference, 0)),
      note: "Unrealised: nothing is posted for these differences. The realised gain or loss is posted when each invoice is settled.",
    };
  }

  static async #partyNames(invoices) {
    const out = new Map();
    const Customer = require("../../models/modules/customerModel");
    const Vendor = require("../../models/modules/vendorModel");
    const ids = (t) => [...new Set(invoices.filter((i) => i.partyType === t).map((i) => String(i.partyId)))];
    const [cs, vs] = await Promise.all([
      Customer.find({ _id: { $in: ids("Customer") } }).select("customerName").lean(),
      Vendor.find({ _id: { $in: ids("Vendor") } }).select("vendorName").lean(),
    ]);
    cs.forEach((c) => out.set(String(c._id), c.customerName));
    vs.forEach((v) => out.set(String(v._id), v.vendorName));
    return out;
  }
}

module.exports = FxExposureService;
