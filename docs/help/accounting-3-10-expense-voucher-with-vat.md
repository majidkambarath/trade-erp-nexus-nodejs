---
title: "Expense voucher with VAT"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.10
screens: ["/expense-voucher"]
questions:
  - "how does an expense with VAT post"
  - "input VAT on an expense"
---

# Expense voucher with VAT

| Expense voucher (ledger-based) | Expense voucher (ledger-based) |
|---|---|
| Trigger and preconditions | Saving an expense voucher with ledgerBased true (all current screens). The expense account must be an active posting account of type expense (NOT_AN_EXPENSE_ACCOUNT); the amount is above zero and is **before VAT**; a description is required. VAT = round(amount x rate / 100), the rate being that of the tax code on the voucher date; no code, no VAT. |
| Keys used, payment | vat-purchase (only if VAT > 0) and the payment mode's keys. Any mode: cash, bank, transfer, cheque, card; a cheque waits in the cheques-issued account like any other. |
| Number, reversal | EV-YYYY-NNNN. Deleting reverses the entries and withdraws a pending cheque. |

Table 32. Office rent AED 200.00 plus 5% VAT, paid in cash

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Rent Expense | chosen account | 200.00 | |
| Input VAT | vat-purchase | 10.00 | |
| Cash in Hand | cash-account-group | | 210.00 |
| Total | | 210.00 | 210.00 |

The expense appears in box 9 of the VAT return as 200.00 with VAT 10.00 (section 4.13). A vendor can be named on the voucher for reference; no payable is created.

| **Note.** Older expense, journal and contra vouchers posted to the 'Transactor' account list instead of the chart. The screens no longer create them, but the API still routes a request without ledgerBased (or a journal without lines) to that older path (section 7.3). |
|---|
