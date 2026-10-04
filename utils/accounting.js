// Pure accounting rules, shared by reports and posting. No I/O.

const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

// Natural balance: the sign in which an account of this category is read as positive.
//   ASSET, EXPENSE                 -> debit  - credit
//   LIABILITY, EQUITY, INCOME      -> credit - debit
const naturalBalance = (category, debit = 0, credit = 0) =>
  DEBIT_NORMAL.has(String(category).toUpperCase()) ? debit - credit : credit - debit;

// Legacy LedgerAccount.accountType values -> group categories.
const CATEGORY_BY_ACCOUNT_TYPE = {
  asset: "ASSET",
  liability: "LIABILITY",
  equity: "EQUITY",
  income: "INCOME",
  expense: "EXPENSE",
};

const categoryOf = (accountType) => CATEGORY_BY_ACCOUNT_TYPE[accountType] || "ASSET";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { naturalBalance, categoryOf, round2, CATEGORY_BY_ACCOUNT_TYPE };
