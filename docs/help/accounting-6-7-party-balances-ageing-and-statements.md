---
title: "Party balances, ageing and statements"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 6.7
---

# Party balances, ageing and statements

Table 63. Party balances as on 30 September (test values: 110, 500, 390, 22, ok; 750)

| Party | Accounts | Balance | Limit | Available | Used | Status | Overdue |
|---|---|---|---|---|---|---|---|
| Al Noor (customer) | Customer 210.00 less Customer Advance 100.00 | 110.00 Dr | 500.00 | 390.00 | 22 percent | ok | 0.00 |
| Gulf Mills (vendor) | Vendor 1,050.00 less Advance to Vendor 300.00 | 750.00 Cr | none | | | | 0.00 |

**Ageing at 30 September**, with 30-day terms: sales invoice SO-2026-0001 of 210.00 dated 8 September is due 8 October, so it is 'not yet due' (210.00). Purchase invoice PO-2026-0001 of 1,050.00 dated 3 September is due 3 October, also 'not yet due'. Overdue is 0.00 on both sides.

**Ageing against the ledger.** The receivables ageing totals 210.00 but Al Noor's party balance is 110.00: the 100.00 receipt was kept on account, not set against the invoice. The payables ageing totals 1,050.00 against a party balance of 750.00 for the same reason (the 300.00 payment). These differences are exactly the advances.

**Statement of account, Al Noor.** SO-2026-0001 debit 210.00 (balance 210.00 Dr), RV-2026-0001 credit 100.00 (balance 110.00 Dr). Opening 0.00, closing 110.00, which equals the party balance.

**Statement of account, Gulf Mills.** PO-2026-0001 credit 1,050.00. Closing 1,050.00. The statement does not read the vendor's advance account, so it does not show the 300.00 payment, while the party balance of 750.00 does (section 4.11).
