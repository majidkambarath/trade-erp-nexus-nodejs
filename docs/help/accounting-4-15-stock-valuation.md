---
title: "Stock valuation"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.15
---

# Stock valuation

| Stock valuation | Stock valuation |
|---|---|
| Question it answers | How much stock is on hand, at what cost, and does its value agree with the Inventory account? |
| Where | Screen: Stock reports > Valuation (/stock-reports?tab=valuation). API: GET /api/v1/stock-reports/valuation?asOn=&categoryId=&search=&groupBy=item\ | category&includeZero=. |
| Source data | Inventory movements (the stock audit trail), the item master, categories, and the ledger entries on the account behind inventory-asset. |
| Period and filters | asOn is a Dubai day (default today): every live movement dated up to the end of that day counts. categoryId and search narrow the rows only; the reconciliation always covers all items. |
| Calculation | **Live movement.** A movement counts unless it was reversed (isReversed) or is itself a reversal row (reference number starting REV-). The pair cancels, exactly as a reversed ledger entry does. **Why a sum, not the last row.** The position is the **sum** of the signed effect of the live movements, not the 'new stock' of the last movement, because a back-dated document, a reversal or a re-cost makes the last row by date a different row from the last row written. A sum does not depend on order, and gives closing = opening + in - out exactly. • qty = sum of quantity (+ in, - out). • value = sum of sign(quantity) x \ | totalValue\ |. totalValue is the cost that moved with the stock, the same figure posted to the Inventory account. • avgCost = the item's last live rateAfter (five decimals); if there is none, value / qty. Quantity x average cost can differ from value by a fraction of a fils, because value is the exact cost on hand. • sharePct = row value / total value x 100. **Implicit opening.** If the first movement ever written for an item shows a previousStock above zero (the item was created with stock and no opening movement), that quantity, valued at the rate before it, is added to the opening position so totals are not understated. It is never a period movement and, having no ledger posting, appears in the reconciliation. |
| Included and excluded | • Rows with zero quantity and zero value are hidden unless includeZero or the row is out of step. • negative marks a quantity below zero (an oversold item). outOfSync marks an item whose quantity on the item master differs from the movement sum by 0.0005 or more; it is checked only when asOn is today or later, because the master cannot be wound back. • A deleted item keeps its movements; its value stays in the totals under the name '<code> (deleted item)'. |
| Controls and reconciliations | **Reconciliation to the ledger** (always all items): • ledgerBalance = sum of (debit - credit) of live entries on the Inventory account dated up to the end of asOn. • difference = stockValue - ledgerBalance; reconciles = \ | difference\ | < 0.005. • The difference is split by source (table below) and the part no line explains is unexplained. • Typical causes of a difference: the quantity typed when an item is created, or a manual adjustment made while posting was off (neither is posted); an item created with stock (implicit opening); a journal posted straight to the Inventory account; posting switched off for part of the history. |
| Output columns and exports | API: rows[{itemId, sku, itemName, unit, categoryName, qty, avgCost, value, sharePct, negative?, outOfSync?}], totals{items, qty, value, negativeItems, outOfSyncItems}, reconciliation. Screen with CSV. |

Table 47. Source lines of the stock reconciliation (the system)

| Source line | Stock side (movements) | Ledger side (voucher types on the Inventory account) | Expected |
|---|---|---|---|
| Opening stock and manual adjustments | INITIAL_STOCK, OPENING_STOCK, STOCK_ADJUSTMENT, TRANSFER movements | opening_stock, stock_adjustment | Opening stock and posted adjustments agree; initial stock created with an item, and adjustments made while posting was off, show a difference |
| Purchases | PURCHASE_RECEIVE | purchase_order | Agrees |
| Purchase returns | PURCHASE_RETURN | purchase_return | Agrees |
| Cost of goods sold | SALES_DISPATCH | sales_order | Agrees |
| Sales returns | SALES_RETURN | sales_return | Agrees |
| Stock write-offs | DAMAGED_STOCK | stock_writeoff | Agrees |
| Journals and other vouchers | none | all other types (journal, opening,...) | Shown as a ledger-only amount |

The first line's printed note says that opening stock (Opening balances) and manual quantity changes are posted to the ledger, and that a difference on the line is a quantity typed on a new item or a change made while ledger posting was off, to be fixed by a journal to the Inventory account. A posted adjustment is on both sides of the line.
