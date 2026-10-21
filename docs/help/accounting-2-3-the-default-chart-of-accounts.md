---
title: "The default chart of accounts"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.3
screens: ["/chart-of-accounts"]
questions:
  - "what is the default chart of accounts"
  - "which accounts do I get"
---

# The default chart of accounts

A new company starts from this chart. It has five categories (Assets, Liabilities, Equity, Income, Expenses). Categories hold groups, groups can hold groups, and groups hold accounts, for example Assets > Current Assets > Bank > Bank Account. Customer and vendor accounts are not listed; they are created per party (section 2.4).

Table 7. The 19 default groups

| Group | Prefix | Category | Parent group | Posting-map keys that point at it |
|---|---|---|---|---|
| Current Assets | CA | Asset | | |
| Cash | CASH | Asset | Current Assets | cash-account-group |
| Bank | BANK | Asset | Current Assets | bank-account-group |
| Accounts Receivable | AR | Asset | Current Assets | account-receivable-group |
| Inventory | INV | Asset | Current Assets | inventory-asset-group |
| Tax Receivable | TAXA | Asset | Current Assets | |
| Post-dated Cheques Received | PDCR | Asset | Current Assets | pdc-receipt-group |
| Fixed Assets | FA | Asset | | |
| Current Liabilities | CL | Liability | | |
| Accounts Payable | AP | Liability | Current Liabilities | account-payable-group |
| Tax Payable | TAXL | Liability | Current Liabilities | |
| Post-dated Cheques Issued | PDCI | Liability | Current Liabilities | pdc-issue-group |
| Credit Cards | CC | Liability | Current Liabilities | credit-card-group |
| Long-term Liabilities | LTL | Liability | | |
| Equity | EQ | Equity | | |
| Sales Income | SAL | Income | | sales-income-group, direct-income-group |
| Other Income | OI | Income | | indirect-income-group |
| Cost of Goods Sold | COGS | Expense | | purchase-expense-group, direct-expense-group |
| Operating Expenses | OPEX | Expense | | indirect-expense-group |

Table 8. The 33 default accounts (codes as created on a fresh company)

| Code | Account | Group | Category | Backs key |
|---|---|---|---|---|
| CASH0001 | Cash in Hand | Cash | Asset | |
| CASH0002 | Petty Cash | Cash | Asset | |
| BANK0001 | Bank Account | Bank | Asset | |
| INV0001 | Inventory Stock | Inventory | Asset | inventory-asset |
| TAXA0001 | Input VAT | Tax Receivable | Asset | vat-purchase |
| PDCR0001 | Cheques in Hand | Post-dated Cheques Received | Asset | pdc-receipt |
| FA0001 | Furniture & Equipment | Fixed Assets | Asset | |
| FA0002 | Vehicles | Fixed Assets | Asset | |
| TAXL0001 | Output VAT | Tax Payable | Liability | vat-sales |
| TAXL0002 | Reverse-charge VAT | Tax Payable | Liability | rcm-purchase |
| PDCI0001 | Cheques Issued | Post-dated Cheques Issued | Liability | pdc-issue |
| LTL0001 | Bank Loan | Long-term Liabilities | Liability | |
| EQ0001 | Owner's Capital | Equity | Equity | |
| EQ0002 | Retained Earnings | Equity | Equity | |
| EQ0003 | Opening Balance Equity | Equity | Equity | opening-balance-equity |
| SAL0001 | Sales Revenue | Sales Income | Income | sales-revenue |
| OI0001 | Freight Recovered | Other Income | Income | freight-sales |
| OI0002 | Purchase Discounts Received | Other Income | Income | discount-purchase |
| OI0003 | Other Income | Other Income | Income | |
| COGS0001 | Cost of Goods Sold | Cost of Goods Sold | Expense | cogs |
| COGS0002 | Purchase Variance | Cost of Goods Sold | Expense | purchase-variance |
| COGS0003 | Stock Adjustment | Cost of Goods Sold | Expense | stock-adjustment |
| COGS0004 | Stock Write-off - Expiry | Cost of Goods Sold | Expense | write-off-expiry |
| COGS0005 | Stock Write-off - Damage | Cost of Goods Sold | Expense | damage-loss |
| OPEX0001 | Sales Discounts Given | Operating Expenses | Expense | discount-sales |
| OPEX0002 | Freight on Purchases | Operating Expenses | Expense | freight-purchase |
| OPEX0003 | Round-off Expense (Purchases) | Operating Expenses | Expense | round-off-purchase |
| OPEX0004 | Round-off Expense (Sales) | Operating Expenses | Expense | round-off-sales |
| OPEX0005 | Salaries & Wages | Operating Expenses | Expense | |
| OPEX0006 | Rent Expense | Operating Expenses | Expense | |
| OPEX0007 | Utilities | Operating Expenses | Expense | |
| OPEX0008 | Bank Charges | Operating Expenses | Expense | |
| OPEX0009 | Card Processing Fees | Operating Expenses | Expense | card-charges |

### 2.3.1 How the default chart is created

**Idempotent.** Groups and accounts are matched by name. Anything that already exists is left exactly as the company has it, so the routine can be run again to restore a deleted default (route POST /accounting/chart/defaults; it adds, never changes or removes).

**Codes.** An account code is the group prefix plus a four-digit counter kept on the group (CASH0001, BANK0001, AR0001...). The counter moves past the highest existing code in one update, so accounts created at the same moment get different codes and a typed code is never reissued.

**System flag.** Accounts created by the routine carry isSystemAccount: true. All of them accept direct posting. The account's type is the lower-case category of its group; its sub-type is a convenience field that no report uses to classify an account.

**What it does not do.** It does not create a fiscal year and does not switch ledger posting on. Those are separate steps (sections 2.5 and 3.1).

**Mapping.** After the chart exists, every group key and account key that has no target is pointed at the default group or account in the tables above. A mapping the company already chose is never overwritten.
