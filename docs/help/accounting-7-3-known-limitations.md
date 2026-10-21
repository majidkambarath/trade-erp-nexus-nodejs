---
title: "Known limitations"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 7.3
---

# Known limitations

Table 68. Known limitations

| # | Area and what the code does | Effect for the accountant | Section |
|---|---|---|---|
| 1 | **Date edges.** The trial balance, balance sheet, ageing, statement of account and account ledger read the dates they are sent, without Dubai day bounds (the screens send 00:00 UTC, i.e. 04:00 Dubai, and for the first two an end time with no zone). | An entry stamped 00:00 to 04:00 Dubai time, or a document saved with a time of day, can fall on the other side of a period edge compared with the ledger reports and IFRS statements. | 1.3 |
| 2 | **Credit control.** The approval check reads the customer's running balance (cashBalance), which an allocated receipt does not raise; an on-account adjustment is clamped at zero or above. | It can over-state what a customer owes after they pay against invoices. Party balances (ledger) are right. | 4.9 |
| 3 | **Returns and ageing.** A return does not reduce the outstanding amount of the invoice it returns; ageing reads invoices only. | Ageing exceeds the party balance by returns, advances and unreferenced notes. | 4.10 |
| 4 | **Vendor statement.** It looks for Vendor Advance - <name>; the account created is Advance to Vendor - <name>. | A payment kept on account is missing from the vendor statement but is in party balances. | 4.11 |
| 5 | **Advances.** No action applies an advance to a later invoice. | Edit the receipt or payment and allocate it. | 3.6 |
| 6 | **Stock adjustments.** A manual quantity change is costed, batched and posted when posting is on (Dr or Cr Stock adjustment). Not posted: the quantity typed when an item is created, and an adjustment made while posting was off (the catch-up does not cover it). Editing the price alone does not re-cost the stock on hand. | The valuation shows a difference against Inventory until a journal is entered. | 3.14 |
| 7 | **Stock write-off.** Dated when made; no reversal; input VAT is not reversed. | Correct by journal and stock entry. | 3.14 |
| 8 | **Unused keys.** Six mappable keys are read by no code (section 2.2); all must still be mapped before posting can be switched on. | They carry no posting today. | 2.2 |
| 9 | **Reverse charge.** Reported in boxes 3 and 10 at the line's percent (5 percent if none); nothing is posted. No reverse-charge code in the starter set; it should carry rate 0. | VAT accounts exclude self-assessed VAT; the reconciliation excludes it too. | 4.13 |
| 10 | **VAT return.** Boxes 2, 6, 7 not tracked; all output standard-rated supplies go to the company's own emirate box; out-of-scope lines and zero-rated or exempt purchases appear in no box; a filed return cannot be reopened. | A working paper for those cases; the accountant completes them. | 4.13 |
| 11 | **Older VAT report.** The monthly VATReport collection (/api/v1/reports/vat) is legacy: approval no longer writes to it, and rows from older versions remain readable. | Not reconciled; not used for filing. | 4.14 |
| 12 | **Foreign currency.** Phase 1: receipts and payments only. No foreign invoices, exchange gain or loss, or revaluation; other vouchers refuse a foreign currency. | A foreign receipt settles an AED invoice at its own rate with no exchange difference. | 3.17 |
| 13 | **Overselling.** A sale beyond the stock is not refused; the shortfall is costed at the last average and the quantity goes negative. The engine computes a true-up for a later covering purchase, but nothing stores or posts it. | The valuation flags negative items. | 3.1 |
| 14 | **Purchase extras; round-off.** Header charges and the header discount are not spread into stock cost; a typed total within AED 1.00 of the computed total posts the difference to round-off. | Stock is at invoice value after line discounts. | 3.2 |
| 15 | **IFRS classification.** Current/non-current, expense types and cash-flow lines are decided by name patterns; Input VAT counts with receivables, Output VAT with payables. | A misnamed group is misclassified; review the notes with the accountant. | 4.22 |
| 16 | **Year end.** No closing entries or roll-forward (profit is shown inside equity); no depreciation, accruals, fixed-asset register or bank reconciliation. | Done with journals. | 4.3 |
| 17 | **Older voucher format.** A request without ledgerBased (or a journal without lines) still reaches the older path to the 'Transactor' accounts, outside the chart. Screens do not use it. | Such vouchers are not in the chart reports. | 3.10 |
| 18 | **Party screens.** The Debit Accounts and Credit Accounts screens read the older per-party logs and running balance, not the ledger. | They can differ from party balances. | 4.9 |
| 19 | **Posting off.** Vouchers post whether the switch is on or off; trade documents only when on (caught up later). A cash payment is not blocked by the cash balance; only a contra is. | With the switch off, party accounts show credits without invoices. | 2.5 |
| 20 | **Re-statement through the map.** Group keys are read when a report runs. | Changing a group key changes how past periods are presented. | 2.6 |
