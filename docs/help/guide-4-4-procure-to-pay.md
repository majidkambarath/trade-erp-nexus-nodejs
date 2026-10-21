---
title: "Procure to pay"
audience: client
source: Trade-ERP-Product-Guide 4.4
screens: ["/purchase-order", "/purchase-orders", "/goods-received"]
questions:
  - "how do I buy something"
  - "how do I enter a purchase invoice"
  - "how do I record goods received"
  - "procure to pay"
review: "Does not describe the order to goods-received to invoice flow added 12 Oct (Purchase: Orders, Goods received, Invoices)."
---

# Procure to pay

This flow buys goods from a vendor, receives them into stock with batch and expiry, records what is owed, and pays the vendor. The purchase order is also the vendor invoice in this system: approving it records the receipt and the payable in one step.

| Purchase order (draft) | → | Pending approval | → | Approve: stock in | → | Vendor payable | → | Payment |
|---|---|---|---|---|---|---|---|---|

| Who | Purchase Officer prepares, Admin approves, Accountant pays. The server lets any signed-in user do each step. |
|---|---|
| Screens | Purchase: Orders, Vendors, Payables. Inventory: Batches. Finance: Payments. |
| Status | Available |

### Steps

1. Purchase, Orders, New: vendor, date, delivery date, vendor reference. The number (PO-2026-0001) is assigned on save.

2. Add lines: item, quantity, unit price, discount %, tax code, batch number and expiry. Add header charges such as freight, each with its own VAT. Attach the supplier's invoice.

3. Save as Draft or Pending approval. The server prices the document.

4. Approve (the button shows on Pending rows; choosing Approved while editing saves a draft and then approves).

5. On approval the server, in one transaction, checks the fiscal year, moves stock in and updates the weighted average, creates a batch per line, posts the ledger, records the VAT, raises what is owed to the vendor and marks the goods received.

6. Pay in Finance, Payments, set against the purchase order (4.8).

### What the system checks

The date is in an open fiscal year, and every posting key the document needs is mapped; otherwise the approval is refused and names the key.

A document cannot be saved as Approved, Rejected or Cancelled. Approval is a separate action, allowed once. An approved document cannot be edited.

Lines need an existing item and an active tax code. The cost entering stock is the line value after discount and before VAT.

| Note. There is no separate goods received note and no three-way match. A batch left without a number is numbered from the order and line (PO-2026-0001-1). Pending approval is a plain label that makes the Approve button appear. |
|---|

### Accounting effect

Approving a purchase order debits Inventory for the goods (after line discounts), Freight on purchases and Input VAT, and credits the vendor for the total including VAT. A header discount is credited to Purchase discounts received. The payment later debits the vendor and credits cash, bank or the cheque holding account.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The order is wrong and not yet approved | Edit the draft. Delete on a draft marks it Rejected. |
| The order is wrong and already approved | No screen cancels or deletes an approved order. Use a purchase return (4.6) for goods and a debit or credit note (4.9) for price. The server can reverse an approved document, but no screen calls it; ask the project team. It refuses if part of the batch was sold or the period is closed. |
| Goods arrive short, or the vendor's invoice differs in price | Before approval, change the quantity. After approval, record a purchase return or a note. |
