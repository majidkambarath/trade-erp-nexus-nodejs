---
title: "Stock costing and control"
audience: client
source: Trade-ERP-Product-Guide 4.7
screens: ["/stock-reports", "/batches"]
questions:
  - "how is cost calculated"
  - "what is weighted average cost"
  - "why is my stock value wrong"
  - "what is FEFO"
---

# Stock costing and control

Stock is valued at weighted average cost, so the cost of goods sold and the value of stock on hand stay consistent. This flow explains how cost moves, how expiry is controlled with batches and write-offs, and where the books and the stock can part company.

| Receive at cost | → | Average updated | → | Issue at average | → | Write off expired | → | Reconcile to ledger |
|---|---|---|---|---|---|---|---|---|

| Who | Inventory Manager and Accountant. A write-off needs the super_admin, admin or manager server role. |
|---|---|
| Screens | Inventory: Stock Items, Movements, Batches. Reports: Stock (Valuation, Movement, Item ledger, Expiry, Slow stock, Reorder). |
| Status | Available |

### Steps

1. Receive stock by approving purchase orders. Each line adds its VAT-exclusive cost to the item's pool, and the average becomes total cost divided by quantity.

2. Sell stock by approving sales orders. Each line takes quantity times the current average as cost of goods sold. The average does not change.

3. Watch expiry on Inventory, Batches (all, expired, within 7, 30 or 90 days) and Reports, Stock, Expiry.

4. Write off expired or damaged stock: on Batches choose Write off, enter the quantity, the reason (Expired, or Damaged or lost) and a note.

5. Compare stock with the books on Reports, Stock, Valuation.

### What the system checks

Weighted average. A purchase recalculates it. A purchase return removes the documented purchase cost. A sale takes quantity times the average and never changes it. A sales return restores stock at the original sale's cost, or the current average if there is no link. When stock reaches zero the last average is kept.

Audit row. Each movement stores the average before and after, the cost pool after and, for a sale, the cost of goods sold. Reversing a document adds a paired reversal movement.

Back-dated documents. A document approved with an earlier date than other movements of the item triggers a recalculation in date order, and the cost of goods sold already posted is adjusted. Movements in a closed fiscal year keep their stamped cost.

Write-off. The quantity cannot exceed the batch; the stock leaves at the average cost; the fiscal year must be open; the document is numbered WO-2026-0001 and written to the audit log. It cannot be undone.

One cost pool per item: there is no location. Reversing a purchase is refused if part of its batch was sold or returned.

| Rule. A sale never changes the average cost. The selling price takes no part in costing. |
|---|

### Manual stock adjustments

Changing an item's quantity by hand (the Edit form on Stock Items, or Record Movement on Movements) is a costed stock event, like a purchase or a sale:

Decrease. The stock leaves at the item's weighted average cost, and the batches are taken first-expiry-first-out. A shortfall in batches is tolerated, because older stock may carry no batch.

Increase. The stock enters at the cost typed on the form, otherwise at the current average (so the average does not change). If a batch number is given, a batch is created.

One movement is written for each entry (Record Movement used to write two), with the average before and after. The entry is numbered from the series SA, for example SA-2026-0001.

Ledger. With ledger posting on, a gain debits Inventory and credits Stock adjustment; a loss does the reverse.

Period lock. The adjustment is refused in a closed fiscal year, or on a date no fiscal year covers.

Two cases are still not posted: a quantity typed on a brand-new item (it writes an Initial stock movement only, with no cost value, batch or posting; use Opening balances for go-live stock), and adjustments made while ledger posting was off.

### Accounting effect

A purchase debits Inventory. A sale debits Cost of goods sold and credits Inventory at the average cost. A write-off, when ledger posting is on, debits Stock written off (expiry, or damage and loss) and credits Inventory. A manual adjustment, when posting is on, debits Inventory and credits Stock adjustment for a gain, and the reverse for a loss. With posting off, the stock still moves and the entry is not booked.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| Stock value does not agree with the Inventory account | Open the Ledger reconciliation block on Valuation. It splits the difference by source. A typical cause is an adjustment made while ledger posting was off, or a quantity typed on a brand-new item. The accountant records the difference with a journal voucher. |
| A manual adjustment or a write-off was wrong | Neither has a reversal screen. Record the opposite adjustment, which posts the opposite entry. A write-off cannot be undone; agree the correction with the accountant. |
| Stock is negative | A sale was approved without enough stock. Enter the missing purchase; later costs are recalculated. |
