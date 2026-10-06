const mongoose = require("mongoose");
const R = require("../../models/modules/banking/reconciliationModels");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const FinancialService = require("../financial/financialService");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const AgeingService = require("../financial/ageingService");
const TaxCodeService = require("../financial/taxCodeService");
const Core = require("./reconciliationCore");
const S = require("../../utils/bankStatement");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { round2 } = require("../../utils/accounting");

// A statement line the books know nothing about: a fee, interest, a transfer between our own
// accounts, a customer paying by transfer before anyone booked it. The entry is posted through the
// ordinary voucher code (so the VAT return, the ledger and the audit trail see it like any other),
// and the voucher and the match are written in ONE transaction: both happen or neither does.
//
// In the request body `accountId` is always the BANK account; the account an entry is posted to (an
// expense account for a fee, an income account for interest, the other side of a journal) is
// `postToAccountId`, so the two can never be confused.

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

// A posting-map account (bank-charges, bank-interest). A company set up before the key existed has
// it unmapped; the defaults are added once and we retry, as the payment modes do.
async function configured(key, { session, req }) {
  try {
    return await AccountConfigService.resolveAccount(key, { session });
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await DefaultChartService.provision(req);
    return AccountConfigService.resolveAccount(key, { session });
  }
}

const KINDS = ["fee", "interest", "transfer", "receipt", "payment", "journal"];
const clip = (s, n) => String(s || "").trim().slice(0, n);
const voucherDate = (day) => new Date(`${day}T00:00:00.000Z`);

class ReconciliationPostingService {
  static KINDS = KINDS;

  // Which open invoices a customer receipt (or vendor payment) of this amount would settle, oldest first.
  static async allocation(accountId, lineId, { partyId, kind }, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const line = await R.BankStatementLine.findOne({ _id: lineId, companyId, accountId }).lean();
    if (!line) throw new AppError("Statement line not found", 404, "LINE_NOT_FOUND");
    if (!mongoose.isValidObjectId(partyId)) throw new AppError("Choose the customer or vendor", 400, "PARTY_REQUIRED");
    const type = kind === "payment" ? "payable" : "receivable";
    const open = await AgeingService.openInvoices({ type, asOf: new Date(), partyId });
    return this.allocate(open, Math.abs(line.amount));
  }

  static allocate(open, amount) {
    let left = round2(amount);
    const invoices = [];
    for (const inv of [...open].sort((a, b) => new Date(a.date) - new Date(b.date))) {
      const take = Math.min(left, inv.outstanding);
      if (take > 0.004) {
        invoices.push({ invoiceId: inv.transactionId, transactionNo: inv.transactionNo, date: inv.date, outstanding: inv.outstanding, allocate: round2(take), balance: round2(inv.outstanding - take) });
        left = round2(left - take);
      }
    }
    return { invoices, allocated: round2(amount - left), onAccount: left };
  }

  static async createFromLine(accountId, lineId, input = {}, req, by) {
    const account = await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const kind = input.kind;
    if (!KINDS.includes(kind)) throw new AppError(`Choose what this line is: ${KINDS.join(", ")}`, 400, "KIND_REQUIRED");
    if (!mongoose.isValidObjectId(lineId)) throw new AppError("Statement line not found", 404, "LINE_NOT_FOUND");

    return tx(async (session) => {
      const line = await R.BankStatementLine.findOne({ _id: lineId, companyId, accountId, state: "open" }).session(session).lean();
      if (!line) throw new AppError("That line is no longer open", 409, "LINE_NOT_OPEN");
      const gross = Math.abs(line.amount);
      const date = voucherDate(line.day);
      const said = clip(line.description, 120) || `statement line ${line.lineNo}`;
      const narration = `Bank statement ${line.day}: ${said}`;
      const ref = clip(line.reference, 60) || clip(line.description, 40) || `STMT-${line.lineNo}`;
      const bankDetails = { accountId: account._id, reference: ref, referenceDate: line.day };

      let data;
      if (kind === "fee") {
        if (!(line.amount < 0)) throw new AppError("A bank charge is money going out; this line is money coming in", 400, "WRONG_DIRECTION");
        const expenseAccountId = input.postToAccountId || await configured("bank-charges", { session, req });
        // VAT as the bank charged it: the statement shows the gross, so the net is worked back from it
        let code = null;
        if (input.taxCodeId) code = await TaxCode.findOne({ _id: input.taxCodeId, companyId, isActive: true }).session(session).lean();
        else if (input.vat !== false) code = await TaxCode.findOne({ companyId, isDefault: true, isActive: true }).session(session).lean();
        if (input.taxCodeId && !code) throw new AppError("Tax code not found or inactive", 400, "INVALID_TAX_CODE");
        const rate = code ? TaxCodeService.rateOn(code, date) : 0;
        const split = S.splitGross(gross, rate);
        data = {
          voucherType: "expense", ledgerBased: true, date, expenseAccountId, amount: split.net,
          ...(code && rate > 0 ? { taxCodeId: code._id, vatAmount: split.vat } : code ? { taxCodeId: code._id } : {}),
          description: clip(input.description, 150) || `Bank charges - ${said}`, narration,
          paymentMode: "bank", paymentDetails: { accountId: account._id, reference: ref },
        };
      } else if (kind === "interest") {
        if (!(line.amount > 0)) throw new AppError("Interest is money coming in; this line is money going out", 400, "WRONG_DIRECTION");
        const incomeId = input.postToAccountId || await configured("bank-interest", { session, req });
        data = {
          voucherType: "journal", date, narration,
          lines: [{ accountId: account._id, debit: gross, narration: `Interest received - ${said}` }, { accountId: incomeId, credit: gross, narration: `Interest received - ${said}` }],
        };
      } else if (kind === "transfer") {
        if (!input.otherAccountId) throw new AppError("Choose the other cash or bank account", 400, "ACCOUNT_REQUIRED");
        if (String(input.otherAccountId) === String(accountId)) throw new AppError("A transfer needs a different account", 400, "SAME_ACCOUNT");
        const out = line.amount < 0;
        data = {
          voucherType: "contra", ledgerBased: true, date, totalAmount: gross, narration,
          fromAccountId: out ? account._id : input.otherAccountId, toAccountId: out ? input.otherAccountId : account._id,
        };
      } else if (kind === "receipt" || kind === "payment") {
        const isReceipt = kind === "receipt";
        if (isReceipt !== line.amount > 0) throw new AppError(isReceipt ? "A receipt is money coming in" : "A payment is money going out", 400, "WRONG_DIRECTION");
        if (!mongoose.isValidObjectId(input.partyId)) throw new AppError(`Choose the ${isReceipt ? "customer" : "vendor"}`, 400, "PARTY_REQUIRED");
        let linkedInvoices = [];
        if (input.allocate !== "none") {
          const open = await AgeingService.openInvoices({ type: isReceipt ? "receivable" : "payable", asOf: new Date(), partyId: input.partyId, session });
          linkedInvoices = this.allocate(open, gross).invoices.map((i) => ({ invoiceId: i.invoiceId, amount: i.allocate, balance: i.balance }));
        }
        data = {
          voucherType: isReceipt ? "receipt" : "payment", date, totalAmount: gross, linkedInvoices, narration,
          ...(isReceipt ? { customerId: input.partyId } : { vendorId: input.partyId }),
          paymentMode: "transfer", paymentDetails: bankDetails,
        };
      } else {
        if (!input.postToAccountId) throw new AppError("Choose the account to post to", 400, "ACCOUNT_REQUIRED");
        const money = line.amount > 0;
        data = {
          voucherType: "journal", date, narration: clip(input.description, 200) || narration,
          lines: [
            { accountId: account._id, ...(money ? { debit: gross } : { credit: gross }), narration },
            { accountId: input.postToAccountId, ...(money ? { credit: gross } : { debit: gross }), narration },
          ],
        };
      }

      const voucher = await FinancialService.createVoucher(data, by, session);
      const entry = await Core.bankEntryOf(voucher._id, account._id, { session });
      const match = await Core.createMatch({
        accountId, lines: [line], entries: [entry], kind: "created", method: "created", by: by ? String(by) : null, session, req,
        createdVouchers: [{ voucherId: voucher._id, voucherNo: voucher.voucherNo, kind }],
      });
      return { voucher: { _id: voucher._id, voucherNo: voucher.voucherNo, voucherType: voucher.voucherType, totalAmount: voucher.totalAmount }, match: match.toObject() };
    });
  }
}

module.exports = ReconciliationPostingService;
