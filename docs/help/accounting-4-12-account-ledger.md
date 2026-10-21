---
title: "Account ledger"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.12
---

# Account ledger

| Account ledger | Account ledger |
|---|---|
| Question it answers | Every entry on one account, with a running balance. |
| Where | Screen: Ledger (/ledger), and the pop-up opened from any account in a report. API: GET /api/v1/accounting/accounts/:id/ledger?from=&to=. |
| Source data | Ledger entries of the account not marked reversed, sorted by date, creation time, id. |
| Period and filters | from, to optional, read as sent (section 7). |
| Calculation | • opening = naturalBalance(category, debits before from, credits before from); openingNet = the same as debit - credit. • Per entry: balance = running natural balance; net = running (debit - credit), so a screen can print Dr or Cr. closing, closingNet after the last entry; totals = sums of debit and credit of the rows. |
| Included and excluded | Reversed entries are omitted, so an edited voucher shows only its live entries. |
| Controls and reconciliations | The closing equals the account's trial-balance balance and the chart's balance for the same end date. |
| Output columns and exports | API: account, opening, openingNet, rows, closing, closingNet, totals. Screen with Dr/Cr balance. |
