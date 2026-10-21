---
title: "Slow-moving stock"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.20
---

# Slow-moving stock

| Slow-moving stock | Slow-moving stock |
|---|---|
| Question it answers | Which items have stock on hand but have not sold for a number of days? |
| Where | Screen: Stock reports > Slow stock. API: GET /api/v1/stock-reports/slow-moving?days=&categoryId=&search=. |
| Source data | The same positions as the valuation (as at now), and each item's last sale and first receipt. |
| Period and filters | days (default 90, 1 to 3,650). |
| Calculation | • Listed if quantity > 0 and the reference date is more than days days ago. Reference date = the last SALES_DISPATCH movement; if never sold, the first incoming movement (stock that arrived yesterday is not called dead). • daysSince = floor((now - reference) / one day); neverSold flags items with no sale. Sorted by value, largest first; pctOfStockValue = listed value / total stock value x 100. |
| Included and excluded | Only items with positive quantity; reversed movements are ignored. |
| Controls and reconciliations | Quantity and value are the valuation's own, so the totals are consistent with it. |
| Output columns and exports | API: rows[{itemName, qty, avgCost, value, lastSaleDate, neverSold, daysSince}], totals. Screen with CSV. |
