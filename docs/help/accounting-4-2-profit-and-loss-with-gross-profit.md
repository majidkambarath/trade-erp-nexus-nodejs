---
title: "Profit and loss (with gross profit)"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.2
screens: ["/financial-statements"]
questions:
  - "how is gross profit calculated"
  - "profit and loss"
  - "why is my profit wrong"
---

# Profit and loss (with gross profit)

| Profit and loss | Profit and loss |
|---|---|
| Question it answers | What did the business earn in the period, and what is the gross profit? |
| Where | Screen: Financial statements > Profit and loss (/financial-statements?tab=pl). API: GET /api/v1/accounting/reports/profit-loss?from=&to= (LedgerReportsService.profitAndLoss). The dashboard and the IFRS profit or loss use the same function. |
| Source data | Ledger entries not marked reversed, summed per account for the period; account groups; the posting map (the four direct-group keys). |
| Period and filters | from and to are Dubai days. Only the movement inside the period is used; there is no opening balance. If from is omitted, everything up to to is the period. |
| Calculation | For each INCOME or EXPENSE account: amount = naturalBalance(category, periodDebit, periodCredit). Accounts with \ | amount\ | < 0.005 are left out. directIncome = the groups under sales-income-group or direct-income-group, each with all its sub-groups. directCost = the groups under purchase-expense-group or direct-expense-group, likewise. An unmapped key adds nothing. • Revenue = sum of amount of INCOME accounts in directIncome. • Direct costs = sum of amount of EXPENSE accounts in directCost. • **Gross profit** = Revenue - Direct costs. **Gross margin %** = Gross profit / Revenue x 100, to two decimals (empty if Revenue is zero). • Other income = INCOME accounts outside directIncome. Operating expenses = EXPENSE accounts outside directCost. • **Net profit** = Gross profit + Other income - Operating expenses. With the default chart: revenue is Sales Revenue; direct costs are Cost of Goods Sold, Purchase Variance, Stock Adjustment and the two stock write-offs; other income is Freight Recovered, Purchase Discounts Received and Other Income; operating expenses are Sales Discounts Given, Freight on Purchases, both round-off accounts, Salaries & Wages, Rent, Utilities, Bank Charges and Card Processing Fees. |
| Included and excluded | • Revenue is **gross of discounts**: the discount given is in operating expenses (Sales Discounts Given), not deducted from revenue. • Credits on an expense account reduce it (for example a round-off posted as a credit). • Cost-of-goods corrections after a back-dated purchase are included, because they are ledger entries. • An account with no group is shown under 'other' or 'operating'. |
| Controls and reconciliations | • Net profit equals the income minus the expenses of the same period in the trial balance, and equals the older statement reportType=profit_loss. • The balance sheet's profit to date equals the sum of the net profit of all periods from the first entry. • The IFRS profit for the period and the dashboard net profit are this figure. |
| Output columns and exports | API: revenue, directCosts, otherIncome, operatingExpenses (each with groups, accounts and a total), grossProfit, grossMargin, netProfit. Screen: a statement (Revenue - Cost of sales = Gross profit... = Net profit) with CSV. The older reportType=profit_loss returns only income, expenses and net profit, without the gross-profit split. |
