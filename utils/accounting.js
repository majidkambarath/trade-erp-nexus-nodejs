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

// What is left of a voucher's total once invoices have been allocated, to the fils. Floating-point addition of several
// two-decimal amounts can differ from the typed total by dust (317266.19000000006 against 317266.19), which, compared
// plainly, made a fully-allocated voucher look as if it allocated MORE than its total and refused it. Only a real
// over-allocation (a whole fils or more) is negative here.
const remainderAfterAllocation = (total, allocated) => {
  const left = round2(Number(total) - Number(allocated));
  return left === 0 ? 0 : left; // never -0
};

module.exports = { naturalBalance, categoryOf, round2, remainderAfterAllocation, CATEGORY_BY_ACCOUNT_TYPE };
