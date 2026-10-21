---
title: "Party balances and credit exposure"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.9
---

# Party balances and credit exposure

| Party balances | Party balances |
|---|---|
| Question it answers | What does each customer owe, or each vendor get owed, on a date; how much of the credit limit is used; what is overdue? |
| Where | Screen: Party balances (/party-balances), tabs Customers and Vendors. API: GET /api/v1/accounting/reports/party-balances?type=customer\ | vendor&asOn=&includeZero=. |
| Source data | Ledger entries on the party accounts, found **by name**: customers Customer - <name> and Customer Advance - <name>; vendors Vendor - <name> and Advance to Vendor - <name>. Customer master (credit limit, payment terms) and the ageing report. |
| Period and filters | asOn (default today) as a Dubai day: entries up to the end of that day. includeZero keeps parties with a zero balance. |
| Calculation | Per party, adding its main account and its advance account: • Customer balance = sum of (debit - credit). Vendor balance = sum of (credit - debit). Rounded to two decimals. • Customer only: creditLimit from the master; available = limit - balance (empty if no limit); utilisation % = max(balance, 0) / limit x 100, to two decimals. • status: 'no-limit' if limit <= 0; else 'over' if balance > limit; else 'near' if utilisation >= 80; else 'ok'. • overdue = (ageing total - 'not yet due' bucket) for the party at the same date. Totals: owed = sum of positive balances; advances = minus the sum of negative balances; net = sum of all; overdue; overLimit and nearLimit counts (customers). Rows sorted by balance, largest first. |
| Included and excluded | • The balance is the **net** of the party's invoices, returns, receipts, payments, notes and advances, because the advance account is included. A customer with an invoice of 210.00 and an unallocated receipt of 100.00 shows 110.00. • The overdue figure comes from invoices (section 4.10), so it ignores returns and unallocated advances. |
| Controls and reconciliations | • Customers' net balance equals the sum of the customer accounts less the customer advance accounts; vendors' likewise (section 5.2). |
| Output columns and exports | API: rows[{partyId, partyCode, partyName, paymentTerms, balance, creditLimit, available, utilisation, status, overdue}], totals. Screen with CSV. |

| **Note.** Credit control at the moment of approving a sales invoice (section 3.1) uses a different figure: the customer's running balance cashBalance, with the credit limit, as 'owed + this order > limit'. That running balance falls with each approved invoice and rises with approved returns and with receipts that are kept on account, but an allocated receipt does not raise it. The party-balances report reads the ledger and is the reliable figure; the control can over-state exposure for customers who pay against invoices (section 7). |
|---|
