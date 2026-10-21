---
title: "Stock movement"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.16
---

# Stock movement

| Stock movement summary | Stock movement summary |
|---|---|
| Question it answers | For each item: opening, what came in and went out by kind, and closing, in quantity and in value. |
| Where | Screen: Stock reports > Movement. API: GET /api/v1/stock-reports/movement?from=&to=&categoryId=&search=&includeZero=. |
| Source data | As the valuation: live inventory movements, the item master, categories, the Inventory account. |
| Period and filters | from (default the first day of the current month in Dubai) to to (default today). |
| Calculation | • Opening = the position (as above, with the implicit opening) before from. Each kind of movement in the period is summed in quantity and value: purchases, purchase returns, sales, sales returns, write-offs (DAMAGED_STOCK) and adjustments (everything else: INITIAL_STOCK, OPENING_STOCK, STOCK_ADJUSTMENT, TRANSFER_IN, TRANSFER_OUT). • The three outgoing kinds (purchase returns, sales, write-offs) are shown as positive magnitudes. • **closing = opening + purchases + sales returns + adjustments - purchase returns - sales - write-offs**, for quantity and for value, item by item and in total. • adjustments is signed, because opening-stock entries and manual corrections can go either way. |
| Included and excluded | Items with nothing in the period but stock on hand still show opening and closing. Rows that are all zero are hidden unless includeZero. |
| Controls and reconciliations | • The closing value equals the valuation at the end date; the reconciliation block is the same as the valuation's. • The identity above holds for every row and for the totals. |
| Output columns and exports | API: rows[{item, opening, purchases, purchaseReturns, sales, salesReturns, writeOffs, adjustments, closing}] each with {qty, value}, totals, reconciliation. Screen with a quantity/value toggle and CSV. |
