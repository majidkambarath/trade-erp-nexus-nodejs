const { CardType, CardMaster, BankMaster } = require("../../models/modules/banking/bankingModels");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const AccountConfigService = require("../financial/accountConfigService");
const AccountGroupService = require("../financial/accountGroupService");
const ChartOfAccountsService = require("../financial/chartOfAccountsService");
const DefaultChartService = require("../financial/defaultChartService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The ids of a posting-map group and everything under it. A company set up before cards existed
// has no mapping for the newer keys yet; the defaults are added (never overwriting) and we retry.
async function groupFamily(configKey, req) {
  const { companyId } = getTenant(req);
  let root;
  try {
    root = await AccountConfigService.resolveGroup(configKey);
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await DefaultChartService.provision(req);
    root = await AccountConfigService.resolveGroup(configKey);
  }
  return { rootId: root, ids: await AccountGroupService.collectDescendantIds(root, companyId) };
}

// --- card types ---------------------------------------------------------------------------
class CardTypeService {
  static async list(req, { active } = {}) {
    const { companyId } = getTenant(req);
    return CardType.find({ companyId, ...(active ? { isActive: true } : {}) }).sort({ name: 1 }).lean();
  }

  static async create(data, req) {
    const { companyId } = getTenant(req);
    const name = String(data.name || "").trim();
    if (!name) throw new AppError("Card type name is required", 400, "NAME_REQUIRED");
    await this.assertUnique(companyId, name);
    const fee = this.fee(data.feePercent);
    return (await CardType.create({ companyId, name, description: data.description, feePercent: fee, isActive: data.isActive !== false })).toObject();
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const type = await CardType.findOne({ _id: id, companyId });
    if (!type) throw new AppError("Card type not found", 404);
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new AppError("Card type name is required", 400, "NAME_REQUIRED");
      await this.assertUnique(companyId, name, id);
      type.name = name;
    }
    if (data.description !== undefined) type.description = data.description;
    if (data.feePercent !== undefined) type.feePercent = this.fee(data.feePercent);
    if (data.isActive !== undefined) {
      if (data.isActive === false && type.isActive) {
        const used = await CardMaster.countDocuments({ companyId, cardTypeId: id, isActive: true });
        if (used) throw new AppError(`${type.name} is used by ${used} active card(s). Deactivate those first.`, 409, "CARD_TYPE_IN_USE");
      }
      type.isActive = Boolean(data.isActive);
    }
    await type.save();
    return type.toObject();
  }

  static fee(v) {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new AppError("The fee must be a percentage between 0 and 100", 400, "INVALID_FEE");
    return Math.round(n * 1000) / 1000;
  }

  static async assertUnique(companyId, name, excludeId) {
    const dup = await CardType.findOne({ companyId, name: new RegExp(`^${escapeRe(name)}$`, "i"), ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean();
    if (dup) throw new AppError(`A card type named "${dup.name}" already exists`, 409, "DUPLICATE_CARD_TYPE");
  }
}

// --- cards --------------------------------------------------------------------------------
class CardService {
  static async list(req, { kind, active } = {}) {
    const { companyId } = getTenant(req);
    const cards = await CardMaster.find({ companyId, ...(kind ? { kind } : {}), ...(active ? { isActive: true } : {}) })
      .populate("cardTypeId", "name feePercent")
      .populate("bankId", "bankName bankCode")
      .populate("accountId", "accountName accountCode currentBalance")
      .sort({ label: 1 })
      .lean();
    return cards.map((c) => this.shape(c));
  }

  static shape(c) {
    const typeFee = c.cardTypeId?.feePercent ?? 0;
    return {
      _id: c._id,
      label: c.label,
      kind: c.kind,
      cardTypeId: c.cardTypeId?._id || c.cardTypeId,
      cardTypeName: c.cardTypeId?.name || "",
      bankId: c.bankId?._id || c.bankId || null,
      bankName: c.bankId?.bankName || "",
      holderName: c.holderName,
      terminalId: c.terminalId,
      last4: c.last4,
      expiryMonth: c.expiryMonth,
      expiryYear: c.expiryYear,
      creditLimit: c.creditLimit,
      feePercent: c.feePercent,
      effectiveFeePercent: c.feePercent ?? typeFee,
      accountId: c.accountId?._id || c.accountId,
      accountName: c.accountId?.accountName || "",
      accountCode: c.accountId?.accountCode || "",
      // for a credit card: how much of the limit is used (liability accounts are credit-natural)
      owed: c.kind === "credit" ? Math.max(0, Number(c.accountId?.currentBalance) || 0) : undefined,
      isActive: c.isActive,
    };
  }

  static async create(data, req, adminId) {
    const { companyId, branchId } = getTenant(req);
    const clean = await this.validate(data, req, {});
    const createdAccount = clean.accountId ? null : await this.createCardAccount(clean, req, adminId);
    try {
      const card = await CardMaster.create({ ...clean.fields, accountId: clean.accountId || createdAccount, companyId, branchId });
      return (await this.list(req)).find((c) => String(c._id) === String(card._id));
    } catch (err) {
      // The account was made for this card alone and has no postings, so it can simply go.
      if (createdAccount) await LedgerAccount.deleteOne({ _id: createdAccount });
      throw err;
    }
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const card = await CardMaster.findOne({ _id: id, companyId });
    if (!card) throw new AppError("Card not found", 404);
    // What kind of card it is, and where it posts, cannot change once it exists: the history
    // already posted against it would change meaning.
    if (data.kind && data.kind !== card.kind) throw new AppError("A card's kind cannot be changed. Add a new card instead.", 409, "KIND_LOCKED");
    const clean = await this.validate({ ...card.toObject(), ...data, kind: card.kind, accountId: card.accountId }, req, { existing: card });
    Object.assign(card, clean.fields);
    await card.save();
    return (await this.list(req)).find((c) => String(c._id) === String(card._id));
  }

  static async validate(data, req, { existing } = {}) {
    const { companyId } = getTenant(req);
    const kind = data.kind;
    if (!["terminal", "credit", "debit", "prepaid"].includes(kind)) throw new AppError("Choose what kind of card this is", 400, "KIND_REQUIRED");
    const label = String(data.label || "").trim();
    if (!label) throw new AppError("Give the card a name", 400, "NAME_REQUIRED");
    const dup = await CardMaster.findOne({ companyId, label: new RegExp(`^${escapeRe(label)}$`, "i"), ...(existing ? { _id: { $ne: existing._id } } : {}) }).lean();
    if (dup) throw new AppError(`A card named "${dup.label}" already exists`, 409, "DUPLICATE_CARD");

    const type = await CardType.findOne({ _id: data.cardTypeId, companyId }).lean();
    if (!type) throw new AppError("Choose a card type", 400, "CARD_TYPE_REQUIRED");
    if (!type.isActive && !(existing && String(existing.cardTypeId) === String(type._id))) throw new AppError(`${type.name} is inactive`, 400, "CARD_TYPE_INACTIVE");

    let bankId = data.bankId || null;
    if (bankId) {
      const bank = await BankMaster.findOne({ _id: bankId, companyId }).lean();
      if (!bank) throw new AppError("Bank not found", 400, "BANK_NOT_FOUND");
    }

    const last4 = String(data.last4 || "").trim();
    if (last4 && !/^\d{4}$/.test(last4)) {
      // A longer number must never be stored by accident, so it is refused rather than trimmed.
      throw new AppError("Enter only the last four digits of the card number", 400, "ONLY_LAST4");
    }
    if (data.cvv || data.cardNumber) throw new AppError("The full card number and CVV are never stored", 400, "NO_FULL_NUMBER");

    const expiryMonth = data.expiryMonth ? Number(data.expiryMonth) : null;
    const expiryYear = data.expiryYear ? Number(data.expiryYear) : null;
    if ((expiryMonth && !expiryYear) || (!expiryMonth && expiryYear)) throw new AppError("Enter both the expiry month and year", 400, "EXPIRY_INCOMPLETE");
    if (expiryMonth && !existing) {
      const now = new Date();
      if (expiryYear < now.getFullYear() || (expiryYear === now.getFullYear() && expiryMonth < now.getMonth() + 1)) {
        throw new AppError("That card has already expired", 400, "CARD_EXPIRED");
      }
    }

    const creditLimit = Number(data.creditLimit || 0);
    if (!Number.isFinite(creditLimit) || creditLimit < 0) throw new AppError("The credit limit cannot be negative", 400, "INVALID_LIMIT");
    if (kind === "credit" && !(creditLimit > 0)) throw new AppError("A credit card needs a credit limit", 400, "LIMIT_REQUIRED");
    if (kind !== "terminal" && !String(data.holderName || "").trim()) throw new AppError("Enter the card holder's name", 400, "HOLDER_REQUIRED");

    const fee = data.feePercent === null || data.feePercent === undefined || data.feePercent === "" ? null : CardTypeService.fee(data.feePercent);
    if (fee !== null && kind !== "terminal") throw new AppError("A processing fee only applies to a merchant terminal", 400, "FEE_NOT_APPLICABLE");

    // Which ledger account the card posts to.
    let accountId = null;
    if (kind === "terminal" || kind === "debit") {
      if (!data.accountId) {
        throw new AppError(
          kind === "terminal" ? "Choose the bank account this terminal settles into" : "Choose the bank account this debit card draws on",
          400,
          "BANK_ACCOUNT_REQUIRED"
        );
      }
      const { ids } = await groupFamily("bank-account-group", req);
      const acc = await LedgerAccount.findById(data.accountId).lean();
      if (!acc || !acc.isActive || !ids.includes(String(acc.groupId))) {
        throw new AppError("That is not an active bank account", 400, "NOT_A_BANK_ACCOUNT");
      }
      accountId = acc._id;
    } else if (existing) {
      accountId = existing.accountId; // credit / prepaid keep the account created for them
    }

    return {
      accountId,
      kind,
      label,
      fields: {
        label, kind, cardTypeId: type._id, bankId,
        holderName: String(data.holderName || "").trim(),
        terminalId: String(data.terminalId || "").trim(),
        last4, expiryMonth, expiryYear,
        creditLimit: kind === "credit" ? creditLimit : 0,
        feePercent: fee,
        isActive: data.isActive !== false,
        ...(accountId ? { accountId } : {}),
      },
    };
  }

  // A credit card is a liability (we owe the card company); a prepaid card is money we hold.
  static async createCardAccount({ kind, label }, req, adminId) {
    const configKey = kind === "credit" ? "credit-card-group" : "bank-account-group";
    const { rootId } = await groupFamily(configKey, req);
    const name = kind === "credit" ? `Credit Card - ${label}` : `Prepaid Card - ${label}`;
    const acc = await ChartOfAccountsService.createAccount({ accountName: name, groupId: rootId }, req, adminId);
    return acc._id;
  }

  // The card, checked for the way it is being used. A terminal receives money; the company's own
  // cards pay it out.
  static async forUse(cardId, direction, { session, req } = {}) {
    const { companyId } = getTenant(req);
    const q = CardMaster.findOne({ _id: cardId, companyId }).populate("cardTypeId", "name feePercent");
    const card = await (session ? q.session(session) : q);
    if (!card) throw new AppError("Card not found", 404, "CARD_NOT_FOUND");
    if (!card.isActive) throw new AppError(`${card.label} is inactive`, 400, "CARD_INACTIVE");
    if (direction === "receipt" && card.kind !== "terminal") {
      throw new AppError(`${card.label} is a ${card.kind} card. Customer payments are taken on a merchant terminal.`, 400, "CARD_NOT_A_TERMINAL");
    }
    if (direction === "payment" && card.kind === "terminal") {
      throw new AppError(`${card.label} is a merchant terminal and cannot pay a vendor.`, 400, "CARD_CANNOT_PAY");
    }
    if (direction === "payment" && card.expiryYear) {
      const now = new Date();
      if (card.expiryYear < now.getFullYear() || (card.expiryYear === now.getFullYear() && card.expiryMonth < now.getMonth() + 1)) {
        throw new AppError(`${card.label} has expired`, 400, "CARD_EXPIRED");
      }
    }
    return card;
  }
}

module.exports = { CardTypeService, CardService, groupFamily };
