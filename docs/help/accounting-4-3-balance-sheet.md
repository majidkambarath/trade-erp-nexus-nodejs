---
title: "Balance sheet"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.3
screens: ["/financial-statements"]
questions:
  - "balance sheet"
  - "why does my balance sheet not balance"
---

# Balance sheet

| Balance sheet | Balance sheet |
|---|---|
| Question it answers | What did the company own and owe at the end of the day, and does it balance? |
| Where | Screen: Financial statements > Balance sheet (/financial-statements). API: GET /api/v1/vouchers/reports/financial?reportType=balance_sheet&dateTo= (FinancialService.getBalanceSheet). |
| Source data | The trial balance with no start date: all entries not marked reversed up to dateTo. |
| Period and filters | dateTo only. The screen sends the chosen day with the time 23:59:59.999 (read as sent, section 7). |
| Calculation | • balance per account = naturalBalance(category, total debit up to dateTo, total credit up to dateTo). Accounts with \ | balance\ | < 0.005 are left out. • Assets = sum of ASSET balances. Liabilities = sum of LIABILITY balances. • profitToDate = sum of INCOME balances - sum of EXPENSE balances, from the first entry to dateTo. • Total equity = sum of EQUITY balances + profitToDate. • isBalanced = \ | Assets - (Liabilities + Total equity)\ | < 0.01. |
| Included and excluded | • No year-end closing entries exist, so profit is not moved to retained earnings. The profit earned to the date is shown inside equity, which makes the sheet balance without closing entries. • An account whose balance is on the opposite side of its category (an asset in credit) is shown as a negative on its own side. Nothing is reclassified. • There is no current or non-current split here; the IFRS statement of financial position makes it (section 4.22). |
| Controls and reconciliations | • isBalanced must be true. • Total assets equal the IFRS statement of financial position at the same date. • profitToDate equals the cumulative net profit of the profit and loss. |
| Output columns and exports | API: assets[], liabilities[], equity[], profitToDate, totalAssets, totalLiabilities, totalEquity, totalLiabilitiesAndEquity, isBalanced. Screen only; no export. |
