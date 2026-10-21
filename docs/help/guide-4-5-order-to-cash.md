---
title: "Order to cash"
audience: client
source: Trade-ERP-Product-Guide 4.5
screens: ["/sales-order", "/sales-orders", "/delivery-notes"]
questions:
  - "how do I raise an invoice"
  - "how do I sell something"
  - "how do I make a tax invoice"
  - "order to cash"
  - "why is my invoice headed sales order"
review: "Stale in three ways: the Send button now really emails the customer with the PDF and a link; the Sales > Orders / Delivery notes / Invoices flow added 12 Oct is not described; the heading now follows the party's VAT registration."
---

# Order to cash

This flow sells goods to a customer: price the order, check the customer's credit, approve it so that stock leaves and the sale is booked, print the tax invoice, and collect the money. Stock is issued first-expiry-first-out and the cost of goods is booked at the same moment as the sale.

| Sales order (draft) | → | Credit check | → | Approve: stock out | → | Tax invoice | → | Receipt |
|---|---|---|---|---|---|---|---|---|

| Who | Sales Executive prepares, Admin approves, Accountant collects. The server lets any signed-in user do each step. |
|---|---|
| Screens | Sales: Orders, Customers, Receivables. Finance: Receipts. Inventory: Batches. |
| Status | Available |

### Steps

1. Sales, Orders, New: customer (a new one can be created on the spot), date, delivery date, LPO number, optional document number, header discount.

2. Add lines: item (the screen shows the quantity in stock), quantity, unit price, discount %, tax code. Add charges such as freight. Attach the customer's order or signed delivery note.

3. Save as Draft, or choose Approved. The server assigns the number (SO-2026-0001); a typed number must be unique.

4. If credit control is on, the customer is checked on approval. In warn mode a popup lists the reasons with Approve anyway and Cancel. In block mode the approval is refused.

5. On approval the server takes stock first-expiry-first-out, books the sale and the cost of goods, records the VAT and raises the customer's balance.

6. Print or download. Once approved the document is headed TAX INVOICE (before that, SALES ORDER). The download saves an Internal Copy and a Customer Copy.

7. Collect the money in Finance, Receipts, oldest invoice first (4.8).

### What the system checks

The date is in an open fiscal year, and every posting key is mapped.

Credit control (off by default). It checks only a sales order, only at approval. Credit test: what the customer owes plus this order exceeds the credit limit (a limit above zero). Overdue test: an open invoice more than N days past due (N above zero). The owed balance is the running balance kept on the customer record. Returns, payments and purchases are never held up. A confirmed warning, and a block, are written to the audit log.

Stock. The server does not refuse an order for lack of stock. The screen warns on approval when the quantity exceeds stock. Stock can go negative, and the short quantity is costed at the last average cost.

First expiry first out. Earliest expiry first, no-expiry batches last. A batch that has expired, or that expires before the order date plus the customer's minimum shelf life, is skipped. A quantity batches cannot cover is left unallocated, not refused.

Prices, VAT and totals come from the server. An approved document cannot be edited.

| Note. Statuses Invoiced (sales) and Confirmed or Invoiced (sales return) in the form are plain labels. They approve nothing. Use the Approve or Confirm button on a draft row. The Send button on the invoice view only shows a message. The invoice has no QR code, and the heading VAT (5%) is fixed text beside the real VAT amount. |
|---|

### Accounting effect

Approving a sales order debits the customer for the total including VAT, credits Sales revenue (gross), Output VAT and Freight recovered, and debits Sales discounts given. It also debits Cost of goods sold and credits Inventory at the weighted average cost. The receipt later debits cash or bank and credits the customer. See the companion document for the exact lines.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The order is wrong and not yet approved | Edit the draft. On a sales order, Delete marks a draft as Rejected. |
| The invoice is wrong and already approved | No screen cancels or deletes an approved invoice. Raise a sales return (4.6) for goods or a credit note (4.9) for price. If it was sent as an e-invoice, only a credit note is allowed (4.12). |
| The credit warning appears | Collect payment, raise the customer's credit limit, or choose Approve anyway. In block mode only a payment or a limit change lets it through. |
| Stock is short | Approve only if the sale must go ahead. Enter the missing purchase soon: costs are recalculated in date order. |
