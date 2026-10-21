---
title: "Day book"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.6
---

# Day book

| Day book | Day book |
|---|---|
| Question it answers | Which vouchers and documents were posted, in date order, and for what amount? |
| Where | Screen: Ledger reports > Day book. API: GET /api/v1/accounting/reports/day-book?from=&to=&type=&search=&page=&limit=; one voucher's lines: GET /api/v1/accounting/reports/voucher/:id. |
| Source data | Ledger entries not marked reversed, grouped by voucher id. |
| Period and filters | from, to Dubai days; type is a voucher type (for example sales_order, receipt); search matches voucher number, narration or account names (typed text, not a pattern); limit default 50, at most 200. |
| Calculation | One row per voucher: date = earliest entry date; voucherNo; typeLabel; party = the name in the party account among its entries (Customer, Vendor, Customer Advance, Advance to Vendor); lineCount. • amount = sum of the debit amounts of the voucher's entries, **except** that for a sales invoice or a sales return the debit and credit legs on the cost-of-goods account and the Inventory account are left out. The clearing entries of a cheque (type cheque_clearance, posted under the receipt's voucher id) are not added: a cleared 300.00 cheque receipt shows 300.00, not 600.00. • balanced = \ | sum of debits - sum of credits\ | < 0.01 for all the voucher's entries. byType = the sum of amount and the count per voucher type, for the filtered set. Rows are sorted by date, newest first. |
| Included and excluded | • What amount means for a sale: the invoice as billed, without the cost legs. It is the customer's debit plus any discount debit and round-off-down debit, which equals gross revenue + freight + VAT. A sale of 10 x 20.00 plus 5 percent VAT shows 210.00 (not 310.00 with the cost leg). A sale with a discount shows the total plus the discount: example B in section 3.4 shows 972.00 + 115.00 = 1,087.00. • For a purchase and for vouchers, amount is the full debit total; for a purchase with a header discount that is the total plus the discount. • A document appears once per voucher id, so a cheque receipt and its later clearing appear as one voucher. If a period holds only the clearing (the receipt was in an earlier period), it appears as a 'Cheque clearance' line for the cheque's amount. |
| Controls and reconciliations | • Every row must be balanced. • The sum of amount by type is the figure the dashboard's 'Reports' tab shows for receipts, payments, journals, contra and expenses. |
| Output columns and exports | API: rows[{voucherId, date, voucherNo, voucherType, typeLabel, party, narration, amount, balanced, lineCount}], total, byType. Screen with search, paging and CSV. |
