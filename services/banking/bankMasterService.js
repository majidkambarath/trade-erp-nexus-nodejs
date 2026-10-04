const { BankMaster, CardMaster } = require("../../models/modules/banking/bankingModels");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { isValidIban, normalizeIban, maskTail } = require("../../utils/iban");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FIELDS = ["bankName", "bankCode", "swiftCode", "country", "city", "branches", "notes", "isActive"];

class BankMasterService {
  static async list(req, { q, active } = {}) {
    const { companyId } = getTenant(req);
    const filter = { companyId };
    if (active === "true" || active === true) filter.isActive = true;
    if (q) filter.$or = [{ bankName: new RegExp(escapeRe(q), "i") }, { bankCode: new RegExp(escapeRe(q), "i") }];
    return BankMaster.find(filter).sort({ bankName: 1 }).lean();
  }

  static async get(id, req) {
    const { companyId } = getTenant(req);
    const bank = await BankMaster.findOne({ _id: id, companyId }).lean();
    if (!bank) throw new AppError("Bank not found", 404);
    return bank;
  }

  static async create(data, req) {
    const { companyId, branchId } = getTenant(req);
    const bankName = String(data.bankName || "").trim();
    const bankCode = String(data.bankCode || "").trim().toUpperCase();
    if (!bankName) throw new AppError("Bank name is required", 400, "NAME_REQUIRED");
    if (!bankCode) throw new AppError("Bank code is required", 400, "CODE_REQUIRED");
    await this.assertUnique({ companyId, bankName, bankCode });
    return (await BankMaster.create({ ...this.pick(data), bankName, bankCode, companyId, branchId })).toObject();
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const bank = await BankMaster.findOne({ _id: id, companyId });
    if (!bank) throw new AppError("Bank not found", 404);
    const patch = this.pick(data);
    if (patch.bankName !== undefined) patch.bankName = String(patch.bankName).trim();
    if (patch.bankCode !== undefined) patch.bankCode = String(patch.bankCode).trim().toUpperCase();
    if (patch.bankName === "" || patch.bankCode === "") throw new AppError("Bank name and code cannot be empty", 400);
    if (patch.bankName || patch.bankCode) {
      await this.assertUnique({ companyId, bankName: patch.bankName, bankCode: patch.bankCode, excludeId: id });
    }
    if (patch.isActive === false && bank.isActive) {
      const [accounts, cards] = await Promise.all([
        LedgerAccount.countDocuments({ "bank.bankId": bank._id, isActive: true }),
        CardMaster.countDocuments({ companyId, bankId: bank._id, isActive: true }),
      ]);
      if (accounts || cards) {
        throw new AppError(
          `${bank.bankName} is used by ${accounts} bank account(s) and ${cards} card(s). Move or deactivate those first.`,
          409,
          "BANK_IN_USE"
        );
      }
    }
    Object.assign(bank, patch);
    await bank.save();
    return bank.toObject();
  }

  static pick(data) {
    const out = {};
    for (const k of FIELDS) if (data[k] !== undefined) out[k] = data[k];
    if (out.branches) out.branches = out.branches.filter((b) => b && (b.name || b.code));
    return out;
  }

  static async assertUnique({ companyId, bankName, bankCode, excludeId }) {
    const or = [];
    if (bankName) or.push({ bankName: new RegExp(`^${escapeRe(bankName)}$`, "i") });
    if (bankCode) or.push({ bankCode });
    if (!or.length) return;
    const dup = await BankMaster.findOne({ companyId, $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean();
    if (dup) {
      const what = dup.bankCode === bankCode ? `code ${dup.bankCode}` : `name ${dup.bankName}`;
      throw new AppError(`A bank with ${what} already exists`, 409, "DUPLICATE_BANK");
    }
  }

  // Cleans the bank details attached to a ledger account (the company's own bank account).
  // Returns the object to store, or null when the details are empty.
  static async cleanAccountBank(input, req) {
    if (!input) return null;
    const { companyId } = getTenant(req);
    const out = {
      bankId: input.bankId || null,
      branchCode: String(input.branchCode || "").trim().toUpperCase(),
      accountNumber: String(input.accountNumber || "").replace(/\s+/g, ""),
      iban: normalizeIban(input.iban),
      accountHolder: String(input.accountHolder || "").trim(),
    };
    if (!out.bankId && !out.accountNumber && !out.iban && !out.accountHolder) return null;
    if (out.bankId) {
      const bank = await BankMaster.findOne({ _id: out.bankId, companyId }).lean();
      if (!bank) throw new AppError("Choose a bank from the bank master", 400, "BANK_NOT_FOUND");
      if (!bank.isActive) throw new AppError(`${bank.bankName} is inactive`, 400, "BANK_INACTIVE");
    }
    if (out.accountNumber && !/^[A-Za-z0-9-]{4,34}$/.test(out.accountNumber)) {
      throw new AppError("Account number can only contain letters, digits and dashes (4 to 34 characters)", 400, "INVALID_ACCOUNT_NUMBER");
    }
    if (out.iban && !isValidIban(out.iban)) {
      throw new AppError("That IBAN is not valid. Check it for a typing mistake.", 400, "INVALID_IBAN");
    }
    return out;
  }

  // The bank details of one of the company's own accounts. Lists and vouchers use the masked number.
  static describeAccountBank(bank, banksById) {
    if (!bank) return null;
    return {
      bankId: bank.bankId || null,
      bankName: bank.bankId ? banksById?.get(String(bank.bankId))?.bankName || "" : "",
      branchCode: bank.branchCode || "",
      accountNumber: bank.accountNumber || "", // the company's own account: needed to edit it
      accountNumberMasked: bank.accountNumber ? maskTail(bank.accountNumber) : "",
      iban: bank.iban || "",
      accountHolder: bank.accountHolder || "",
    };
  }
}

module.exports = BankMasterService;
