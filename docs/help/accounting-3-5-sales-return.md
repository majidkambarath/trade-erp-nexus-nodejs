---
title: "Sales return"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.5
---

# Sales return

| Sales return (document type sales_return) | Sales return (document type sales_return) |
|---|---|
| Trigger and preconditions | Approval of a sales return; as a sales invoice, without credit control (a return reduces exposure, so it is never blocked). A linked return follows the same quantity and value caps as a purchase return. |
| Keys used | The sales keys, in the opposite direction. |
| Stock effect | • A linked return restores stock at **the cost the goods were sold at**, never at the selling price or today's average, and goes back into the batches the goods came from. • An unlinked return restores at the current average. |
| Number, reversal | SR-YYYY-NNNN. Reversed like any approved document. |

Table 24. Sales return: 2 bags at AED 20.00 with 5% VAT, sold at a cost of 10.00 a bag

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Sales Revenue | sales-revenue | 40.00 | |
| Output VAT | vat-sales | 2.00 | |
| Inventory Stock | inventory-asset | 20.00 | |
| Customer - Al Noor | party account | | 42.00 |
| Cost of Goods Sold | cogs | | 20.00 |
| Total | | 62.00 | 62.00 |

Test evidence: a sale at cost 10.00, then a purchase that moves the average above 10.00, then a linked return of the whole sale: the stock comes back at the original cost.
