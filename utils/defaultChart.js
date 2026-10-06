// The chart of accounts a new food-trading company starts with. Five categories (Assets,
// Liabilities, Equity, Income, Expenses) hold groups, which hold accounts: for example
//   Assets > Current Assets > Bank > Bank Account
// Customer and vendor ledger accounts are not listed: they are created per party the first time
// that party is invoiced.
//
// Names that other code looks accounts up by ("Cash in Hand", "Bank Account") are kept exactly.

// [name, prefix, category, parent group name | null]
const GROUPS = [
  ["Current Assets", "CA", "ASSET", null],
  ["Cash", "CASH", "ASSET", "Current Assets"],
  ["Bank", "BANK", "ASSET", "Current Assets"],
  ["Accounts Receivable", "AR", "ASSET", "Current Assets"],
  ["Inventory", "INV", "ASSET", "Current Assets"],
  ["Tax Receivable", "TAXA", "ASSET", "Current Assets"],
  ["Post-dated Cheques Received", "PDCR", "ASSET", "Current Assets"],
  ["Fixed Assets", "FA", "ASSET", null],

  ["Current Liabilities", "CL", "LIABILITY", null],
  ["Accounts Payable", "AP", "LIABILITY", "Current Liabilities"],
  ["Tax Payable", "TAXL", "LIABILITY", "Current Liabilities"],
  ["Post-dated Cheques Issued", "PDCI", "LIABILITY", "Current Liabilities"],
  ["Credit Cards", "CC", "LIABILITY", "Current Liabilities"],
  ["Long-term Liabilities", "LTL", "LIABILITY", null],

  ["Equity", "EQ", "EQUITY", null],

  ["Sales Income", "SAL", "INCOME", null],
  ["Other Income", "OI", "INCOME", null],

  ["Cost of Goods Sold", "COGS", "EXPENSE", null],
  ["Operating Expenses", "OPEX", "EXPENSE", null],
];

// [account name, group name, posting-map key it backs | null]
const ACCOUNTS = [
  ["Cash in Hand", "Cash", null],
  ["Petty Cash", "Cash", null],
  ["Bank Account", "Bank", null],
  ["Inventory Stock", "Inventory", "inventory-asset"],
  ["Input VAT", "Tax Receivable", "vat-purchase"],
  ["Cheques in Hand", "Post-dated Cheques Received", "pdc-receipt"],
  ["Furniture & Equipment", "Fixed Assets", null],
  ["Vehicles", "Fixed Assets", null],

  ["Output VAT", "Tax Payable", "vat-sales"],
  ["Reverse-charge VAT", "Tax Payable", "rcm-purchase"],
  ["Cheques Issued", "Post-dated Cheques Issued", "pdc-issue"],
  ["Bank Loan", "Long-term Liabilities", null],

  ["Owner's Capital", "Equity", null],
  ["Retained Earnings", "Equity", null],
  ["Opening Balance Equity", "Equity", "opening-balance-equity"],

  ["Sales Revenue", "Sales Income", "sales-revenue"],
  ["Freight Recovered", "Other Income", "freight-sales"],
  ["Purchase Discounts Received", "Other Income", "discount-purchase"],
  ["Other Income", "Other Income", null],
  ["Bank Interest Income", "Other Income", "bank-interest"],

  ["Cost of Goods Sold", "Cost of Goods Sold", "cogs"],
  ["Purchase Variance", "Cost of Goods Sold", "purchase-variance"],
  ["Stock Adjustment", "Cost of Goods Sold", "stock-adjustment"],
  ["Stock Write-off - Expiry", "Cost of Goods Sold", "write-off-expiry"],
  ["Stock Write-off - Damage", "Cost of Goods Sold", "damage-loss"],
  ["Sales Discounts Given", "Operating Expenses", "discount-sales"],
  ["Freight on Purchases", "Operating Expenses", "freight-purchase"],
  ["Round-off Expense (Purchases)", "Operating Expenses", "round-off-purchase"],
  ["Round-off Expense (Sales)", "Operating Expenses", "round-off-sales"],
  ["Salaries & Wages", "Operating Expenses", null],
  ["Rent Expense", "Operating Expenses", null],
  ["Utilities", "Operating Expenses", null],
  ["Bank Charges", "Operating Expenses", "bank-charges"],
  ["Card Processing Fees", "Operating Expenses", "card-charges"],
];

// Which default group backs each group-kind posting key.
const GROUP_FOR_KEY = {
  "cash-account-group": "Cash",
  "bank-account-group": "Bank",
  "account-receivable-group": "Accounts Receivable",
  "account-payable-group": "Accounts Payable",
  "inventory-asset-group": "Inventory",
  "sales-income-group": "Sales Income",
  "purchase-expense-group": "Cost of Goods Sold",
  "direct-income-group": "Sales Income",
  "indirect-income-group": "Other Income",
  "direct-expense-group": "Cost of Goods Sold",
  "indirect-expense-group": "Operating Expenses",
  "pdc-receipt-group": "Post-dated Cheques Received",
  "pdc-issue-group": "Post-dated Cheques Issued",
  "credit-card-group": "Credit Cards",
};

module.exports = { GROUPS, ACCOUNTS, GROUP_FOR_KEY };
