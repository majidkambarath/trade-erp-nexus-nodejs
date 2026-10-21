---
title: "Number series and document numbering"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping Appendix B
---

# Number series and document numbering

Numbers are allocated by one routine (NumberSeriesService.allocate) with a single atomic increment per company, branch, series and fiscal year. The format is PREFIX-FY-NNNN, where FY is the code of the fiscal year that covers the document date, or, if no fiscal year is defined for that date, the Dubai calendar year, and NNNN is the counter padded to four digits. A counter restarts at 1 in each fiscal year.

| **Rule.** Numbers are never reused. A save that is rolled back leaves a gap, never a duplicate. A number is allocated when the draft is saved, not when it is approved. The order form sends no number; if a client supplies one it is accepted only if it is unique. |
|---|

Table 74. The 17 series (NumberSeriesService.SERIES)

| Series | Prefix | Document | Allocated when | Example |
|---|---|---|---|---|
| PO | PO | Purchase invoice | Draft saved | PO-2026-0001 |
| SO | SO | Sales invoice | Draft saved | SO-2026-0001 |
| PR | PR | Purchase return | Draft saved | PR-2026-0001 |
| SR | SR | Sales return | Draft saved | SR-2026-0001 |
| RV | RV | Receipt voucher | Voucher saved | RV-2026-0001 |
| PV | PV | Payment voucher | Voucher saved | PV-2026-0001 |
| JV | JV | Journal voucher | Voucher saved | JV-2026-0001 |
| CV | CV | Contra voucher | Voucher saved | CV-2026-0001 |
| EV | EV | Expense voucher | Voucher saved | EV-2026-0001 |
| DN | DN | Debit note | Voucher saved | DN-2026-0001 |
| CN | CN | Credit note | Voucher saved | CN-2026-0001 |
| WO | WO | Stock write-off | Write-off made | WO-2026-0001 |
| SA | SA | Manual stock adjustment | Adjustment made | SA-2026-0001 |
| OBV | OBV | Opening balance voucher (accounts) | Posted | OBV-2026-0001 |
| OSI | OSI | Opening sales invoice | Posted | OSI-2026-0001 |
| OPI | OPI | Opening purchase invoice | Posted | OPI-2026-0001 |
| OST | OST | Opening stock voucher | Posted | OST-2026-0001 |
