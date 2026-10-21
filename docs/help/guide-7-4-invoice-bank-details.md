---
title: "Invoice bank details"
audience: client
source: Trade-ERP-Product-Guide 7.4
---

# Invoice bank details

The bank details printed on invoices.

| Field | Rule |
|---|---|
| Bank name, account holder, account number | Free text with length limits (100, 100, 50). |
| IBAN | Spaces removed and letters upper-cased. Checked for format and the mod-97 checksum. A UAE IBAN must have 23 characters. |
| SWIFT or BIC | 8 or 11 characters, in the standard format, upper-cased. |
| Account currency | AED, USD, EUR, GBP, SAR or INR. The screen defaults to AED. |

These details print on invoices. The bank accounts the company actually uses are kept in Accounts, Banks and the chart of accounts; this tab only decides what appears on paper.
