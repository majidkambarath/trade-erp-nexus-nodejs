const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const { BankMaster } = require("../../models/modules/banking/bankingModels");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const { CardService, groupFamily } = require("./cardService");
const BankMasterService = require("./bankMasterService");
const AppError = require("../../utils/AppError");
const UsageService = require("../core/usageService");
const plans = require("../../utils/plans");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

// How money moves on a receipt or payment voucher.
//
//   cash      cash account (default: the first one in the Cash group)
//   bank      deposit into / withdrawal from a bank account (slip number optional)
//   transfer  bank transfer: bank account + the transfer reference
//   cheque    cheque number, date and the bank account it is deposited to / drawn on. The amount
//             waits in a post-dated cheques account until the cheque clears (ChequeService).
//   card      a card from the card master: a merchant terminal on receipts (settles to its bank
//             account less the processor's fee), the company's own card on payments
//
// "online" is the old name for transfer.
const MODES = ["cash", "bank", "transfer", "cheque", "card"];
const STALE_CHEQUE_DAYS = 183; // a UAE cheque is stale after six months

const normalizeMode = (mode) => {
  const m = String(mode || "").trim().toLowerCase();
  const canonical = m === "online" ? "transfer" : m;
  if (!MODES.includes(canonical)) throw new AppError("Invalid payment mode", 400, "INVALID_PAYMENT_MODE");
  return canonical;
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const asDate = (v, label) => {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw new AppError(`Enter a valid ${label}`, 400, "INVALID_DATE");
  return d;
};

const leg = (account, { debit = 0, credit = 0, description }) => ({
  accountId: account._id,
  accountName: account.accountName,
  accountCode: account.accountCode,
  debitAmount: round2(debit),
  creditAmount: round2(credit),
  description,
});

// A configured single account (pdc-receipt, card-charges...). A company set up before these keys
// existed has them unmapped; the defaults are added once (never overwriting a mapping) and we retry.
async function configuredAccount(configKey, { session, req }) {
  let id;
  try {
    id = await AccountConfigService.resolveAccount(configKey, { session });
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await DefaultChartService.provision(req);
    id = await AccountConfigService.resolveAccount(configKey, { session });
  }
  const q = LedgerAccount.findById(id).select("accountName accountCode isActive");
  return session ? q.session(session) : q;
}

class PaymentModeService {
  static MODES = MODES;
  static normalizeMode = normalizeMode;

  // The cash or bank account the money goes through: the one the user chose, or, when they did
  // not, the only candidate. Choosing is never guessed when there are several banks.
  static async pickAccount(configKey, accountId, { session, req, what }) {
    const { companyId } = getTenant(req);
    const { ids } = await groupFamily(configKey, req);
    const base = LedgerAccount.find({ isActive: true, allowDirectPosting: { $ne: false }, groupId: { $in: ids } }).sort({ accountCode: 1 });
    const candidates = await (session ? base.session(session) : base);
    if (accountId) {
      const found = candidates.find((a) => String(a._id) === String(accountId));
      if (!found) {
        throw new AppError(`That is not an active ${what} account`, 400, what === "cash" ? "NOT_A_CASH_ACCOUNT" : "NOT_A_BANK_ACCOUNT");
      }
      return found;
    }
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) throw new AppError(`There is no ${what} account yet. Add one in the chart of accounts.`, 422, "NO_ACCOUNT");
    if (what === "cash") return candidates[0]; // the default cash account is the first one
    throw new AppError("Choose the bank account", 400, "BANK_ACCOUNT_REQUIRED");
  }

  // Validates the mode's details and returns the money-side ledger legs plus what to store on
  // the voucher. The caller adds the party side. Receipts debit these legs, payments credit them.
  static async resolve({ direction, mode, details = {}, amount, date, description, session, req }) {
    mode = normalizeMode(mode);
    // Cheques and cards belong to the banking feature; cash and a transfer to a bank account do not need it.
    if (mode === "cheque" || mode === "card") await UsageService.assertFeature("banking");
    amount = round2(amount);
    if (!(amount > 0)) throw new AppError("Valid total amount is required", 400, "INVALID_AMOUNT");
    const isReceipt = direction === "receipt";
    const side = (account, value, text) => leg(account, { [isReceipt ? "debit" : "credit"]: value, description: text || description });
    const voucherDate = date ? new Date(date) : new Date();

    // Old callers sent mode-specific blocks; both shapes are understood.
    const reference = String(details.reference || details.onlineDetails?.transactionId || details.bankDetails?.reference || "").trim();
    const referenceDate = details.referenceDate || details.onlineDetails?.transactionDate || null;

    const stored = { reference: undefined };
    let legs;
    let cheque = null;

    if (mode === "cash") {
      const account = await this.pickAccount("cash-account-group", details.accountId, { session, req, what: "cash" });
      legs = [side(account, amount)];
      Object.assign(stored, { accountId: account._id, accountName: account.accountName });
    } else if (mode === "bank" || mode === "transfer") {
      if (mode === "transfer") {
        if (!reference) throw new AppError("Enter the transfer reference", 400, "REFERENCE_REQUIRED");
        if (referenceDate) asDate(referenceDate, "transfer date");
      }
      const account = await this.pickAccount("bank-account-group", details.accountId, { session, req, what: "bank" });
      legs = [side(account, amount)];
      Object.assign(stored, {
        accountId: account._id, accountName: account.accountName, reference: reference || undefined,
        referenceDate: referenceDate ? new Date(referenceDate) : mode === "transfer" ? voucherDate : undefined,
        // what older screens and printouts read
        bankDetails: { accountNumber: BankMasterService.describeAccountBank(account.bank)?.accountNumberMasked || account.accountCode, accountName: account.accountName },
        ...(mode === "transfer" ? { onlineDetails: { transactionId: reference, transactionDate: referenceDate ? new Date(referenceDate) : voucherDate } } : {}),
      });
    } else if (mode === "cheque") {
      const chequeNo = String(details.chequeNo || details.chequeDetails?.chequeNumber || "").trim();
      if (!chequeNo) throw new AppError("Enter the cheque number", 400, "CHEQUE_NUMBER_REQUIRED");
      if (!/^[A-Za-z0-9-]{3,20}$/.test(chequeNo)) throw new AppError("The cheque number can only contain letters, digits and dashes", 400, "INVALID_CHEQUE_NUMBER");
      const chequeDate = asDate(details.chequeDate || details.chequeDetails?.chequeDate, "cheque date");
      const ageDays = (startOfDay(voucherDate) - startOfDay(chequeDate)) / 86400000;
      if (ageDays > STALE_CHEQUE_DAYS) throw new AppError("This cheque is more than six months old and is stale", 400, "STALE_CHEQUE");
      let drawnOnBankName = String(details.drawnOnBankName || "").trim();
      let drawnOnBankId = details.drawnOnBankId || null;
      if (drawnOnBankId) {
        const bank = await BankMaster.findOne({ _id: drawnOnBankId, companyId: getTenant(req).companyId }).lean();
        if (!bank) throw new AppError("Bank not found", 400, "BANK_NOT_FOUND");
        drawnOnBankName = bank.bankName;
      }
      if (isReceipt && !drawnOnBankId && !drawnOnBankName) {
        throw new AppError("Say which bank the customer's cheque is drawn on", 400, "DRAWN_ON_BANK_REQUIRED");
      }
      const bankAccount = await this.pickAccount("bank-account-group", details.accountId, { session, req, what: "bank" });
      const pdc = await configuredAccount(isReceipt ? "pdc-receipt" : "pdc-issue", { session, req });
      // The amount sits in the post-dated cheques account until the cheque clears.
      legs = [side(pdc, amount, `${description} (cheque ${chequeNo})`)];
      const isPDC = startOfDay(chequeDate) > startOfDay(voucherDate);
      Object.assign(stored, {
        accountId: bankAccount._id, accountName: bankAccount.accountName, drawnOnBankId: drawnOnBankId || undefined,
        drawnOnBankName: drawnOnBankName || undefined, isPDC,
        chequeDetails: { chequeNumber: chequeNo, chequeDate },
      });
      cheque = { chequeNo, chequeDate, isPDC, drawnOnBankId: drawnOnBankId || null, drawnOnBankName, bankAccountId: bankAccount._id, amount };
    } else if (mode === "card") {
      if (!details.cardId) throw new AppError("Choose the card", 400, "CARD_REQUIRED");
      const card = await CardService.forUse(details.cardId, direction, { session, req });
      const approvalCode = String(details.approvalCode || "").trim();
      if (isReceipt && !approvalCode) throw new AppError("Enter the approval code from the card slip", 400, "APPROVAL_CODE_REQUIRED");
      const account = await LedgerAccount.findById(card.accountId).select("accountName accountCode currentBalance isActive").session(session || null);
      if (!account || !account.isActive) throw new AppError(`The account behind ${card.label} is inactive`, 400, "CARD_ACCOUNT_INACTIVE");
      let fee = 0;
      if (isReceipt) {
        const pct = card.feePercent ?? card.cardTypeId?.feePercent ?? 0;
        fee = round2((amount * pct) / 100);
        legs = [side(account, round2(amount - fee), `${description} (card ${card.label})`)];
        if (fee > 0) {
          const charges = await configuredAccount("card-charges", { session, req });
          legs.push(side(charges, fee, `Card processing fee - ${card.label}`));
        }
      } else {
        if (card.kind === "credit" && card.creditLimit > 0) {
          const owed = Math.max(0, Number(account.currentBalance) || 0);
          if (round2(owed + amount) > card.creditLimit) {
            throw new AppError(
              `${card.label} would be over its limit: ${owed.toFixed(2)} used of ${card.creditLimit.toFixed(2)}, this payment is ${amount.toFixed(2)}`,
              422,
              "CARD_LIMIT_EXCEEDED"
            );
          }
        }
        legs = [side(account, amount, `${description} (card ${card.label})`)];
      }
      Object.assign(stored, {
        accountId: account._id, accountName: account.accountName, cardId: card._id, cardLabel: card.label,
        cardTypeName: card.cardTypeId?.name, cardLast4: card.last4 || undefined, approvalCode: approvalCode || undefined,
        cardFee: fee || undefined,
      });
    }

    // Every leg is on the money side, so their total is the voucher total (fee included).
    const total = round2(legs.reduce((t, l) => t + l.debitAmount + l.creditAmount, 0));
    if (Math.abs(total - amount) > 0.005) throw new AppError("The payment legs do not add up to the amount", 500, "LEGS_MISMATCH");

    return { mode, legs, details: stored, cheque };
  }

  // Everything a receipt/payment form needs to offer: modes, accounts per mode, cards, banks.
  static async options(req) {
    const { companyId } = getTenant(req);
    const [cash, bank] = await Promise.all([groupFamily("cash-account-group", req), groupFamily("bank-account-group", req)]);
    const accounts = await LedgerAccount.find({ isActive: true, allowDirectPosting: { $ne: false }, groupId: { $in: [...cash.ids, ...bank.ids] } })
      .sort({ accountCode: 1 })
      .lean();
    const banks = await BankMaster.find({ companyId }).sort({ bankName: 1 }).lean();
    const byId = new Map(banks.map((b) => [String(b._id), b]));
    const cashSet = new Set(cash.ids);
    const shape = (a) => ({
      _id: a._id, accountName: a.accountName, accountCode: a.accountCode, balance: a.currentBalance || 0,
      bank: BankMasterService.describeAccountBank(a.bank, byId),
    });
    // Cheques and cards belong to the banking feature: without it they are not offered
    const banking = !req?.organisation || plans.hasFeature(req.organisation, "banking");
    const cards = banking ? await CardService.list(req, { active: true }) : [];
    return {
      modes: banking ? MODES : MODES.filter((m) => m !== "cheque" && m !== "card"),
      cashAccounts: accounts.filter((a) => cashSet.has(String(a.groupId))).map(shape),
      bankAccounts: accounts.filter((a) => !cashSet.has(String(a.groupId))).map(shape),
      banks: banks.filter((b) => b.isActive).map((b) => ({ _id: b._id, bankName: b.bankName, bankCode: b.bankCode })),
      cards: cards.map((c) => ({
        _id: c._id, label: c.label, kind: c.kind, cardTypeName: c.cardTypeName, last4: c.last4,
        forReceipt: c.kind === "terminal", forPayment: c.kind !== "terminal",
        effectiveFeePercent: c.effectiveFeePercent, creditLimit: c.creditLimit, owed: c.owed,
      })),
    };
  }
}

module.exports = PaymentModeService;
