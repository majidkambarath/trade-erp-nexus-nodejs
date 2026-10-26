---
title: "Cheques"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.8
screens: ["/cheques"]
questions:
  - "how do cheques post"
  - "what is cheques in hand"
  - "a cheque bounced"
  - "post-dated cheque"
  - "deposit a cheque"
  - "hold a cheque"
  - "which cheques fall due"
  - "cheque reminders"
---

# Cheques

A cheque is not money until it clears. The amount waits in a post-dated-cheques account, the cheque is recorded in the cheque register, and it moves to the bank when it clears.

Table 27. Cheque life cycle (ChequeService)

| Voucher saved with a cheque | → | Pending (cheques in hand / cheques issued) | → | Deposited (at the bank) | → | Cleared: moved to the bank | or | Bounced / Handed back / Cancelled: the voucher is reversed |
|---|---|---|---|---|---|---|---|---|

A pending cheque can also be put **on hold** (kept in the drawer on purpose) and taken off hold again. It can go straight to Cleared without being marked deposited, for example when it is matched to a bank statement line.

Table 28. Cheque events and their entries

| Event | Receipt of a customer cheque | Payment by our cheque | Cheque status |
|---|---|---|---|
| Voucher saved | Dr pdc-receipt (Cheques in Hand), Cr customer | Cr pdc-issue (Cheques Issued), Dr vendor | pending (PDC flag if dated after the voucher) |
| Deposited | no entry | no entry | deposited |
| Put on hold / taken off hold | no entry | no entry | hold / pending |
| Cleared | Dr bank account, Cr Cheques in Hand | Dr Cheques Issued, Cr bank account | cleared |
| Bounced (pending, on hold, deposited or cleared) | Whole voucher reversed, clearing entries included; invoices reopen | Same | bounced; reason required |
| Handed back (pending or on hold) | Whole voucher reversed | Same | returned; reason required |
| Cancelled (pending or on hold) | Whole voucher reversed | Same | cancelled |

Table 29. Customer cheque of AED 105.00 for invoice SO of 105.00

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Voucher saved | Cheques in Hand | pdc-receipt | 105.00 | |
| | Customer - Al Noor | party account | | 105.00 |
| Deposited | (nothing is posted) | | | |
| Cleared into ENBD Current | ENBD Current | bank-account-group | 105.00 | |
| | Cheques in Hand | pdc-receipt | | 105.00 |

**Rules at saving.** Cheque number of 3 to 20 letters, digits or dashes; a cheque date; for a receipt the bank it is drawn on; the bank account it is deposited to or drawn on. A cheque dated more than 183 days before the voucher is stale (STALE_CHEQUE). The same number from the same bank cannot be recorded twice while it is pending, on hold, deposited or cleared (DUPLICATE_CHEQUE); once a cheque is bounced, handed back or cancelled its number is free again.

**Depositing.** Mark a cheque deposited when it goes to the bank, with the paying-in slip number if you have one. The bank will not take a cheque before the date on it (CHEQUE_NOT_MATURE). Nothing is posted, so a cheque can be deposited even in a month that is closed for posting. A deposited cheque is still offered in bank reconciliation: matching it to the statement line is how it clears. A cheque at the bank cannot be cancelled or handed back, and its voucher cannot be edited or deleted (CHEQUE_WITH_BANK); if it comes back, mark it bounced.

**Holding.** Hold a cheque when you are keeping it in the drawer on purpose; a reason is required. A held cheque cannot be deposited or cleared until you resume it (CHEQUE_ON_HOLD), and it is not offered in bank reconciliation.

**Several at once.** Tick cheques in the register to deposit, clear, hold or resume up to 200 together. Each cheque is done on its own, so one that cannot be done (for example a cheque dated in the future) is reported with its reason and the others still go through. Bouncing is not offered in bulk, because each bounce needs its own reason.

**Clearing.** The clearing date cannot be before the cheque date (CHEQUE_NOT_MATURE) and must be in an open period. The clearing entries carry the voucher type 'cheque_clearance' and the same voucher id as the original voucher, so a bounce reverses everything with one lookup.

**A bounced cheque.** Say why it came back, from the list or in your own words. You can also record the bank's memo date and reference, the bank's certificate reference, and the part the bank paid if it paid some. The cheque is always reversed in full and the invoice reopens (outstanding returns to 105.00 in the example); enter any part the bank paid as an ordinary receipt. If the bank charged a fee you can post it from the same dialog, drawn on the cheque's own bank account (optionally with VAT), and for a customer's cheque you can charge it back to the customer as a debit note. The bounce, the fee and the charge-back are saved together: if any part is refused, such as a closed period or an approval limit, none of them is saved. Nothing in these records is a legal step; they are kept for your file.

**Handing a cheque back.** Use this when you give a cheque back to the customer before it was presented, for example when it is replaced by a transfer. The voucher is reversed like a cancellation and the register shows the cheque as Handed back.

**Edit and delete.** Editing a voucher whose cheque has cleared is refused (CHEQUE_CLEARED); mark the cheque bounced first. Deleting a voucher with a pending cheque withdraws the cheque. A bounced or cancelled voucher cannot be edited (VOUCHER_VOIDED).

**What falls due.** On the Cheques page, **Due dates** shows every cheque still in the air and how soon it falls due, grouped by how soon, party, bank account or month. **Cash forecast** starts from what your bank accounts hold, takes off the cheques already due, and runs week by week or month by month. A cheque on hold is shown beside the forecast, not counted in it, because it will not be banked on its date. Both can be exported to a spreadsheet.

**Reminders.** The notification bell tells people who can see banking when a cheque is due within a week or past its date and not deposited (for a cheque we issued: keep the account funded), when a deposited cheque has not cleared after 5 days, and when a cheque is about to go stale or has. A reminder disappears by itself when the cheque moves on.
