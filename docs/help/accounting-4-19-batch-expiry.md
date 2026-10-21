---
title: "Batch expiry"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.19
---

# Batch expiry

| Batch expiry | Batch expiry |
|---|---|
| Question it answers | Which batches with stock on hand expire within a number of days, or have already expired? |
| Where | Screen: Stock reports > Expiry. API: GET /api/v1/stock-reports/expiry?withinDays=&categoryId=&search=. |
| Source data | Stock batches (one per receipt) and the item master. |
| Period and filters | withinDays (default 30, 0 to 3,650). A batch is listed if it is active, has quantity on hand above zero and an expiry date on or before now + withinDays. |
| Calculation | • Order: earliest expiry, then earliest receipt (first-expiry-first-out); fefoRank is the position within the item. daysToExpiry = ceiling((expiry - now) / one day); expired when the expiry is earlier than now. • valueAtCost = qtyOnHand x the item's **current average cost**: batches are not cost layers, and a write-off leaves stock at the average, so this is what writing the batch off would cost. The receipt cost is shown for information. Totals are split into expired and expiring. |
| Included and excluded | Batches with no expiry date are never listed. Stock on hand is always today's; it cannot be wound back. |
| Controls and reconciliations | Batch quantities are kept apart from the item quantity; stock that arrived before batches existed has no batch and is not listed. |
| Output columns and exports | API: rows[{batchNumber, itemName, qtyOnHand, expiryDate, daysToExpiry, expired, fefoRank, unitCost, receiptCost, valueAtCost}], totals. Screen with CSV. |
