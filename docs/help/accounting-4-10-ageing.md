---
title: "Ageing"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.10
---

# Ageing

| Receivables and payables ageing | Receivables and payables ageing |
|---|---|
| Question it answers | Which invoices are unpaid, how old are they, and how much is overdue? |
| Where | Screen: Ageing (/ageing). API: GET /api/v1/accounting/reports/ageing?type=receivable\ | payable&asOf=. |
| Source data | Approved trade documents (sales invoices for receivables, purchase invoices for payables) and the party's payment terms. |
| Period and filters | asOf (default now). Only documents dated on or before it. The screen sends a plain day, read as 00:00 UTC (section 7). |
| Calculation | • A document is open if its status is APPROVED and outstandingAmount > 0.005 (outstanding = total - paid). • **Due date**: if the document has its own dueDate (opening invoices entered with one), that; otherwise the document date + the party's term days. Term days are the first whole number found in the party's payment-terms text: 'Net 30' is 30, '45 days' is 45, 'COD' and 'Cash on Delivery' are 0. • daysPastDue = floor((asOf - due date) / one day), counted from 0 upwards. bucket by days past due: 'Not yet due' (0 or less), 1-30, 31-60, 61-90, over 90 (91 or more). • Party totals are the sum of the open invoices' outstanding amounts; the buckets add up to the party total; the grand total is the sum of the open invoices. overdue = grand total - 'not yet due'. |
| Included and excluded | • Returns, credit notes without an invoice reference, and receipts or payments kept on account are **not netted**: they reduce the party balance but not the invoices they could have settled. • Opening invoices are included and age by their own invoice date and due date. • Drafts, rejected and cancelled documents are not included. |
| Controls and reconciliations | • The ageing total differs from the party balance in the ledger by exactly the amounts not set against invoices (advances, returns, notes without a reference). The IFRS notes show this as 'not set against invoices'. |
| Output columns and exports | API: buckets, rows[{partyId, partyName, paymentTerms, buckets, total, invoices[]}], totals, overdue. Screen with CSV. |
