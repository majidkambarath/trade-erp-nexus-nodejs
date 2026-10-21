---
title: "B.1 Other identifiers"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping B.1 Other identifiers
---

# B.1 Other identifiers

Table 75. Identifiers outside the number series

| Identifier | Format and rule |
|---|---|
| Ledger account code | Group prefix + four digits from a counter kept on the group (AR0001). The counter never goes below the highest code already in the group. |
| Account opening voucher | OB-<account code> (voucher type 'opening'); not from a series. |
| Cheque clearing | Reuses the voucher number of the receipt or payment; voucher type 'cheque_clearance'. |
| Batch number | The number typed on the line; otherwise <document number>-<line>; an unlinked return uses <document number>-R<line>. |
| Reversal reference (stock) | REV-<document number>; the original movement and the reversal row are both ignored by the stock reports. |
| VAT return | VAT-<from>..<to> (for example VAT-2026-07-01..2026-09-30). It is the key of a saved return. |
| Customer and vendor codes | A separate year-based counter (model Sequence) that reuses the numbers of deleted parties. Trade documents and vouchers deliberately do not use it. |
| Item code | Three letters of the item name and a four-digit random number, generated when the item is created (a typed code is not used). |
