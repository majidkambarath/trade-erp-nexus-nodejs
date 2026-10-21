---
title: "Statement of account"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.11
---

# Statement of account

| Statement of account | Statement of account |
|---|---|
| Question it answers | What happened on one customer's or vendor's account, with a running balance? |
| Where | Screen: Statement (/statement). API: GET /api/v1/accounting/reports/statement?partyId=&partyType=Customer\ | Vendor&from=&to=. |
| Source data | With posting on (source: ledger): ledger entries on the party's accounts, found by name. For a customer: Customer - <name> and Customer Advance - <name>. For a vendor: Vendor - <name> and Vendor Advance - <name>. With posting off (source: documents): approved invoices and returns of the party, and approved receipt and payment vouchers. |
| Period and filters | from and to optional, passed to the date parser as sent (section 7). Opening is everything before from. |
| Calculation | • Movements sorted by date, then id. Customer sign = +1, vendor sign = -1. • opening = sign x sum of (debit - credit) of movements before from. • Each row's balance = previous balance + sign x (debit - credit). closing = last balance. totals = sums of debit and credit of the rows shown. • Customer balance positive = they owe us. Vendor balance positive = we owe them. • Documents source: an invoice of a customer is a debit, a return a credit; for a vendor the other way round; a receipt is a credit to a customer, a payment a debit to a vendor. Opening invoices are labelled 'Opening sales invoice' or 'Opening purchase invoice'. |
| Included and excluded | • Ledger source: opening + movement = closing, and the closing equals the party account balance in the trial balance. • Documents source: only receipts and payments are read from vouchers; **notes are not shown** while posting is off. • For a **vendor**, the code looks for Vendor Advance - <name> while the account that is created is Advance to Vendor - <name>. A vendor's payment kept on account is therefore **not on the vendor statement**, although it is in the party balances. The statement of Gulf Mills in section 6 shows 1,050.00 where the party balance is 750.00. |
| Controls and reconciliations | • A customer's statement closing equals the party balance for that customer. • The statement and the trial balance agree for the main party account. |
| Output columns and exports | API: party, opening, rows[{date, voucherNo, voucherType, narration, debit, credit, balance}], closing, totals, source. Screen with print and CSV. |
