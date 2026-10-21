---
title: "Contra voucher"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.13
---

# Contra voucher

A contra moves money between cash and bank accounts: a deposit, a withdrawal, a bank-to-bank transfer. Both accounts must be in the cash or bank group family (NOT_CASH_OR_BANK), must differ (SAME_ACCOUNT), and the amount must be above zero. If the account the money leaves is a cash account its current balance must cover the amount (CASH_INSUFFICIENT); a bank account may be overdrawn. Keys: the two group keys, to check the accounts. Number CV-YYYY-NNNN.

Table 36. Deposit of AED 1,000.00 from Cash in Hand to ENBD Current

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| ENBD Current | bank-account-group | 1,000.00 | |
| Cash in Hand | cash-account-group | | 1,000.00 |
| Total | | 1,000.00 | 1,000.00 |

In the cash flow reports a contra nets to nothing, because both legs are on cash or bank accounts (section 4.4); in the cash and bank book it appears as money in on one account and money out on the other.
