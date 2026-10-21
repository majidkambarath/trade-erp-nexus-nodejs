---
title: "Opening balances and go-live"
audience: client
source: Trade-ERP-Product-Guide 4.10
screens: ["/opening-balances"]
questions:
  - "how do I enter opening balances"
  - "how do I start using the system with old data"
  - "go live"
---

# Opening balances and go-live

A company that moves from another system or from paper has balances on the day it starts. This flow enters them once, as at the go-live date, so that ageing, statements, receipts, payments and stock work from the first day.

| Go-live date | → | Account balances | → | Customer invoices | → | Vendor invoices | → | Opening stock | → | Review |
|---|---|---|---|---|---|---|---|---|---|---|

| Who | Admin or Accountant. Posting and reversing need the super_admin or admin server role. |
|---|---|
| Screens | Accounts, Opening balances (six steps in one screen). |
| Status | Available |

### Steps

1. Check that ledger posting is on (Accounts, Setup). The opening screens refuse to post while it is off.

2. Go-live date. Choose the day the new books start. Every opening entry is dated that day. The screen warns when documents or vouchers are already dated before it, when no fiscal year covers the day, or when Opening Balance Equity or Inventory is not mapped.

3. Accounts. Enter the trial balance as at that date (up to 1,000 rows). The difference between debits and credits is shown before posting and goes to Opening Balance Equity.

4. Customers and Vendors. Enter each open invoice: party, reference, date, due date, amount. A row with no reference is the party's lump-sum balance.

5. Stock. Enter item, quantity, unit cost, and batch number and expiry for batch-tracked items.

6. Review. Check that the opening trial balance balances, that stock value agrees with the Inventory account, and clear anything listed as missing.

### What the system checks

The go-live date cannot change once any opening entry exists. An account appears once, with a debit or a credit, not both.

Customer and vendor accounts, the Inventory account and Opening Balance Equity are refused on the Accounts step; they come from the other steps. A party whose own account already carries an opening balance is refused, because the invoices would count it twice.

An invoice dated after the go-live day, a due date before the invoice date, a zero amount, a reference over 60 characters, the same reference twice for one party, or a second lump sum is refused.

Opening stock is accepted only for an item with no movements and no stock on hand. A batch-tracked item needs a batch number and an expiry date. A double click cannot post twice. The fiscal-year lock applies to the go-live day.

| Rule. Opening invoices are real documents (OSI- for customers, OPI- for vendors), Approved, that age, appear on statements, take receipts and payments and count in credit control. They carry no lines, stock or VAT, cannot be returned, and never reach the VAT return or e-invoicing. |
|---|

### Accounting effect

Everything is posted against Opening Balance Equity. Customer invoices: Dr customer, Cr Opening Balance Equity. Vendor invoices: the reverse. Stock: Dr Inventory, Cr Opening Balance Equity for the total value. Accounts: the lines you enter plus a balancing line. Exact lines: companion document.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| An account balance was wrong | Reverse the whole accounts voucher on the Accounts step and enter it again (period open). |
| An opening invoice was wrong | Remove it, while no receipt, payment or note has been set against it. If one has, reverse that first. |
| Opening stock was wrong | Reverse the stock voucher while the items have no other movement. A batch already partly sold blocks it. |
| The go-live date was wrong | Reverse every opening entry on all four steps, then change the date. |
