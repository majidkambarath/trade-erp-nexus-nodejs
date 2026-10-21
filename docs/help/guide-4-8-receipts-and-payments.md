---
title: "Receipts and payments"
audience: client
source: Trade-ERP-Product-Guide 4.8
screens: ["/receipt-voucher", "/payment-voucher"]
questions:
  - "how do I record a payment"
  - "how do I receive money"
  - "how do I settle an invoice"
  - "what is on account"
---

# Receipts and payments

A receipt records money coming from a customer and a payment records money going to a vendor. Each is set against the party's open invoices, oldest first, and any rest stays on account as an advance. This flow also covers the five ways of paying, the cheque register, card fees, the credit-card limit and foreign currency.

| Choose party | → | Enter amount | → | Allocate to invoices | → | Choose payment mode | → | Post | → | Clear cheque |
|---|---|---|---|---|---|---|---|---|---|---|

| Who | Accountant. Any signed-in user can post, reverse or delete a voucher. Clearing, bouncing or cancelling a cheque needs the super_admin or admin server role. |
|---|---|
| Screens | Finance: Receipts, Payments, Cheques, Cash & bank. Accounts: Banks, Card types, Cards, Currencies. |
| Status | Available |

### Steps

1. Finance, Receipts (customers) or Payments (vendors), New. Choose the party, date and amount.

2. The screen lists the party's approved open invoices in date order and fills the amount against them oldest first as you type. Change any invoice amount, or choose Oldest first to start again. The rest shows as Kept on account.

3. Choose the payment mode and fill its details (table below). For a foreign currency, choose it, type the amount in that currency and check the rate and the dirham value shown.

4. Choose Post. The voucher posts at once with a number such as RV-2026-0001 or PV-2026-0001. There is no draft and no approval step.

5. For a cheque, open Finance, Cheques. On or after the cheque date choose Clear. If it is dishonoured choose Bounced (Returned, if it had cleared) and give the reason.

### What the system checks

The date is in an open fiscal year. The party exists, the total is above zero, and each invoice amount is above zero, on an invoice of the same party. Amounts set against invoices cannot exceed the voucher amount.

The invoice balance the screen saw is still the server's balance. If another receipt got there first the server refuses (Invoice balance mismatch) and the user reloads.

A bank account must be chosen when there is more than one: the system never guesses the bank. A transfer needs a reference. A cheque dated more than six months before the voucher date is refused as stale; the same number twice in the same direction is refused as a duplicate.

Card: it must be active; an expired card cannot pay. Credit-card limit: a payment is refused if what is owed on the card plus the payment exceeds the limit. Card fee: a receipt on a terminal posts the fee % (the card's, else the card type's) to Card processing fees, and only the rest reaches the bank.

Cash is not checked for sufficiency on a payment (a contra from cash is, see 4.9).

Foreign currency: the currency must be on and have a rate dated on or before the voucher date. A typed rate differing from it by more than the allowed percentage (5% unless changed) is refused unless a reason is given.

| Rule. Receipts and payments post when saved. The only ways to correct one are to reverse it with Delete or, for a cheque, to bounce or cancel it. A reversal adds mirror entries and marks the originals as reversed. Nothing is erased. |
|---|

| Note. The voucher view shows ledger entries but not the invoices it settled. The print page has no company name and three blank boxes (Prepared, Checked, Approved); there is no PDF download. Voucher create, edit and delete are not in the audit log; the voucher keeps who created, updated and approved it. |
|---|

| Note. Foreign currency covers receipts and payments only. The amount is converted to dirhams once, at the voucher's rate, and everything after that is in dirhams. Foreign-currency invoices, exchange gain or loss and month-end revaluation are not built. |
|---|

### Payment modes

| Mode | The screen asks for | Where the money lands |
|---|---|---|
| Cash | Optionally a cash account (the first by code if several). | The cash account |
| Bank | A bank account (see the checks above). | The chosen bank account |
| Transfer | A bank account and a transfer reference. | The chosen bank account |
| Cheque | Number (3 to 20 letters, digits, dashes), cheque date, bank account; for a receipt also the bank it is drawn on. | Cheques in Hand (received) or Cheques Issued (paid) until cleared, then the bank |
| Card | A card. A receipt must use a terminal and needs an approval code; a payment cannot use a terminal. | Receipt: the terminal's settlement bank, less the fee. Payment: the credit card's liability account, the bank for a debit card, a prepaid account for a prepaid card |

### Cheque lifecycle

| State | How it is reached | What it does |
|---|---|---|
| Pending | A cheque is saved with a receipt or payment. | Held in Cheques in Hand or Cheques Issued. The bank is not touched. |
| Cleared | Clear, on or after the cheque date. | Moves the amount from the holding account to the bank. The voucher can no longer be edited. |
| Bounced | Bounce (from pending) or Returned (from cleared), with a reason. | Reverses the whole voucher and reopens the invoices it settled. |
| Cancelled | Cancel, from pending only. | Reverses the whole voucher in the same way. |

### Accounting effect

A receipt debits the money side (cash, bank, Cheques in Hand, or the terminal's bank and the card fee) and credits the customer's account for the amount set against invoices and a Customer Advance account for the rest. A payment mirrors it with the vendor's account and an Advance to Vendor account. Clearing moves the amount from the holding account to the bank. Bouncing or cancelling reverses the whole voucher. Exact lines: companion document.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The amount or invoices were wrong | Receipts and payments have no edit button. Use Delete (reverse): the ledger entries are reversed and the invoices reopened. Then enter it again. |
| The cheque bounced, or was never presented | In the cheque register choose Bounced (Returned) or Cancel. The voucher is reversed and the customer owes the invoices again. |
| The customer paid more than the invoices | The rest is kept on account. The system does not apply an advance to a later invoice by itself (section 8). |
| The invoice balance does not match | Reload the list and enter the voucher again; someone else settled part of the invoice. |
| A foreign rate was refused | Use the rate on file, add a rate for the date on Currencies, or give a reason. |
