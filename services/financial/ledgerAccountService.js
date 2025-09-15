// services/financial/ledgerAccountService.js
const { LedgerAccount } = require("../../models/financial/financialModels");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class LedgerAccountService {
  // Create new ledger account
  static async createAccount(data, createdBy) {
    const { accountName, accountCode, accountType, subType, parentAccountId, description } = data;

    // Check if account code already exists
    const existingAccount = await LedgerAccount.findOne({ 
      $or: [{ accountCode }, { accountName }] 
    });
    
    if (existingAccount) {
      throw new AppError('Account code or name already exists', 400);
    }

    // Determine level based on parent
    let level = 0;
    if (parentAccountId) {
      const parentAccount = await LedgerAccount.findById(parentAccountId);
      if (!parentAccount) {
        throw new AppError('Parent account not found', 404);
      }
      level = parentAccount.level + 1;
    }

    const accountData = {
      accountName,
      accountCode,
      accountType,
      subType,
      parentAccountId,
      level,
      description,
      createdBy
    };

    const account = await LedgerAccount.create(accountData);
    return account;
  }

  // Get all accounts with hierarchy
  static async getAllAccounts(filters = {}) {
    const query = {};
    
    if (filters.accountType) query.accountType = filters.accountType;
    if (filters.subType) query.subType = filters.subType;
    if (filters.isActive !== undefined) query.isActive = filters.isActive;
    if (filters.allowDirectPosting !== undefined) query.allowDirectPosting = filters.allowDirectPosting;

    const accounts = await LedgerAccount.find(query)
      .populate('parentAccountId', 'accountName accountCode')
      .sort({ accountCode: 1 });

    // Build hierarchy if requested
    if (filters.hierarchy === 'true') {
      return this.buildAccountHierarchy(accounts);
    }

    return accounts;
  }

  // Build account hierarchy
  static buildAccountHierarchy(accounts) {
    const accountMap = new Map();
    const rootAccounts = [];

    // Create map and identify root accounts
    accounts.forEach(account => {
      accountMap.set(account._id.toString(), { ...account.toObject(), children: [] });
      if (!account.parentAccountId) {
        rootAccounts.push(account._id.toString());
      }
    });

    // Build hierarchy
    accounts.forEach(account => {
      if (account.parentAccountId) {
        const parent = accountMap.get(account.parentAccountId.toString());
        if (parent) {
          parent.children.push(accountMap.get(account._id.toString()));
        }
      }
    });

    // Return only root accounts with their children
    return rootAccounts.map(id => accountMap.get(id));
  }

  // Get account by ID
  static async getAccountById(id) {
    const account = await LedgerAccount.findById(id)
      .populate('parentAccountId', 'accountName accountCode');

    if (!account) {
      throw new AppError('Account not found', 404);
    }

    return account;
  }

  // Update account
  static async updateAccount(id, data) {
    const account = await LedgerAccount.findByIdAndUpdate(
      id,
      { ...data, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!account) {
      throw new AppError('Account not found', 404);
    }

    return account;
  }

  // Delete account (only if no transactions exist)
  static async deleteAccount(id) {
    // Check if account has any ledger entries
    const LedgerEntry = mongoose.model('LedgerEntry');
    const hasEntries = await LedgerEntry.findOne({ accountId: id });
    
    if (hasEntries) {
      throw new AppError('Cannot delete account with existing transactions', 400);
    }

    // Check if account has child accounts
    const hasChildren = await LedgerAccount.findOne({ parentAccountId: id });
    
    if (hasChildren) {
      throw new AppError('Cannot delete account with child accounts', 400);
    }

    const account = await LedgerAccount.findByIdAndDelete(id);
    
    if (!account) {
      throw new AppError('Account not found', 404);
    }

    return { message: 'Account deleted successfully' };
  }

  // Get account balance
  static async getAccountBalance(accountId, dateFrom, dateTo) {
    const LedgerEntry = mongoose.model('LedgerEntry');
    
    const matchConditions = { accountId: new mongoose.Types.ObjectId(accountId) };
    if (dateFrom) matchConditions.date = { $gte: new Date(dateFrom) };
    if (dateTo) matchConditions.date = { ...matchConditions.date, $lte: new Date(dateTo) };

    const result = await LedgerEntry.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: null,
          totalDebits: { $sum: '$debitAmount' },
          totalCredits: { $sum: '$creditAmount' }
        }
      }
    ]);

    const account = await this.getAccountById(accountId);
    const totals = result[0] || { totalDebits: 0, totalCredits: 0 };
    
    // Calculate balance based on account type
    let balance;
    if (['asset', 'expense'].includes(account.accountType)) {
      balance = account.openingBalance + totals.totalDebits - totals.totalCredits;
    } else {
      balance = account.openingBalance + totals.totalCredits - totals.totalDebits;
    }

    return {
      account: account.accountName,
      accountType: account.accountType,
      openingBalance: account.openingBalance,
      totalDebits: totals.totalDebits,
      totalCredits: totals.totalCredits,
      closingBalance: balance
    };
  }

  // Get chart of accounts
  static async getChartOfAccounts() {
    const accounts = await LedgerAccount.find({ isActive: true })
      .sort({ accountType: 1, accountCode: 1 });

    // Group by account type
    const chartOfAccounts = {
      assets: accounts.filter(acc => acc.accountType === 'asset'),
      liabilities: accounts.filter(acc => acc.accountType === 'liability'),
      equity: accounts.filter(acc => acc.accountType === 'equity'),
      income: accounts.filter(acc => acc.accountType === 'income'),
      expenses: accounts.filter(acc => acc.accountType === 'expense')
    };

    return chartOfAccounts;
  }
}

module.exports = LedgerAccountService;