---
title: "Trial balance, 1 to 30 September"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 6.2
---

# Trial balance, 1 to 30 September

Table 57. Trial balance (opening is zero because September is the first month)

| Code | Account | Opening | Debit | Credit | Closing Dr | Closing Cr |
|---|---|---|---|---|---|---|
| AP0001 | Vendor - Gulf Mills | - | - | 1,050.00 | - | 1,050.00 |
| AP0002 | Customer Advance - Al Noor | - | - | 100.00 | - | 100.00 |
| AR0001 | Customer - Al Noor | - | 210.00 | - | 210.00 | - |
| AR0002 | Advance to Vendor - Gulf Mills | - | 300.00 | - | 300.00 | - |
| BANK0002 | ENBD Current | - | 1,000.00 | - | 1,000.00 | - |
| CASH0001 | Cash in Hand | - | 5,100.00 | 1,510.00 | 3,590.00 | - |
| COGS0001 | Cost of Goods Sold | - | 100.00 | - | 100.00 | - |
| EQ0003 | Opening Balance Equity | - | - | 5,000.00 | - | 5,000.00 |
| INV0001 | Inventory Stock | - | 1,000.00 | 100.00 | 900.00 | - |
| OPEX0006 | Rent Expense | - | 200.00 | - | 200.00 | - |
| SAL0001 | Sales Revenue | - | - | 200.00 | - | 200.00 |
| TAXA0001 | Input VAT | - | 60.00 | - | 60.00 | - |
| TAXL0001 | Output VAT | - | - | 10.00 | - | 10.00 |
| | Total | | 7,970.00 | 7,970.00 | 6,360.00 | 6,360.00 |

Debits equal credits (7,970.00 in the period, 6,360.00 in the closing positions), so the 'In balance' flag is set. Test cross-check: Cash in Hand closes at 3,590.00 (5,000 + 100 - 300 - 210 - 1,000) and ENBD Current at 1,000.00.
