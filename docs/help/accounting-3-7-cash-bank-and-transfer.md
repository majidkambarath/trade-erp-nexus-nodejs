---
title: "Cash, bank and transfer"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.7
---

# Cash, bank and transfer

Table 26. Cash, bank and transfer (PaymentModeService.resolve)

| Mode | Account used | Required details | Money-side entry | Stored as |
|---|---|---|---|---|
| Cash | Chosen from the cash group family; if none is chosen, the first cash account by code. | None. | Receipt: Dr the cash account. Payment: Cr it. | cash |
| Bank | Chosen from the bank group family. With more than one bank account the user must choose (BANK_ACCOUNT_REQUIRED). | Slip reference optional. | Receipt: Dr the bank account. Payment: Cr it. | bank |
| Transfer | As bank. | The transfer reference (REFERENCE_REQUIRED) and optionally its date, which defaults to the voucher date. | As bank. | transfer |

The old mode name 'online' is accepted and stored as 'transfer'. The account must be active, accept direct posting and belong to the right group family, otherwise NOT_A_CASH_ACCOUNT or NOT_A_BANK_ACCOUNT.

A cash payment is not blocked by the cash balance. Only a contra voucher refuses to take cash below zero (section 3.13).
