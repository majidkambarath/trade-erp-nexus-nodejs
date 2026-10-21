---
title: "Items, categories, units and batches"
audience: client
source: Trade-ERP-Product-Guide 4.3
screens: ["/stock"]
questions:
  - "how do I add an item"
  - "what is a category"
  - "what is a unit of measure"
  - "how do batches work"
  - "how do I add a service"
---

# Items, categories, units and batches

The stock master says what the company sells and buys, how it is grouped, how it is measured and, for perishables, which batches exist and when they expire. Items and units are set up once. Batches arise by themselves when purchases are approved.

| Category | → | Unit | → | Item | → | Purchase approved | → | Batch with expiry |
|---|---|---|---|---|---|---|---|---|

| Who | Inventory Manager, Admin. The server lets any signed-in user do this. |
|---|---|
| Screens | Inventory: Categories, Units, Stock Items (and item detail), Movements, Batches. |
| Status | Available |

### Steps

1. Inventory, Categories: add a category (unique name, description, status).

2. Inventory, Units: add a unit (unique name and short code, Base or Derived, measure category) and, if wanted, conversions between units (ratio at least 0.001).

3. Inventory, Stock Items, Add: item name, SKU, category, unit, origin and brand are required; vendor, reorder level, prices and opening quantity are optional. The SKU is suggested and can be typed instead. The server gives the item a code of three letters and a random four-digit number.

4. Do not rely on the item's own batch and expiry boxes. Batches are created when a purchase order is approved with a batch number and expiry on its lines (4.4).

5. Watch stock on the item list (red at or below the reorder level; amber when expired or expiring within 30 days), on Batches and in the stock reports.

### What the system checks

The SKU is unique, the category exists, and prices and quantities are zero or more.

A category cannot be deleted while an item uses it. A unit cannot be deleted while a conversion uses it; items using the unit do not stop it.

An item has one unit. Conversions are stored but orders and stock do not use them yet. An item has no VAT field: VAT is chosen on each order line (default tax code 5%).

A quantity typed on a new item writes an Initial stock movement only: no batch, no cost value, no ledger posting. For go-live stock use Opening balances (4.10).

| Rule. Batches belong to a receipt, not to the product. Every approved purchase line creates a batch, and sales take from batches first-expiry-first-out. |
|---|

### Accounting effect

Master data posts nothing. Stock reaches the ledger when a purchase is approved, when a sale is approved (cost of goods sold), when stock is written off, and through opening stock.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The wrong price was typed in Purchase price on an item with stock | That box is the weighted average cost. Typing there overwrites the average. Leave it alone on an item with stock. |
| An item is no longer sold | Set its status to Inactive. Do not delete it: the server does not check for movements. |
| The category list in the item form looks short | The item form and the order quick-create read the first 10 categories only. Use the Categories screen for the full list. |
