---
title: "Sales invoice and the cost of goods"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.4
screens: ["/sales-order"]
questions:
  - "what does a sales invoice post"
  - "how is cost of goods booked"
  - "sales accounting entries"
---

# Sales invoice and the cost of goods

| Sales invoice (document type sales_order) | Sales invoice (document type sales_order) |
|---|---|
| Trigger and preconditions | Approval of a sales invoice. Open fiscal period; the customer exists; credit control passes (section 3.1); posting on; sales-revenue, cogs, inventory-asset mapped, plus vat-sales, discount-sales, freight-sales, round-off-sales when the document has VAT, discount, charges or a round-off. |
| Revenue rule | Revenue is posted **gross** (quantity times price) and the discount is shown separately as an expense, so the discount given is visible in the books. |
| Cost of goods | • Stock leaves at quantity x the current average cost; the selling price never enters the cost. • The cost of goods is not a separate voucher: it is the last two legs of the same posting (Dr cogs, Cr inventory-asset), equal to the sum of the cost each line moved. • Batches are taken first-expiry-first-out; a customer's minimum shelf life skips batches that expire too soon. |
| Number, reversal | SO-YYYY-NNNN. Deleting the approved invoice returns stock to the batches it came from, reverses the ledger entries and restores the customer balance. |

Table 22. Sales invoice, example A: 10 bags at AED 20.00 with 5% VAT, cost 10.00 a bag

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Customer - Al Noor | party account | 210.00 | |
| Cost of Goods Sold | cogs | 100.00 | |
| Sales Revenue | sales-revenue | | 200.00 |
| Output VAT | vat-sales | | 10.00 |
| Inventory Stock | inventory-asset | | 100.00 |
| Total | | 310.00 | 310.00 |

Stock after the sale: 90 bags, cost value 900.00, average still 10.00; a sale never changes the average.

Table 23. Sales invoice, example B: 10 x 100.00, 10% line discount, freight 40.00, header discount 15.00, cost 100.00

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Customer - Al Noor | party account | 972.00 | |
| Sales Discounts Given | discount-sales | 115.00 | |
| Cost of Goods Sold | cogs | 100.00 | |
| Sales Revenue | sales-revenue | | 1,000.00 |
| Freight Recovered | freight-sales | | 40.00 |
| Output VAT | vat-sales | | 47.00 |
| Inventory Stock | inventory-asset | | 100.00 |
| Total | | 1,187.00 | 1,187.00 |

Check: debits 972.00 + 115.00 + 100.00 = 1,187.00 = credits 1,000.00 + 40.00 + 47.00 + 100.00. The discount of 115.00 is the 100.00 line discount plus the 15.00 header discount. After a back-dated purchase, the cost-of-goods legs of a posted sale are moved by the difference without touching its other legs.
