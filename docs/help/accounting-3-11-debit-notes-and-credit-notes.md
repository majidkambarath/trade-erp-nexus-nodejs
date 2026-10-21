---
title: "Debit notes and credit notes"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.11
---

# Debit notes and credit notes

A note adjusts what a party owes without a stock movement. A **debit note** debits the party; a **credit note** credits the party. The lines are on income or expense accounts chosen by the user. VAT follows the party: output VAT for a customer, input VAT for a vendor.

Table 33. The four notes (LedgerVoucherService.processNote)

| Note | Party account | Lines | VAT account | Set against an invoice |
|---|---|---|---|---|
| Credit note to a customer | Cr Customer - name | Dr the chosen accounts | Dr vat-sales | Yes: an approved sales invoice of the customer |
| Debit note to a customer | Dr Customer - name | Cr the chosen accounts | Cr vat-sales | No (NOTE_CANNOT_SETTLE) |
| Debit note to a vendor | Dr Vendor - name | Cr the chosen accounts | Cr vat-purchase | Yes: an approved purchase invoice of the vendor |
| Credit note to a vendor | Cr Vendor - name | Dr the chosen accounts | Dr vat-purchase | No |

**Set against an invoice** (only a note that lowers what the party owes): the invoice must be approved, of the right type and party, and the note total cannot exceed its outstanding amount (NOTE_EXCEEDS_INVOICE). Paid and outstanding amounts move as for a receipt; deleting the note reopens the invoice. A note that lowers the balance and is not set against an invoice is money on account.

**Numbers.** CN-YYYY-NNNN for credit notes, DN-YYYY-NNNN for debit notes.

Table 34. Notes

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Credit note to a customer: 40.00 plus 5% VAT, set against invoice SO of 210.00 (168.00 left) | Sales Discounts Given | chosen account | 40.00 | |
| | Output VAT | vat-sales | 2.00 | |
| | Customer - Al Noor | party account | | 42.00 |
| Debit note to a customer: freight recovered 100.00 plus 5% VAT | Customer - Al Noor | party account | 105.00 | |
| | Freight Recovered | chosen account | | 100.00 |
| | Output VAT | vat-sales | | 5.00 |
| Debit note to a vendor: purchase variance 200.00 plus 5% VAT (on account) | Vendor - Gulf Mills | party account | 210.00 | |
| | Purchase Variance | chosen account | | 200.00 |
| | Input VAT | vat-purchase | | 10.00 |
