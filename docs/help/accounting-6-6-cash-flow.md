---
title: "Cash flow"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 6.6
---

# Cash flow

Table 61. Cash flow by kind of voucher (test: in 5,100.00, out 510.00, closing 4,590.00, the contra nets to nothing)

| Line | Inflow | Outflow | Net |
|---|---|---|---|
| Received from customers (receipt RV-2026-0001) | 100.00 | | 100.00 |
| Journal entries (JV-2026-0001, capital) | 5,000.00 | | 5,000.00 |
| Paid to vendors (PV-2026-0001) | | 300.00 | -300.00 |
| Expenses paid (EV-2026-0001) | | 210.00 | -210.00 |
| Moved between cash and bank (CV-2026-0001) | - | - | 0.00 |
| Total | 5,100.00 | 510.00 | 4,590.00 |

Opening 0.00 + inflows 5,100.00 - outflows 510.00 = closing 4,590.00, which equals Cash in Hand 3,590.00 + ENBD Current 1,000.00, so the report reconciles.

### 6.6.1 The same cash flow in the IFRS (indirect) form

Table 62. IFRS statement of cash flows, September 2026 (classification as section 4.22: input VAT counts with receivables, output VAT with payables)

| Line | Working | Amount (AED) |
|---|---|---|
| Profit before tax | from the profit or loss statement | -100.00 |
| Adjustments (depreciation, finance costs, disposal) | none | 0.00 |
| (Increase) in inventories | minus 900.00 (Inventory Stock) | -900.00 |
| (Increase) in trade and other receivables | minus (Customer 210.00 + Advance to Vendor 300.00 + Input VAT 60.00) | -570.00 |
| Increase in trade and other payables | Vendor 1,050.00 + Customer Advance 100.00 + Output VAT 10.00 | 1,160.00 |
| Cash generated from operations | -100.00 + 0.00 - 900.00 - 570.00 + 1,160.00 | -410.00 |
| Interest paid, income tax paid | none | 0.00 |
| Net cash from operating activities | | -410.00 |
| Investing activities | none | 0.00 |
| Financing: capital introduced | Opening Balance Equity credit 5,000.00 | 5,000.00 |
| Net increase in cash | -410.00 + 0.00 + 5,000.00 | 4,590.00 |
| Opening cash / closing cash | 0.00 / 0.00 + 4,590.00 | 4,590.00 |

Closing cash 4,590.00 equals the ledger's 4,590.00, so the IFRS statement reconciles with a difference of 0.00.
