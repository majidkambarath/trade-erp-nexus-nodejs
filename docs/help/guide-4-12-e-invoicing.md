---
title: "e-Invoicing"
audience: client
source: Trade-ERP-Product-Guide 4.12
questions:
  - "what is e-invoicing"
  - "peppol"
  - "do I have to send e-invoices"
---

# e-Invoicing

The UAE is moving to electronic invoicing over an accredited network. This flow shows what the screens and the sandbox do today: they prepare, check and record invoices as a live service would, but nothing reaches a real network or the tax authority yet.

| Readiness | → | Review | → | Send | → | Delivered | → | Reported to FTA |
|---|---|---|---|---|---|---|---|---|

| Who | Accountant. Sending and retrying need the super_admin, admin or manager role. Settings and fixing customer details need super_admin or admin. |
|---|---|
| Screens | Reports, e-Invoicing (Dashboard, Outbound, Inbound, Readiness, Settings). |
| Status | Available (sandbox) |

### Steps

1. On Readiness, complete the company checks (15-digit TRN, legal name, address and city, seller Participant ID, one active tax code) and each customer's details (name, address line 1, country, city, VAT number, Participant ID). On Settings, switch e-invoicing on; the server refuses while a company check fails.

2. On Outbound, choose an approved sales invoice (tax invoice) or sales return (credit note) and Review it for problems.

3. Choose Send and confirm. The invoice is queued, submitted, then Delivered, then Reported to FTA (use Check status).

4. A failure that can pass is retried by the system; otherwise fix the cause and choose Retry.

5. On Inbound, register a supplier's invoice. The system matches the supplier by TRN or Participant ID and the purchase order by reference or amount. Accept it, or reject it with a reason.

### What the system checks

Before sending: the seller TRN has 15 digits and name, address and city are present. A VAT-registered buyer in the UAE has name, TRN, address, city, country and Participant ID. A credit note names the original invoice. A header discount is refused (use line discounts).

Every line has a resolvable tax category, a standard-rated line has a rate above zero, quantity times price equals the line net, net plus tax equals the line total, and the totals and VAT breakdown reconcile.

A sent invoice cannot be deleted; the server says to issue a credit note. Status moves only along allowed paths; Reported and Rejected are final.

| Note. Sandbox only. The built-in provider needs no account and delivers to no real access point. It simulates results from the buyer's name (NETFAIL, BADREQ or REJECT trigger a network failure, a refused request or a downstream rejection). The screen says that until a live provider is connected nothing here is a valid tax e-invoice. The mandate timeline on the Dashboard tab is static text that tells the reader to confirm it against current official guidance. |
|---|

### Accounting effect

Sending an e-invoice posts nothing: the ledger already holds the sale from approval. The record stores the payload as sent, with a fingerprint, so the invoice can be shown exactly as issued.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The invoice was rejected | Rejection is final. Issue a credit note and a corrected invoice. |
| A send failed on the network | Retried every minute with a growing delay up to the limit (5). After that, choose Retry. |
| A customer's details are incomplete | On Readiness choose Complete details, save, then send. |
| An invoice was sent and is wrong | Do not edit or delete it. Issue a credit note, then a new invoice. |
