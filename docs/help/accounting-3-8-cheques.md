---
title: "Cheques"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.8
screens: ["/cheques"]
questions:
  - "how do cheques post"
  - "what is cheques in hand"
  - "a cheque bounced"
---

# Cheques

A cheque is not money until it clears. The amount waits in a post-dated-cheques account, the cheque is recorded in the cheque register, and it moves to the bank when it clears.

Table 27. Cheque life cycle (ChequeService)

| Voucher saved with a cheque | → | Pending: cheques-in-hand or cheques-issued account | → | Cleared on or after the cheque date: moved to the bank | → | Bounced or cancelled: whole voucher reversed |
|---|---|---|---|---|---|---|

Table 28. Cheque events and their entries

| Event | Receipt of a customer cheque | Payment by our cheque | Cheque status |
|---|---|---|---|
| Voucher saved | Dr pdc-receipt (Cheques in Hand), Cr customer | Cr pdc-issue (Cheques Issued), Dr vendor | pending (PDC flag if dated after the voucher) |
| Cleared | Dr bank account, Cr Cheques in Hand | Dr Cheques Issued, Cr bank account | cleared |
| Bounced (pending or cleared) | Whole voucher reversed, clearing entries included; invoices reopen | Same | bounced; reason required |
| Cancelled (pending only) | Whole voucher reversed | Same | cancelled |

Table 29. Customer cheque of AED 105.00 for invoice SO of 105.00

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Voucher saved | Cheques in Hand | pdc-receipt | 105.00 | |
| | Customer - Al Noor | party account | | 105.00 |
| Cleared into ENBD Current | ENBD Current | bank-account-group | 105.00 | |
| | Cheques in Hand | pdc-receipt | | 105.00 |

**Rules at saving.** Cheque number of 3 to 20 letters, digits or dashes; a cheque date; for a receipt the bank it is drawn on; the bank account it is deposited to or drawn on. A cheque dated more than 183 days before the voucher is stale (STALE_CHEQUE). The same number from the same bank cannot be recorded twice while pending or cleared (DUPLICATE_CHEQUE).

**Clearing.** The clearing date cannot be before the cheque date (CHEQUE_NOT_MATURE) and must be in an open period. The clearing entries carry the voucher type 'cheque_clearance' and the same voucher id as the original voucher, so a bounce reverses everything with one lookup. A bounced cheque reopens the invoice (outstanding returns to 105.00 in the test).

**Edit and delete.** Editing a voucher whose cheque has cleared is refused (CHEQUE_CLEARED); mark the cheque bounced first. Deleting a voucher with a pending cheque withdraws the cheque. A bounced or cancelled voucher cannot be edited (VOUCHER_VOIDED).
