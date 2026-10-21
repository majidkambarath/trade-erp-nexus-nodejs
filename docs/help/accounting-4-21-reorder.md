---
title: "Reorder"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.21
---

# Reorder

| Reorder | Reorder |
|---|---|
| Question it answers | Which active items are at or below their reorder level? |
| Where | Screen: Stock reports > Reorder. API: GET /api/v1/stock-reports/reorder?categoryId=&search=. |
| Source data | The item master (quantity on hand, reorder level, purchase price, vendor). The master quantity is used because it is what sales check against. |
| Period and filters | No date. |
| Calculation | • Listed if the item is Active, its reorder level is above zero and currentStock <= reorderLevel. shortfall = reorderLevel - currentStock; shortfallValue = shortfall x the item's purchase price (its average cost). • status: 'out' if quantity <= 0; 'below' if under the level; 'at' if equal. Sorted by quantity / level, lowest first. |
| Included and excluded | A reorder level of 0 means the item is not managed and is never listed. |
| Controls and reconciliations | The number of listed items (out, below and at level) is the low-stock figure on the dashboard. |
| Output columns and exports | API: rows[{itemName, qty, reorderLevel, shortfall, avgCost, shortfallValue, status, vendorName}], totals. Screen with CSV. |
