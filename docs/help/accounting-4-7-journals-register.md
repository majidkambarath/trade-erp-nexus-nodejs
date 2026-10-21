---
title: "Journals register"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.7
---

# Journals register

| Journals register | Journals register |
|---|---|
| Question it answers | Which journals were posted, and what are their debit and credit lines? |
| Where | Screen: Ledger reports > Journals. API: the day book with type=journal&includeLines=true. |
| Source data | As the day book, restricted to voucher type 'journal'. |
| Period and filters | from, to, search and paging as for the day book (20 vouchers a page on the screen). |
| Calculation | Each voucher also returns its lines (account code and name, debit, credit, line narration), debit lines first. amount = sum of the debit lines. |
| Included and excluded | Only vouchers of type 'journal'. Opening balance vouchers have their own type ('opening') and are in the day book. |
| Controls and reconciliations | The debit lines of a journal equal its credit lines (balanced). |
| Output columns and exports | Screen: journals with expandable lines; CSV. |
