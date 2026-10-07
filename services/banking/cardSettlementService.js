const mongoose = require("mongoose");
const R = require("../../models/modules/banking/reconciliationModels");
const { CardMaster } = require("../../models/modules/banking/bankingModels");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const FinancialService = require("../financial/financialService");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const TaxCodeService = require("../financial/taxCodeService");
const Core = require("./reconciliationCore");
const M = require("../../utils/bankMatching");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { round2 } = require("../../utils/accounting");
const { todayInDubai, addDays } = require("../../utils/documentExpiry");

// Card settlement. A card sale is booked on the day it is made, net of the processing fee the card
// master says it costs: Dr bank (net) + Dr card processing fees (fee) against the sale. The acquirer
// pays later, in one lump for many sales, and takes VAT on its commission (and sometimes more than
// the configured rate). Reconciling that is one bank credit against many card receipts:
//
//     what the books expected  =  the receipts' bank legs added up
//     what the bank paid       =  the statement line
//     the difference           =  commission beyond what was booked + VAT on the commission
//
// The difference is posted as ONE entry (card processing fees + input VAT), so the match adds up
// exactly: receipts + that entry = the credit. The settlement is kept for the variance and ageing
// reports. The ledger is not changed: no clearing account, nothing is re-posted.

const { cents, fromCents } = M;
const tx = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession();
  }
};

async function configured(key, { session, req }) {
  try {
    return await AccountConfigService.resolveAccount(key, { session });
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await DefaultChartService.provision(req);
    return AccountConfigService.resolveAccount(key, { session });
  }
}

// Card sales that have not been settled: the books' bank legs of card receipts nobody has matched.
const receiptOut = (e) => ({
  entryId: e.id, ledgerEntryId: e.ledgerEntryId, voucherId: e.voucherId, voucherNo: e.voucherNo, day: e.day,
  cardId: e.card?.cardId || null, cardLabel: e.card?.cardLabel || "", gross: e.card?.gross || 0, feeBooked: e.card?.feeBooked || 0, net: e.amount,
});

// Which receipts this credit most plausibly settles: the oldest receipts up to a day, such that what
// the books expected is a little MORE than what was paid (the acquirer's VAT on its commission).
// A suggestion only: the person ticks and unticks.
function suggestSelection(received, receipts) {
  const sorted = [...receipts].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.entryId).localeCompare(String(b.entryId))));
  const days = [...new Set(sorted.map((r) => r.day))];
  let best = null;
  let running = 0;
  for (const d of days) {
    const upTo = sorted.filter((r) => r.day <= d);
    running = upTo.reduce((t, r) => t + cents(r.net), 0);
    const diff = running - cents(received);
    if (diff >= 0 && diff <= Math.max(500, Math.round(running * 0.015))) best = { cutoffDay: d, entryIds: upTo.map((r) => r.entryId), expectedNet: fromCents(running), difference: fromCents(diff) };
    if (diff > Math.round(running * 0.015) && diff > 500) break;
  }
  return best;
}

class CardSettlementService {
  static suggestSelection = suggestSelection;

  // How far a payment can differ from what the books expect and still be commission and VAT:
  //   kept more than booked  at most 10% of the sales' net (and never less than AED 5.00 allowed)
  //   paid more than booked  at most the commission that was booked (an acquirer that waived it all),
  //                          with 50 fils of rounding
  // All in fils. The dialog (lib/bankReconcile.js settlementCheck) says the same thing before the button.
  static limits(expectedCents, feesCents) {
    return { maxKept: Math.max(500, Math.round(expectedCents * 0.1)), maxReturned: Math.max(50, feesCents) };
  }

  static async unsettled(accountId, { lineId, to } = {}, req) {
    const account = await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const setup = await Core.getSetup(accountId, { req });
    if (!setup) throw new AppError("Set up this account first", 409, "SETUP_REQUIRED");
    let line = null;
    if (lineId) {
      line = await R.BankStatementLine.findOne({ _id: lineId, companyId, accountId }).lean();
      if (!line) throw new AppError("Statement line not found", 404, "LINE_NOT_FOUND");
    }
    const { entries } = await Core.loadBook(accountId, setup, { req, upTo: to || line?.day });
    const receipts = entries.filter((e) => !e.groupId && e.card && e.amount > 0).map(receiptOut);
    const code = await TaxCode.findOne({ companyId, isDefault: true, isActive: true }).lean();
    const vatRate = code && code.kind === "standard" ? TaxCodeService.rateOn(code, line ? new Date(`${line.day}T00:00:00.000Z`) : new Date()) : 0;
    return {
      account: { _id: account._id, accountName: account.accountName }, receipts,
      line: line ? { _id: line._id, day: line.day, amount: line.amount, description: line.description, reference: line.reference, state: line.state } : null,
      vatRate, suggestion: line && line.amount > 0 ? suggestSelection(line.amount, receipts) : null,
    };
  }

  static async settle(accountId, { lineId, receiptEntryIds = [], extraCommission = 0, vat = 0, settlementRef = "", note = "" }, req, by) {
    const account = await Core.bankAccount(accountId, { req });
    const { companyId, branchId } = getTenant(req);
    const ids = [...new Set((receiptEntryIds || []).map(String))];
    if (!ids.length) throw new AppError("Choose the card sales this payment settles", 400, "RECEIPTS_REQUIRED");
    const extra = round2(Number(extraCommission) || 0);
    const vatAmount = round2(Number(vat) || 0);
    if (extra < 0 || vatAmount < 0) throw new AppError("Commission and VAT cannot be negative", 400, "INVALID_AMOUNT");

    return tx(async (session) => {
      const line = await R.BankStatementLine.findOne({ _id: lineId, companyId, accountId, state: "open" }).session(session).lean();
      if (!line) throw new AppError("That statement line is no longer open", 409, "LINE_NOT_OPEN");
      if (!(line.amount > 0)) throw new AppError("A card settlement is money coming in", 400, "WRONG_DIRECTION");
      const entries = await Core.resolveEntryRefs(ids.map((i) => ({ type: "ledger", ledgerEntryId: i })), { accountId, clearOn: line.day, session, req, adminId: by });
      const notCard = entries.filter((e) => !e.card || !(e.amount > 0));
      if (notCard.length) throw new AppError(`${notCard[0].voucherNo} is not a card receipt`, 400, "NOT_A_CARD_RECEIPT");
      const dayAfter = entries.find((e) => e.day > line.day);
      if (dayAfter) throw new AppError(`${dayAfter.voucherNo} is dated after this payment`, 400, "RECEIPT_AFTER_PAYMENT");

      const expected = entries.reduce((t, e) => t + cents(e.amount), 0);
      const diff = expected - cents(line.amount); // what the acquirer kept beyond what the books carried
      // Commission and its VAT are a small part of a sale. A difference outside what they could be is
      // the wrong sales ticked, or a refund or chargeback netted off the payment, and posting it to
      // card fees would be wrong either way.
      const limits = this.limits(expected, entries.reduce((t, e) => t + cents(e.card?.feeBooked || 0), 0));
      if (diff > limits.maxKept) {
        throw new AppError(
          `The books expect ${fromCents(expected).toFixed(2)} from these sales but the bank paid ${line.amount.toFixed(2)}: ${fromCents(diff).toFixed(2)} less. That is more than commission and VAT could be (at most ${fromCents(limits.maxKept).toFixed(2)}). Check you ticked the right sales; refunds and chargebacks taken off a payment are posted as a journal first.`,
          409, "DIFFERENCE_TOO_LARGE", { difference: fromCents(diff), limit: fromCents(limits.maxKept) }
        );
      }
      if (-diff > limits.maxReturned) {
        throw new AppError(
          `The bank paid ${line.amount.toFixed(2)}, which is ${fromCents(-diff).toFixed(2)} more than these sales are worth after commission. Tick the other sales this payment covers.`,
          409, "PAYMENT_EXCEEDS_SALES", { difference: fromCents(diff), limit: fromCents(limits.maxReturned) }
        );
      }
      let adjustment = null;
      if (diff > 0) {
        if (cents(extra) + cents(vatAmount) !== diff) {
          throw new AppError(`The books expected ${fromCents(expected).toFixed(2)} and the bank paid ${line.amount.toFixed(2)}. The ${fromCents(diff).toFixed(2)} difference must be split between commission and VAT.`, 409, "DIFFERENCE_NOT_EXPLAINED", { difference: fromCents(diff) });
        }
        let code = null;
        if (vatAmount > 0) {
          code = await TaxCode.findOne({ companyId, isDefault: true, isActive: true, kind: "standard" }).session(session).lean();
          if (!code) throw new AppError("There is no default standard-rated tax code to put the VAT on", 422, "TAX_CODE_REQUIRED");
        }
        adjustment = await FinancialService.createVoucher({
          voucherType: "expense", ledgerBased: true, date: new Date(`${line.day}T00:00:00.000Z`),
          expenseAccountId: extra > 0 ? await configured("card-charges", { session, req }) : undefined,
          // the VAT is the acquirer's on its WHOLE commission, most of which was booked at the sale
          amount: extra, ...(code ? { taxCodeId: code._id, vatAmount, vatCoversEarlierAmount: true } : {}),
          description: `Card settlement ${settlementRef || line.reference || line.day}: commission and VAT beyond what was booked at the sale`,
          narration: `Card settlement ${line.day}: ${String(line.description || "").slice(0, 100)}`,
          paymentMode: "bank", paymentDetails: { accountId: account._id, reference: settlementRef || line.reference || `STMT-${line.lineNo}` },
        }, by, session);
      } else if (diff < 0) {
        // the acquirer kept LESS than the books carried: the fee booked at the sale was too high
        if (extra !== 0 || vatAmount !== 0) throw new AppError("The bank paid more than the books expected, so there is no extra commission or VAT", 409, "DIFFERENCE_NOT_EXPLAINED");
        const back = fromCents(-diff);
        adjustment = await FinancialService.createVoucher({
          voucherType: "journal", date: new Date(`${line.day}T00:00:00.000Z`), narration: `Card settlement ${line.day}: fee booked at the sale was ${back.toFixed(2)} too high`,
          lines: [
            { accountId: account._id, debit: back, narration: "Card settlement: commission returned" },
            { accountId: await configured("card-charges", { session, req }), credit: back, narration: "Card settlement: commission returned" },
          ],
        }, by, session);
      } else if (extra !== 0 || vatAmount !== 0) {
        throw new AppError("The bank paid exactly what the books expected, so there is no extra commission or VAT", 409, "DIFFERENCE_NOT_EXPLAINED");
      }

      const parts = [...entries];
      if (adjustment) parts.push(await Core.bankEntryOf(adjustment._id, account._id, { session }));
      const match = await Core.createMatch({
        accountId, lines: [line], entries: parts, kind: "card", method: "card", note, by: by ? String(by) : null, session, req,
        createdVouchers: adjustment ? [{ voucherId: adjustment._id, voucherNo: adjustment.voucherNo, kind: "card-commission" }] : [],
      });
      const receipts = entries.map(receiptOut);
      const [settlement] = await R.CardSettlement.create([{
        companyId, branchId, accountId, matchId: match._id, lineId: line._id, settlementRef: String(settlementRef || line.reference || "").slice(0, 80), settlementDate: line.day,
        receipts: receipts.map((r) => ({ ledgerEntryId: r.ledgerEntryId, voucherId: r.voucherId, voucherNo: r.voucherNo, day: r.day, cardId: r.cardId, cardLabel: r.cardLabel, gross: r.gross, feeBooked: r.feeBooked, net: r.net })),
        gross: round2(receipts.reduce((t, r) => t + r.gross, 0)), feeBooked: round2(receipts.reduce((t, r) => t + r.feeBooked, 0)), expectedNet: fromCents(expected),
        received: line.amount, difference: fromCents(diff), extraCommission: extra, vat: vatAmount,
        adjustmentVoucherId: adjustment?._id || null, adjustmentVoucherNo: adjustment?.voucherNo || "", createdBy: by ? String(by) : null,
      }], { session });
      return { settlement: settlement.toObject(), match: match.toObject() };
    });
  }

  static async list(accountId, { from, to } = {}, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const q = { companyId, accountId: Core.toId(accountId), status: "active" };
    if (from || to) q.settlementDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const rows = await R.CardSettlement.find(q).sort({ settlementDate: -1, createdAt: -1 }).limit(200).lean();
    return rows.map((s) => ({ ...s, receiptCount: s.receipts.length, receipts: undefined }));
  }

  // Commission: what the card masters say it should cost against what the acquirer actually took.
  static async variance(accountId, { from, to } = {}, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const q = { companyId, accountId: Core.toId(accountId), status: "active" };
    if (from || to) q.settlementDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const rows = await R.CardSettlement.find(q).sort({ settlementDate: 1 }).lean();
    const sum = (list, f) => round2(list.reduce((t, r) => t + (f(r) || 0), 0));
    const pct = (a, b) => (b ? Math.round((a / b) * 100000) / 1000 : 0);
    const byMonth = new Map();
    const byCard = new Map();
    for (const s of rows) {
      const m = s.settlementDate.slice(0, 7);
      const row = byMonth.get(m) || { month: m, settlements: 0, gross: 0, feeBooked: 0, extraCommission: 0, vat: 0, received: 0 };
      row.settlements += 1; row.gross = round2(row.gross + s.gross); row.feeBooked = round2(row.feeBooked + s.feeBooked); row.extraCommission = round2(row.extraCommission + s.extraCommission); row.vat = round2(row.vat + s.vat); row.received = round2(row.received + s.received);
      byMonth.set(m, row);
      for (const r of s.receipts) {
        const key = String(r.cardId || "none");
        const c = byCard.get(key) || { cardId: r.cardId, cardLabel: r.cardLabel || "Card", sales: 0, gross: 0, feeBooked: 0 };
        c.sales += 1; c.gross = round2(c.gross + r.gross); c.feeBooked = round2(c.feeBooked + r.feeBooked);
        byCard.set(key, c);
      }
    }
    const gross = sum(rows, (r) => r.gross);
    const feeBooked = sum(rows, (r) => r.feeBooked);
    const extra = sum(rows, (r) => r.extraCommission);
    return {
      summary: {
        settlements: rows.length, gross, feeBooked, extraCommission: extra, vat: sum(rows, (r) => r.vat), received: sum(rows, (r) => r.received),
        bookedRate: pct(feeBooked, gross), effectiveRate: pct(feeBooked + extra, gross),
      },
      months: [...byMonth.values()].map((m) => ({ ...m, bookedRate: pct(m.feeBooked, m.gross), effectiveRate: pct(m.feeBooked + m.extraCommission, m.gross) })),
      cards: [...byCard.values()].map((c) => ({ ...c, bookedRate: pct(c.feeBooked, c.gross) })),
      settlements: rows.map((s) => ({ _id: s._id, settlementDate: s.settlementDate, settlementRef: s.settlementRef, gross: s.gross, feeBooked: s.feeBooked, extraCommission: s.extraCommission, vat: s.vat, received: s.received, receiptCount: s.receipts.length, effectiveRate: pct(s.feeBooked + s.extraCommission, s.gross) })),
    };
  }

  // Card sales still waiting to be paid out, by how many working days ago they were made.
  static async ageing(accountId, { asOf } = {}, req) {
    await Core.bankAccount(accountId, { req });
    const setup = await Core.getSetup(accountId, { req });
    if (!setup) return { buckets: [], total: 0, count: 0, items: [], needsSetup: true };
    const day = asOf || todayInDubai();
    const { entries } = await Core.loadBook(accountId, setup, { req, upTo: day });
    const open = entries.filter((e) => !e.groupId && e.card && e.amount > 0);
    const defs = [["0-3 days", 0, 3], ["4-7 days", 4, 7], ["8-14 days", 8, 14], ["15+ days", 15, Infinity]];
    const buckets = defs.map(([label, from, to]) => ({ label, from, to: Number.isFinite(to) ? to : null, count: 0, total: 0 }));
    const items = open.map((e) => {
      const age = M.businessDays(e.day, day);
      const b = buckets.find((x) => age >= x.from && (x.to === null || age <= x.to));
      b.count += 1; b.total = round2(b.total + e.amount);
      return { ...receiptOut(e), workingDays: age };
    }).sort((a, b) => b.workingDays - a.workingDays);
    return { asOf: day, buckets, total: round2(open.reduce((t, e) => t + e.amount, 0)), count: open.length, items: items.slice(0, 300) };
  }

  // The bank accounts that take card payments (a terminal's settlement account).
  static async cardAccounts(req) {
    const { companyId } = getTenant(req);
    return CardMaster.find({ companyId, kind: "terminal", isActive: true }).distinct("accountId");
  }
}

module.exports = CardSettlementService;
