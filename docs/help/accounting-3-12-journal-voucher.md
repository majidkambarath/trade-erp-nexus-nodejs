---
title: "Journal voucher"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.12
---

# Journal voucher

A journal has any number of lines. At least two; each line is a debit or a credit, not both and not neither; no negative amounts; a blank spare row is ignored. Debits and credits must be equal to within 0.005 (UNBALANCED). Each account must exist, be active and accept direct posting. It uses no configuration key: the user chooses every account. Number JV-YYYY-NNNN. Deleting reverses the entries and marks the voucher cancelled.

Table 35. Month-end accrual of AED 1,000.00

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Rent Expense | chosen account | 700.00 | |
| Utilities | chosen account | 300.00 | |
| Cash in Hand | chosen account | | 1,000.00 |
| Total | | 1,000.00 | 1,000.00 |
