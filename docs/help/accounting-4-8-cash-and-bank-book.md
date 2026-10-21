---
title: "Cash and bank book"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.8
---

# Cash and bank book

| Cash and bank book | Cash and bank book |
|---|---|
| Question it answers | For each cash and bank account: opening balance, money in, money out and closing balance. |
| Where | Screen: Ledger reports > Cash and bank. API: GET /api/v1/accounting/reports/cash-book?from=&to=&kind=cash\ | bank. |
| Source data | Ledger entries not marked reversed on the active accounts in the cash and bank group families. |
| Period and filters | from, to Dubai days; kind restricts to cash or bank. |
| Calculation | • opening = sum of (debit - credit) before from; receipts = debits in the period; payments = credits in the period; closing = opening + receipts - payments. • An account is 'cash' if its group is in the family of cash-account-group, otherwise 'bank'. Totals for cash, bank and all. |
| Included and excluded | Gross movements: a contra deposit shows as money in on the bank account and money out on the cash account (the cash flow report nets it). A cheque shows on its bank account only when it clears. |
| Controls and reconciliations | • Total closing equals the cash flow closing and the trial-balance balances of the same accounts. |
| Output columns and exports | API: rows[{accountCode, accountName, kind, opening, receipts, payments, closing}], totals{cash, bank, all}. Screen with CSV. |
