---
title: "Purchase return"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.3
---

# Purchase return

| Purchase return (document type purchase_return) | Purchase return (document type purchase_return) |
|---|---|
| Trigger and preconditions | Approval of a purchase return, with the conditions of a purchase invoice. If linked to an original: an approved purchase invoice of the same vendor; each line returns no more than the original quantity less earlier returns and no more than the value invoiced (OVER_RETURN, OVER_RETURN_VALUE); the return window and the 'link required' setting apply. An opening invoice cannot be returned. |
| Keys used | The purchase keys, in the opposite direction. |
| Stock effect | Stock leaves at the return line's VAT-exclusive value (the documented cost), from the batches of the original purchase when linked. |
| Number, reversal | PR-YYYY-NNNN. Reversed like any approved document; deleting a return frees its quantity. |

Table 21. Purchase return: 20 bags at AED 10.00 with 5% VAT

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Vendor - Gulf Mills | party account | 210.00 | |
| Inventory Stock | inventory-asset | | 200.00 |
| Input VAT | vat-purchase | | 10.00 |
| Total | | 210.00 | 210.00 |

| **Note.** A return does not reduce the outstanding amount of the invoice it returns. The credit stands on the vendor's account until a payment or a debit note is set against the invoice, so the ageing report, which reads invoices, does not net returns (section 4.10). |
|---|
