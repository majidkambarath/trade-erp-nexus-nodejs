---
title: "General ledger summary"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.5
screens: ["/ledger-reports"]
questions:
  - "general ledger"
  - "account register"
  - "how do I see every entry on an account"
---

# General ledger summary

| General ledger summary | General ledger summary |
|---|---|
| Question it answers | For every account: what was the opening balance, what moved, and what is the closing balance? |
| Where | Screen: Ledger reports > General ledger (/ledger-reports). API: GET /api/v1/accounting/reports/general-ledger?from=&to=&category=&includeZero=. |
| Source data | Ledger entries not marked reversed, grouped by account, then filed by account group. |
| Period and filters | from, to Dubai days; category (ASSET, LIABILITY, EQUITY, INCOME, EXPENSE) narrows the rows; includeZero keeps accounts with nothing to show. |
| Calculation | • opening = sum of (debit - credit) before from. debit and credit = period sums. closing = opening + debit - credit. All in the signed form net = debit - credit. • Group totals and grand totals are sums of the rounded account figures. |
| Included and excluded | • Accounts with opening, debit, credit and closing all zero are left out unless includeZero. • Groups are sorted by category order (assets, liabilities, equity, income, expenses), then name; accounts by code. |
| Controls and reconciliations | • Grand totals: debit equals credit; opening sums to zero; closing sums to zero. Each account's closing equals its trial-balance net. • A later period shows the earlier period's closing as its opening. |
| Output columns and exports | API: groups[{name, category, accounts[{code, name, opening, debit, credit, closing}], totals}], totals. Screen with CSV. |
