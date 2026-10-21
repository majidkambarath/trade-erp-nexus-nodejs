---
title: "VAT documents detail"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.14
---

# VAT documents detail

| VAT documents detail | VAT documents detail |
|---|---|
| Question it answers | Which documents are behind the boxes, with party, TRN, treatment and VAT? |
| Where | Screen: VAT return > Documents. API: GET /api/v1/vat-return/detail?from=&to=&direction=&kind=&search=&page=&limit=. |
| Source data | The same lines as the VAT return, grouped by document (invoice, expense voucher or note). |
| Period and filters | from, to required; direction input or output; kind a treatment; search on document number, party name or TRN; limit default 50, at most 200. |
| Calculation | • Lines are grouped by source and document id: kinds = the treatments present, taxable = sum, vat = sum, rcmVat = sum. • Party name and TRN come from the customer (trnNumber) or vendor (trnNO) record, or from the voucher. • Sorted by date, newest first, then document number. Totals are the sum of taxable and of VAT of the filtered rows. |
| Included and excluded | The same inclusions and exclusions as the VAT return. A return is netted into its own row as a negative. |
| Controls and reconciliations | The totals cover every line. They agree with the boxes after the unclassified and not-reported lines (which the detail lists with their treatment) are taken out and reverse-charge taxable value is counted once, because the return shows it in both box 3 and box 10. |
| Output columns and exports | API: rows[{source, docNo, docType, date, direction, partyName, trn, kinds, taxable, vat, rcmVat}], totals, paging. Screen with CSV. |

| **Note.** The older VATReport collection, served by /api/v1/reports/vat, is legacy: approval no longer writes to it, and only rows written by older versions remain. The VAT return does not read it, nothing reconciles it, and it is not used for filing. |
|---|
