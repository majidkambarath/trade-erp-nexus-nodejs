---
title: "Debit and credit notes, expenses with VAT, journals and contra"
audience: client
source: Trade-ERP-Product-Guide 4.9
screens: ["/expense-voucher", "/journal-voucher", "/contra-voucher"]
questions:
  - "how do I record an expense"
  - "how do I pass a journal"
  - "what is a contra"
  - "how do I raise a debit note"
---

# Debit and credit notes, expenses with VAT, journals and contra

Not everything in the books comes from an order or a receipt. This flow covers the manual vouchers: journals for adjustments, contra for moving money between cash and bank, expenses for costs with VAT, and debit and credit notes for price corrections to a customer or vendor.

| Choose voucher type | → | Enter lines | → | Preview | → | Post | → | Reverse if wrong |
|---|---|---|---|---|---|---|---|---|

| Who | Accountant. Any signed-in user can post and reverse. |
|---|---|
| Screens | Finance: Journal, Contra, Expenses, Notes. |
| Status | Available |

### Steps

1. Open the tab for the voucher type and choose New.

2. Pick accounts from the searchable list. It offers every active account that allows direct posting, including customer and vendor accounts, so take care.

3. Enter the lines. In a journal: Enter and the arrow keys move, Alt+N adds a row, Alt+Delete removes one, Ctrl+Enter posts; the balancing amount can be filled for you. For an expense choose the tax code and payment mode. For a note choose the party and read the Will post preview.

4. Choose Post. The voucher posts at once with a number (JV-, CV-, EV-, DN- or CN-).

5. To correct, use Edit (journal, contra, expense) or Delete (reverse).

### What the system checks

The date is in an open fiscal year. Journal debits equal credits within half a fils. An expense account must be of type expense; the tax code must be active; Input VAT must be mapped.

A note can be set against an open invoice only when it reduces what the party owes: a credit note to a customer, or a debit note to a vendor. The invoice must be approved, of the right type, the party's own, and the note cannot exceed its open amount. A reducing note not set against an invoice is held on account.

These types cannot be in a foreign currency. The server refuses them.

| Rule. Journals, contra, expenses and notes post to the one chart of accounts. The older format that posted to the separate cash and bank account list shows an Older format tag and is view-only. |
|---|

| Note. An expense records the vendor for information only. It does not reduce what is owed to the vendor. To pay a vendor's invoice, use a payment (4.8). |
|---|

### The four manual voucher types

| Type | Use it to | The system requires | Posts |
|---|---|---|---|
| Journal | Make any adjustment between accounts. | At least 2 lines, each with an account and a debit or a credit; debits equal credits; accounts active and open for direct posting. Post stays off until balanced. | The lines as entered |
| Contra | Move money between cash and bank accounts. | Two different cash or bank accounts. A cash account must hold at least the amount; a bank account may overdraw. | Dr To, Cr From |
| Expense | Record a cost with its VAT and how it was paid. | An expense account, a description, an amount before VAT above zero, a payment mode; optionally a tax code (VAT = amount times the rate on the date) and a vendor, kept for the record only. | Dr expense (net), Dr Input VAT, Cr money side |
| Debit or credit note | Adjust what a customer or vendor owes without moving stock. | A party and at least one line (account, amount, optional tax code). VAT follows the party: Output VAT for a customer, Input VAT for a vendor. | Debit note: Dr party. Credit note: Cr party. Lines and VAT take the other side |

### Accounting effect

A journal posts the lines you enter. A contra moves the amount between the two accounts. An expense debits the expense account (net) and Input VAT, and credits the money side. A note debits or credits the party's account for the total including VAT, with the lines and the VAT account on the other side. Exact lines: companion document.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| A journal, contra or expense has a wrong amount | Use the pencil to edit it: the old entries are reversed and the voucher is posted again under the same number. An expense paid by cheque cannot be edited in the screen; delete it and enter it again. |
| A note has a wrong amount or party | Notes have no edit button. Use Delete (reverse), which reopens any invoice the note settled, then enter it again. |
| The wrong customer or vendor account was used in a journal | Reverse and re-enter. A journal does not update invoice balances; use a note or a receipt when an invoice balance must change. |
| A cash contra is refused for lack of cash | Check Cash & bank, or enter the receipt that brings the cash in first. |
