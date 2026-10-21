---
title: "VAT and e-invoicing"
audience: client
source: Trade-ERP-Product-Guide 5.6
---

# VAT and e-invoicing

The VAT return and its documents, the e-invoicing screens, and the register of foreign-currency vouchers.

| Report | Question it answers | Where to find it | Filters | Export | Status |
|---|---|---|---|---|---|
| VAT return | What are the VAT 201 boxes for a period, and does the return agree with the ledger? | Reports, VAT, tab Return /vat-reports | Period (this quarter, last quarter, this month, own dates) | CSV, Print | Available |
| VAT documents | Which documents make up the return, with treatment, taxable value and VAT? | Reports, VAT, tab Documents | Direction; Treatment; Search by document, party or TRN | CSV | Available |
| Saved returns | Which returns are drafts, finalised or filed, and with what FTA reference? | Reports, VAT, tab Saved returns | None | None | Available |
| e-Invoicing dashboard | How many invoices were sent, delivered and reported, and which need attention? | Reports, e-Invoicing, tab Dashboard /e-invoicing | None | None | Available (sandbox) |
| e-Invoicing outbound and inbound | Which invoices and credit notes were sent, and which supplier invoices were received? | Reports, e-Invoicing, tabs Outbound and Inbound | Status; document number (outbound); status (inbound) | None | Available (sandbox) |
| e-Invoicing readiness | Which company and customer details are still missing before invoices can be sent? | Reports, e-Invoicing, tab Readiness | None | None | Available (sandbox) |
| Currency register | Foreign-currency receipts and payments, with rate, AED value, totals and average rate. | Reports, Currency /currency-register | From and To; Currency; Type (receipts or payments) | CSV | Available |

| Note. The Outbound and Inbound e-invoicing lists do not page: they show the 25 most recent documents only. See known limitations in section 8. |
|---|

| Rule. A report keeps no figures of its own: it reads the ledger, the stock movements or the approved documents. Where a report can be checked against another source, it says so on the screen (In balance or Out of balance, Agrees with the ledger or Differs by, Reconciles or Does not reconcile). |
|---|
