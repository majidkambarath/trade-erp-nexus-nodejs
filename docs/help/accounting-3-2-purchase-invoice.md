---
title: "Purchase invoice"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.2
screens: ["/purchase-order"]
questions:
  - "what does a purchase invoice post"
  - "purchase accounting entries"
---

# Purchase invoice

| Purchase invoice (document type purchase_order) | Purchase invoice (document type purchase_order) |
|---|---|
| Trigger and preconditions | Approval of a purchase invoice. Open fiscal period; the vendor exists; posting on; every key that carries an amount is mapped. |
| Keys used | inventory-asset, vat-purchase, freight-purchase (if header charges), discount-purchase (if a header discount), round-off-purchase (if a round-off); the vendor's party account. |
| Stock effect | • Each line is received at its VAT-exclusive value after line discount (line total - line VAT); the weighted average is recalculated. • Header charges and the header discount are **not** spread into stock cost: freight is an expense, the discount is income. |
| Number, reversal | PO-YYYY-NNNN, allocated when the draft is saved. Deleting the approved invoice reverses stock, batches, ledger entries and the vendor balance. |

Table 18. Purchase invoice, example A: 100 bags at AED 10.00 with 5% VAT

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Inventory Stock | inventory-asset | 1,000.00 | |
| Input VAT | vat-purchase | 50.00 | |
| Vendor - Gulf Mills | party account | | 1,050.00 |
| Total | | 1,050.00 | 1,050.00 |

Stock after approval: 100 bags, cost value 1,000.00, average 10.00. A second purchase of 50 bags at 12.00 would bring it to 150 bags, 1,600.00, average 10.66667.

Table 19. Purchase invoice, example B: 10 x 100.00, 10% line discount, freight 40.00, header discount 15.00

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Inventory Stock | inventory-asset | 900.00 | |
| Freight on Purchases | freight-purchase | 40.00 | |
| Input VAT | vat-purchase | 47.00 | |
| Purchase Discounts Received | discount-purchase | | 15.00 |
| Vendor - Gulf Mills | party account | | 972.00 |
| Total | | 987.00 | 987.00 |

Check: stock 900.00 is the lines after the 100.00 discount; VAT 47.00 is 45.00 on the lines plus 2.00 on the freight; the vendor is owed 900.00 + 40.00 + 47.00 - 15.00 = 972.00.

Table 20. Round-off: a total typed 0.30 above the computed lines (purchase) and 0.50 below (sale)

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Purchase, total 1,050.30 against lines of 1,050.00 | Inventory Stock | inventory-asset | 1,000.00 | |
| | Input VAT | vat-purchase | 50.00 | |
| | Round-off Expense (Purchases) | round-off-purchase | 0.30 | |
| | Vendor - Gulf Mills | party account | | 1,050.30 |
| Sale, total 209.50 against lines of 210.00 | Customer - Al Noor | party account | 209.50 | |
| | Round-off Expense (Sales) | round-off-sales | 0.50 | |
| | Cost of Goods Sold | cogs | 100.00 | |
| | Sales Revenue | sales-revenue | | 200.00 |
| | Output VAT | vat-sales | | 10.00 |
| | Inventory Stock | inventory-asset | | 100.00 |

| **Note.** A round-off is kept only if the client's total differs from the computed total by AED 1.00 or less. A larger difference is treated as a client error and the computed total is used. |
|---|
