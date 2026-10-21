---
title: "IFRS statements"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.22
---

# IFRS statements

Five statements are produced from the same ledger entries as the trial balance, so they cannot disagree with it: the statement of financial position, the statement of profit or loss (by function), the statement of changes in equity, the statement of cash flows (indirect method) and basic notes. Each takes compare: prior-year (the default), prior-period or none, and returns the comparative column next to the current one.

**Dates.** Dubai days. The end date is asAt (or to), default today. The start from is the first day of the fiscal year containing the end date, using the company's fiscal year start month (default January). Errors: INVALID_DATE, INVALID_RANGE (from after to), INVALID_COMPARE.

**prior-year** = the same days one year earlier (the last day of a month stays the last day, so 29 February maps to 28 February). **prior-period** = the period of the same length just before: whole months move back by that many months (October becomes September, a quarter the quarter before), anything else by the number of days. **none** = no comparative column.

### 4.22.1 How accounts are classified (by name and group)

| **Rule.** Classification is by **name**. An asset or liability is non-current when its group, or any group above it, has a name matching fixed\ | non.?current\ | property\ | plant\ | equipment\ | intangible\ | long.?term (case-insensitive); everything else is current. Every account lands on exactly one side; nothing is left unclassified. Renaming a group changes the statements. |
|---|

Table 48. Name rules

| Purpose | Pattern (case-insensitive) | Matched against |
|---|---|---|
| Non-current | fixed\ | non.?current\ | property\ | plant\ | equipment\ | intangible\ | long.?term | names of the group and its ancestors |
| Income tax (expense, and tax payable) | income tax\ | corporate tax | account name and group names |
| Depreciation and amortisation | depreciation\ | amortis\ | amortiz | account name and group name |
| **Finance costs (and interest payable:** **interest****)** | interest\ | finance\ | bank charges | account name and group name |
| Inventory | inventor\ | stock | account name and group names |
| Receivables | receivable\ | debtor | account name and group names |
| Payables | payable\ | creditor | account name and group names |
| Borrowings | loan\ | borrowing\ | debenture\ | finance lease\ | mortgage (or any non-current liability) | account name and group names |
| Disposal gain or loss | disposal | account name |
| Equity: retained earnings | retained\ | accumulated\ | earnings\ | profit | account name and group names |
| Equity: share capital | capital\ | share | account name and group names |

Table 49. How the accounts that need attention are classified (computed with the real functions; other default accounts follow their group)

| Account | Group path | Position section | Cash-flow bucket |
|---|---|---|---|
| Cash in Hand | Current Assets > Cash | Current assets | cash |
| Inventory Stock | Current Assets > Inventory | Current assets | inventory |
| Input VAT | Current Assets > Tax Receivable | Current assets | receivables |
| Cheques in Hand | Current Assets > Post-dated Cheques Received | Current assets | otherCurrentAssets |
| Furniture & Equipment | Fixed Assets | Non-current assets | nonCurrentAssets |
| Output VAT | Current Liabilities > Tax Payable | Current liabilities | payables |
| Reverse-charge VAT | Current Liabilities > Tax Payable | Current liabilities | payables |
| Cheques Issued | Current Liabilities > Post-dated Cheques Issued | Current liabilities | otherCurrentLiabilities |
| Bank Loan | Long-term Liabilities | Non-current liabilities | borrowings |
| Owner's Capital | Equity | Equity (share capital) | equity |
| Opening Balance Equity | Equity | Equity (other equity) | equity |
| Customer - <name> | Current Assets > Accounts Receivable | Current assets | receivables |
| Advance to Vendor - <name> | Current Assets > Accounts Receivable | Current assets | receivables |
| Vendor - <name> | Current Liabilities > Accounts Payable | Current liabilities | payables |
| Customer Advance - <name> | Current Liabilities > Accounts Payable | Current liabilities | payables |
| Credit Card - <label> | Current Liabilities > Credit Cards | Current liabilities | otherCurrentLiabilities |

| **Note.** Two consequences of the name rules. Input VAT sits in the group 'Tax Receivable', so it is classified with receivables, and Output VAT sits in 'Tax Payable', so it is classified with payables; both move the 'trade and other receivables' and 'trade and other payables' lines of the cash flow. Advances follow the group they are filed in, not the party kind (section 2.4). |
|---|

### 4.22.2 Statement of financial position

| Statement of financial position | Statement of financial position |
|---|---|
| Question it answers | What does the company own and owe, split into current and non-current, with equity? |
| Where | Screen: IFRS statements > Financial position (/ifrs-statements). API: GET /api/v1/ifrs/financial-position?asAt=&from=&compare=. |
| Source data | Ledger entries up to asAt per account, with the group tree. |
| Period and filters | asAt (default today), from (start of the fiscal year), compare. |
| Calculation | • Per account: closingNet = opening net + period net (debit - credit, all entries up to asAt). amount = closingNet for an asset; -closingNet for a liability or an equity account. • Section: asset non-current or current; liability non-current or current; equity accounts in equity. • Presentation order inside current assets: inventory, receivables, other, then cash and bank last. • **Profit is not closed to equity**, so it is shown inside equity as two lines: 'Accumulated profit brought forward' = -(sum of the income and expense accounts' net before from), and 'Profit for the period' = -(their net from from to asAt). • isBalanced = \ | assets - (equity + liabilities)\ | < 0.01; difference shows the amount; the comparative has its own check. |
| Included and excluded | An account in credit on the asset side is shown as a negative on its own side; nothing is moved between sides. Contra accounts (accumulated depreciation) appear as negative lines in their group. |
| Controls and reconciliations | • Balances; equals the trial balance. The note tables agree with the lines. • Equity equals the closing equity of the statement of changes in equity. |
| Output columns and exports | API: assets{nonCurrent, current}, equityAndLiabilities{equity, nonCurrentLiabilities, currentLiabilities}, each with groups, accounts, amount and comparative; isBalanced. Screen with print and CSV. |

### 4.22.3 Statement of profit or loss (by function)

| Statement of profit or loss and other comprehensive income | Statement of profit or loss and other comprehensive income |
|---|---|
| Question it answers | Revenue, cost of sales, gross profit and the expenses by nature, down to the profit for the period. |
| Where | Screen: IFRS statements > Profit or loss. API: GET /api/v1/ifrs/profit-or-loss?from=&to=&compare=. |
| Source data | The ledger profit and loss (section 4.2), then the name rules. |
| Period and filters | from, to, compare. |
| Calculation | Revenue, cost of sales and other income are those of the ledger profit and loss. Each expense account outside the direct costs is tested in this order: income tax; depreciation and amortisation; finance costs; otherwise operating expenses. • Gross profit = revenue - cost of sales. • **Operating profit** = gross profit + other income - operating expenses - depreciation and amortisation. • **Profit before tax** = operating profit - finance costs. • **Profit for the period** = profit before tax - income tax. • Other comprehensive income is zero (none is recognised); total comprehensive income = profit for the period. |
| Included and excluded | With the default chart, Bank Charges is a finance cost (it matches 'bank charges'); Card Processing Fees is an operating expense. Sales Discounts Given is an operating expense. |
| Controls and reconciliations | The profit for the period equals the ledger profit and loss net profit for the same days and the legacy statement. |
| Output columns and exports | API: revenue, costOfSales, grossProfit, otherIncome, operatingExpenses, depreciationAndAmortisation, operatingProfit, financeCosts, profitBeforeTax, incomeTaxExpense, profitForPeriod, otherComprehensiveIncome, totalComprehensiveIncome; each with amount and comparative. |

### 4.22.4 Statement of changes in equity

| Statement of changes in equity | Statement of changes in equity |
|---|---|
| Question it answers | How did each part of equity move during the period? |
| Where | Screen: IFRS statements > Changes in equity. API: GET /api/v1/ifrs/changes-in-equity?from=&to=&compare=. |
| Source data | Equity accounts and the income and expense accounts of the ledger. |
| Period and filters | from, to, compare. |
| Calculation | Three columns plus a total: share capital, retained earnings, other equity and reserves. An equity account goes to the column its name selects: retained earnings if it matches retained\ | accumulated\ | earnings\ | profit; share capital if it matches capital\ | share; otherwise other. 'Opening Balance Equity' is therefore in 'other'. • Opening = the natural opening balance of each equity account; profit of earlier periods (not closed to equity) is added to retained earnings. • Profit for the period = net profit, in retained earnings. • Capital introduced and other increases = the period's positive movements on equity accounts, per column. Drawings, dividends and other decreases = the negative movements. • Closing = opening + profit + other comprehensive income + increases + decreases. It is compared with the equity of the statement of financial position built from the same rows; difference and reconciles show the result. |
| Included and excluded | Owner's drawings posted by journal to the capital account appear under decreases. |
| Controls and reconciliations | reconciles must be true for the current period and the comparative. |
| Output columns and exports | API: columns, current{rows[opening, profit, oci, comprehensive, introduced, reduced, closing], equityPerPosition, difference, reconciles}, comparative, reconciles. |

### 4.22.5 Statement of cash flows (indirect), line by line

Every figure is signed as cash: money in positive, money out negative. For a non-cash account the cash effect of a period is the **opposite of its net movement** (debit - credit): stock rising uses cash, a payable rising keeps it. Each account is put in one bucket by the name rules, and the lines are:

Table 50. Cash flow lines (IfrsReportsService.cashFlowFigures)

| Line | Formula | Accounts that feed it |
|---|---|---|
| Profit before tax | from the profit or loss statement | all income and expense accounts except income tax |
| + Depreciation and amortisation | total of depreciation accounts (in expenses or in cost of sales) | names matching depreciation, amortisation |
| + Finance costs | total of finance cost accounts | names matching interest, finance, bank charges |
| + Loss (gain) on disposal | disposal accounts in expenses minus those in other income | names matching disposal |
| = Operating cash flow before working capital | profit before tax + the three adjustments | |
| (Increase) decrease in inventories | minus the net movement of inventory accounts | assets matching inventor, stock |
| (Increase) decrease in trade and other receivables | minus the net movement of receivable accounts | assets matching receivable, debtor (customers, advances to vendors, Input VAT) |
| Increase (decrease) in trade and other payables | the increase in payable accounts (minus their net movement) | liabilities matching payable, creditor (vendors, customer advances, Output VAT) |
| Other current assets, other current liabilities | minus the net movement of the rest | cheques in hand, cheques issued, credit cards, others |
| = Cash generated from operations | before working capital + working capital changes | |
| Interest paid | minus finance costs, plus the increase in interest payable | liabilities matching interest |
| Income tax paid | minus the tax expense, plus the increase in tax payable | liabilities matching income tax, corporate tax |
| = Net cash from operating activities | cash generated + interest paid + tax paid | |
| Investing: net (purchase) or disposal of non-current assets | minus the net movement of non-current assets, minus depreciation, minus the disposal loss | assets in non-current groups (depreciation is not a payment) |
| Financing: borrowings | the increase in borrowings (minus their net movement) | non-current liabilities, or names matching loan, borrowing, debenture, finance lease, mortgage |
| Financing: capital introduced (drawings) | the increase in equity accounts (minus their net movement) | all equity accounts |
| Other movements | minus the net movement of anything left | cash in an account that has been switched off |
| = Net increase in cash | operating + investing + financing + other | |
| Opening cash, closing cash | opening = cash and bank before from; closing = opening + net increase | active cash and bank accounts |

| **Rule.** The statement reconciles by construction: the closing cash it computes must equal the cash and bank ledger balance (closingPerLedger), and the report shows the difference. A one-sided entry that no voucher could post makes the difference non-zero instead of being hidden. |
|---|

### 4.22.6 Notes

| Notes to the financial statements | Notes to the financial statements |
|---|---|
| Question it answers | Policies and the note tables that explain the main balances. |
| Where | Screen: IFRS statements > Notes. API: GET /api/v1/ifrs/notes?asAt=&compare=. |
| Source data | The ledger, the ageing report, the company profile (legal name, TRN). |
| Period and filters | asAt, compare. |
| Calculation | • Policies: reporting entity, basis of preparation (IFRS, historical cost, AED), inventories (weighted average cost), revenue (IFRS 15, net of VAT, discounts and returns), VAT, current and non-current classification. • Trade and other receivables: customer accounts (names starting 'Customer - ') and other receivables (advances to vendors), with an ageing taken from the open invoices; notSetAgainstInvoices = ledger total - ageing total. • Inventories: accounts in the group behind inventory-asset-group. Cash and cash equivalents: each cash and bank account. Trade and other payables: vendor accounts ('Vendor - ') and others, with ageing. VAT: output VAT payable, input VAT recoverable and the net. |
| Included and excluded | A disclaimer states that these are basic notes, not a complete set of IFRS disclosures, and should be reviewed with the accountant. |
| Controls and reconciliations | Each note total equals the line of the statement of financial position. |
| Output columns and exports | API: policies[], tables{tradeReceivables, inventory, cash, tradePayables, vat}, disclaimer. |
