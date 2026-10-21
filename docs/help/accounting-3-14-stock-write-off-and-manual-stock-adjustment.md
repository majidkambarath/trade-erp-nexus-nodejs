---
title: "Stock write-off and manual stock adjustment"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.14
screens: ["/stock"]
questions:
  - "how does a stock write-off post"
  - "manual stock adjustment accounting"
---

# Stock write-off and manual stock adjustment

| Stock write-off (WriteOffService) | Stock write-off (WriteOffService) |
|---|---|
| Trigger and preconditions | Writing off part or all of a batch from the batch list, for expiry or damage (roles super admin, admin, manager). Open fiscal period for today; the quantity does not exceed the batch quantity (EXCEEDS_BATCH_QTY). The write-off is dated the moment it is made and cannot be back-dated. |
| Stock effect | The stock leaves at quantity x the item's current average cost (the 'sale' basis of the cost engine), so the average does not change. An inventory movement of type DAMAGED_STOCK is written for both reasons. The batch quantity falls; at zero the batch becomes 'written_off'. |
| Posting | Only if posting is on and the cost is above zero: Dr write-off-expiry or damage-loss, Cr inventory-asset, voucher type stock_writeoff. Number WO-YYYY-NNNN. |
| If reversed | There is no reversal action. A mistaken write-off is corrected by a journal and a stock entry. Input VAT claimed on the purchase is not reversed. |

Table 37. Write-off of 15 units of expired oil at an average of 20.66667 = AED 310.00

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Stock Write-off - Expiry | write-off-expiry | 310.00 | |
| Inventory Stock | inventory-asset | | 310.00 |
| Total | | 310.00 | 310.00 |

### 3.14.1 Manual stock adjustment and initial stock

| Manual stock adjustment (StockAdjustmentService) | Manual stock adjustment (StockAdjustmentService) |
|---|---|
| Trigger and preconditions | A change of an item's quantity that is not a trade document: editing the quantity on the item (PUT /stock/stock/:id with currentStock, or PATCH /stock/stock/:id/quantity) or typing a movement on the Inventory page (POST /inventory/inventory, a signed quantity). The new quantity cannot be negative. The fiscal period of today must be open; this is checked whether or not posting is on. A request that leaves the quantity as it is records nothing. |
| Stock effect | A **decrease** leaves at the item's average cost (the 'sale' basis of the cost engine), so the average does not change, and takes the batches first-expiry-first-out. An **increase** enters at the unit cost sent with the request (unitCost on the Inventory page, purchasePrice on the item edit), else at the current average, so the average is unchanged; a different cost re-averages the pool; a batch number creates a batch of the added quantity. Quantity, cost value and average cost change together. One inventory movement is written (event type STOCK_ADJUSTMENT, or the type chosen on the Inventory page; cost basis 'adjustment') with the rate before and after. The number is SA-YYYY-NNNN; the movement's reference is the one typed, else that number. |
| Posting | Only if posting is on and the cost is above zero. Gain: Dr inventory-asset, Cr stock-adjustment. Loss: Dr stock-adjustment, Cr inventory-asset. Amount = the cost of the units added or removed. Voucher type stock_adjustment, voucher number the SA number, dated the moment it is made; the narration names the item, the sign and the quantity. On the default chart the account sits in Cost of Goods Sold, so a loss raises direct costs and a gain lowers them. |
| If reversed or missed | There is no reversal action: correct a mistake with an opposite adjustment. With posting off the quantity, cost pool, batches and movement still change, and the number is used, but nothing reaches the ledger and the later catch-up does not add it (section 2.5). |

Table 38. Manual adjustments of one item

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Count finds 10 units, entered at 12.00: gain of 120.00 | Inventory Stock | inventory-asset | 120.00 | |
| | Stock Adjustment | stock-adjustment | | 120.00 |
| Quantity corrected from 10 to 6: loss of 4 units at the average 12.00 = 48.00 | Stock Adjustment | stock-adjustment | 48.00 | |
| | Inventory Stock | inventory-asset | | 48.00 |

After both events Inventory is debited 72.00 net, which is 6 units at 12.00, and Stock Adjustment is credited 72.00 net. A later gain of 4 units at 14.00 on top of 8 units at 12.00 re-averages the pool to 152.00 over 12 units (12.66667). The test also shows that an edit which leaves the quantity alone writes no movement and no entry, and that a closed period refuses the adjustment and leaves the stock untouched.

**Initial stock.** Creating an item with a quantity (POST /stock/stock with currentStock) writes an INITIAL_STOCK movement at the purchase price entered. Its reference is INIT-<item code>; it takes no number from a series, does not set the cost value and is not posted to the ledger. Opening stock for a company going live belongs in Opening balances (next section), which is posted.

| **Rule.** Manual adjustments post when ledger posting is on. **Not posted:** the quantity entered when an item is created, and any adjustment made while posting was off. The stock valuation (section 4.15) shows both as a difference against the Inventory account. |
|---|
