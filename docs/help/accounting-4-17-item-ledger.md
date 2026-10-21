---
title: "Item ledger"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.17
---

# Item ledger

| Item stock ledger | Item stock ledger |
|---|---|
| Question it answers | Every movement of one item with a running quantity and value. |
| Where | Screen: Stock reports > Item ledger. API: GET /api/v1/stock-reports/item-ledger?itemId=&from=&to=. |
| Source data | Live inventory movements of the item, the documents behind them (party, batches), the item master. |
| Period and filters | itemId is the item's id or code. from, to as above (no default from: the whole history). |
| Calculation | • Opening = implicit opening + the signed effect of movements before from. • Per row: date, document number, type (Purchase, Sale, Sales return, Purchase return, Write-off, Opening stock, Stock adjustment...), party, batch, qtyIn or qtyOut, unitCost (the movement's unit cost, else \ | value\ | / \ | quantity\ | ), valueIn or valueOut, and the running balanceQty and balanceValue. Closing average = value / qty if qty > 0, else the last rate. |
| Included and excluded | At most 5,000 rows (truncated says if more exist). Reversed movements and their reversal rows are left out. |
| Controls and reconciliations | Closing quantity and value equal the item's row in the valuation at the end date. |
| Output columns and exports | API: item, opening, rows, totals, closing{qty, value, avgCost}, truncated. Screen with CSV. |
