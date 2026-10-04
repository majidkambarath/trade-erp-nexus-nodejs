// Canonical list of posting-map keys for a food-trading company. The seed is authoritative for
// a key's identity and shape (displayName, category, kind, parent); the company's own choice
// of target account/group is preserved across re-seeding and matched by configKey only, so
// re-parenting a key never loses its mapping.
//
// kind: "group"   - the key maps to an AccountGroup (a family of accounts)
//       "account" - the key maps to ONE ledger account
//       "none"    - header only, or implied (share-capital-group means every EQUITY group)
const k = (configKey, displayName, accountCategory, kind, parentConfigKey = null) => ({
  configKey,
  displayName,
  accountCategory,
  targetKind: kind,
  parentConfigKey,
});

const SEED = [
  // --- root: account families ---
  k("cash-account-group", "Cash accounts", "ASSET", "group"),
  k("bank-account-group", "Bank accounts", "ASSET", "group"),
  k("account-receivable-group", "Trade receivables (customers)", "ASSET", "group"),
  k("account-payable-group", "Trade payables (vendors)", "LIABILITY", "group"),
  k("inventory-asset-group", "Inventory", "ASSET", "group"),
  k("sales-income-group", "Sales income", "INCOME", "group"),
  k("purchase-expense-group", "Purchases / cost of goods", "EXPENSE", "group"),
  k("direct-income-group", "Direct income", "INCOME", "group"),
  k("indirect-income-group", "Indirect income", "INCOME", "group"),
  k("direct-expense-group", "Direct expenses", "EXPENSE", "group"),
  k("indirect-expense-group", "Indirect expenses", "EXPENSE", "group"),
  k("share-capital-group", "Share capital & equity", "EQUITY", "none"),
  k("pdc-receipt-group", "Post-dated cheques received", "ASSET", "group"),
  k("pdc-issue-group", "Post-dated cheques issued", "LIABILITY", "group"),
  k("credit-card-group", "Company credit cards", "LIABILITY", "group"),
  k("pdc-receipt", "Cheques in hand (received, not yet cleared)", "ASSET", "account"),
  k("pdc-issue", "Cheques issued (not yet cleared)", "LIABILITY", "account"),
  k("card-charges", "Card processing fees", "EXPENSE", "account"),
  k("stock-adjustment", "Stock adjustment", "EXPENSE", "account"),
  k("inventory-asset", "Inventory (stock on hand)", "ASSET", "account"),
  k("opening-balance-equity", "Opening balance equity", "EQUITY", "account"),

  // --- purchase side ---
  k("purchase-group", "Purchase postings", null, "none"),
  k("vat-purchase", "Input VAT", "ASSET", "account", "purchase-group"),
  k("rcm-purchase", "Reverse-charge VAT (purchases)", "LIABILITY", "account", "purchase-group"),
  k("discount-purchase", "Purchase discounts received", "INCOME", "account", "purchase-group"),
  k("freight-purchase", "Freight & handling on purchases", "EXPENSE", "account", "purchase-group"),
  k("round-off-purchase", "Round-off (purchases)", "EXPENSE", "account", "purchase-group"),
  k("purchase-variance", "Purchase price / quality variance", "EXPENSE", "account", "purchase-group"),

  // --- sales side ---
  k("sales-group", "Sales postings", null, "none"),
  k("sales-revenue", "Sales revenue", "INCOME", "account", "sales-group"),
  k("vat-sales", "Output VAT", "LIABILITY", "account", "sales-group"),
  k("discount-sales", "Sales discounts given", "EXPENSE", "account", "sales-group"),
  k("freight-sales", "Freight & handling recovered", "INCOME", "account", "sales-group"),
  k("round-off-sales", "Round-off (sales)", "EXPENSE", "account", "sales-group"),
  k("cogs", "Cost of goods sold", "EXPENSE", "account", "sales-group"),
  k("write-off-expiry", "Stock written off - expiry", "EXPENSE", "account", "sales-group"),
  k("damage-loss", "Stock written off - damage / loss", "EXPENSE", "account", "sales-group"),
];

module.exports = { SEED };
