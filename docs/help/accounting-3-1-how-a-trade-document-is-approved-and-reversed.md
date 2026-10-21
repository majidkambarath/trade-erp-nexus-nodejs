---
title: "How a trade document is approved and reversed"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.1
questions:
  - "what happens when I approve a document"
  - "how is a document reversed"
  - "what does approval post"
---

# How a trade document is approved and reversed

The four trade documents (purchase invoice, purchase return, sales invoice, sales return) share one life cycle. Saving never posts; approving does.

Table 15. What approval does, in order (TransactionService.processTransaction)

| Save as DRAFT: priced on the server, number allocated | → | Approve | → | Credit check (sales only) | → | Stock moves at cost | → | Ledger entries (if posting is on) | → | Party balance and statement log |
|---|---|---|---|---|---|---|---|---|---|---|

Table 16. The approval steps

| # | Step | What the code does |
|---|---|---|
| 1 | Save | The server prices every line, header charge, header discount and round-off (table below) and allocates the number (Appendix B). A document cannot be saved as APPROVED, REJECTED or CANCELLED (STATUS_REQUIRES_PROCESS); only the process action can. Only a draft can be edited. |
| 2 | Period lock | assertPostingAllowed(date): while the company has no fiscal year, any date is allowed. Once one exists, a date outside every year is refused (NO_FISCAL_YEAR) and a date in a closed year is refused (PERIOD_CLOSED). The same check guards create, approve and delete of documents, create, edit, approve and delete of vouchers, write-offs, opening balances and cheque clearing. |
| 3 | Credit control | Sales invoices only. Mode 'off' passes. 'warn' refuses with HTTP 409 until the request is repeated with an acknowledgement. 'block' refuses with HTTP 403, no override. |
| 4 | Stock | For every line the weighted-average cost engine moves quantity and cost, writes an inventory movement with its cost fields and updates the batches (sections 3.2 to 3.5). A sale larger than the stock is not refused: the shortfall is costed at the last average and the quantity goes negative. |
| 5 | Ledger | If posting is on: the template for the document type is evaluated, every account is resolved first, and the balanced entries are inserted, dated the document date, with the document's id as voucher id; account current balances are updated. If posting is off nothing is written (it is caught up later, section 2.5). |
| 6 | Re-cost | If the document is dated earlier than other live movements of the same item, those movements were costed on the wrong pool. They are replayed in date order, their cost fields rewritten, and the cost-of-goods and stock legs of the affected sales and returns moved by the difference. Movements in a closed fiscal year keep their stamped cost. |
| 7 | VAT report row | None. Approval no longer writes to the older monthly VATReport collection (legacy: only rows written by older versions remain, readable at /api/v1/reports/vat, not used for filing). The VAT return (section 4.13) reads the approved documents. |
| 8 | Party balance | The running balance (cashBalance) and the statement log (CreditLog or DebitLog) are updated: purchase +total, purchase return -total, sales -total, sales return +total (a customer who owes money is negative). |
| 9 | Status | Status becomes APPROVED; grnGenerated, invoiceGenerated or creditNoteIssued is set by type. All nine steps are one database transaction, so a refused or failed approval leaves the document a draft and writes nothing. |

### 3.1.1 Reversing an approved document

An approved document cannot be rejected or cancelled again (validateAction refuses a processed status). The way back is to **delete** it. In one transaction this reverses the batches (a purchase whose goods were partly sold cannot be removed: BATCH_PARTLY_USED); writes a paired reversal movement for every stock movement and restores the cost pool; reverses the ledger entries; re-costs later movements; reverses the party's running balance; and removes the document. Deletion is refused for an opening invoice (remove it from Opening balances), for an invoice sent as an e-invoice (issue a credit note instead), and inside a closed period.

| **Rule.** A reversal writes a mirror entry for every entry (debit and credit swapped) and marks the original and the mirror as reversed. Reports ignore reversed entries, so the document leaves no trace in the figures, while the audit trail keeps both rows. |
|---|

### 3.1.2 The figures a posting template uses

Table 17. Figures a template can reference

| Figure | Meaning | Formula |
|---|---|---|
| gross | Quantity times price, before discounts | sum of round(qty x price) |
| lineDiscount | Discounts on lines (a fixed amount wins over a percentage; never more than the line) | sum of line discounts |
| netLines | Value of the goods without VAT, after line discounts | gross - lineDiscount |
| lineVat; charges, chargesVat | VAT on the lines; header charges (freight, handling) without VAT and their own VAT | round(taxable x vat% / 100) per line; per charge |
| vat | All VAT on the document | lineVat + chargesVat |
| headerDiscount | An amount taken off the VAT-inclusive total (a settlement discount); never more than the total | min(entered, netLines + vat + charges) |
| roundOff | The client's total less the computed total, kept only if the difference is AED 1.00 or less; otherwise the computed total wins | incomingTotal - computed |
| total | What the party is charged. This identity always holds, which is why a posted document balances | netLines + charges + vat - headerDiscount + roundOff |
| cogs | Cost of goods issued or restored, from the costing engine | sum of the cost each line moved |
