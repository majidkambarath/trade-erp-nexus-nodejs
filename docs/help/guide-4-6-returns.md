---
title: "Returns"
audience: client
source: Trade-ERP-Product-Guide 4.6
screens: ["/sales-return", "/purchase-return"]
questions:
  - "how do I return goods"
  - "how do I raise a credit note"
  - "customer sent goods back"
---

# Returns

A return sends goods back: a customer returns what they bought, or the company returns goods to a vendor. A return is tied to the document it comes from, cannot exceed it, and puts stock back at the cost it left at.

| Choose party | → | Choose original | → | Choose lines | → | Save draft | → | Approve |
|---|---|---|---|---|---|---|---|---|

| Who | Sales Executive or Purchase Officer prepares, Admin approves. |
|---|---|
| Screens | Sales: Returns. Purchase: Returns. |
| Status | Available |

### Steps

1. Sales, Returns (or Purchase, Returns), New. Choose the customer (vendor). The form lists that party's approved sales invoices (purchase orders). Choose the original.

2. The form fills the lines that can still be returned, with price, VAT % and discount %, and a Can return quantity. Set the quantities. A purchase return also needs the vendor's reference.

3. Save as Draft. Then approve: Confirm on a sales return draft, Approve on a purchase return that is Pending approval.

### What the system checks

The original is approved, of the right kind and for the same party. Each line comes from the original.

Quantity cannot exceed what remains. Remaining quantity is worked out from live returns, so rejecting or deleting a return frees it. The value of a line (after discount, before VAT) cannot exceed what was invoiced.

Return window (Settings, Business rules): a return dated later than N days after the original is refused; 0 means no limit. Require return link: when on, a return must name its original.

An opening-balance invoice cannot be returned against. Use a note.

Sales return stock goes back into the batches it was sold from, at the unit cost the sale carried; the rest goes into a new batch named after the return. Purchase return takes stock from the original order's batches at the documented purchase cost.

| Rule. A return is limited by its original, by quantity and by value, line by line, counting every other live return against the same line. |
|---|

### Accounting effect

A sales return mirrors the sale: it debits Sales revenue and Output VAT, credits the customer, and puts the goods back into Inventory against Cost of goods sold at the original cost. A purchase return debits the vendor and credits Inventory and Input VAT. The VAT return nets returns into the box of the supply they correct (4.11).

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The server says the return exceeds the original | Reduce the quantity to the Can return figure. |
| The return window has passed | An admin can change the window, or a credit note (4.9) can settle the money. |
| A return was saved as Confirmed but nothing moved | Confirmed is a label. Open the draft row and use the Confirm button. |
| An approved return is wrong | No screen undoes an approved return. Raise the opposite document or a note, and ask the project team if the stock must be reversed. |
