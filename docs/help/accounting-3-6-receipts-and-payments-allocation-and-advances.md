---
title: "Receipts and payments: allocation and advances"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.6
screens: ["/receipt-voucher", "/payment-voucher"]
questions:
  - "how is a receipt allocated"
  - "what is an advance"
  - "on account"
---

# Receipts and payments: allocation and advances

A receipt is money from a customer; a payment is money to a vendor. Both are vouchers, approved and posted when saved. The party side is the same for every mode; the money side depends on the mode (sections 3.7 to 3.9).

| Receipt voucher and payment voucher | Receipt voucher and payment voucher |
|---|---|
| Trigger | Saving a receipt or payment voucher. Its entries are posted whether the posting switch is on or off. |
| Money side, party side | • A receipt debits the money legs; a payment credits them. • The part set against invoices goes to the party's own account: Cr Customer - name on a receipt, Dr Vendor - name on a payment. • The rest is an advance: Cr Customer Advance - name on a receipt, Dr Advance to Vendor - name on a payment. |
| Allocation rule | • Each linked invoice must belong to the same party. The voucher states the amount allocated and the balance left, and the invoice's current outstanding amount must equal their sum to within 0.01, otherwise the voucher is refused (HTTP 409). • The invoice's paidAmount rises and outstandingAmount is set to the stated balance; its status stays APPROVED. Total allocated cannot exceed the voucher total; on-account amount = total - allocated. |
| Keys, numbers | The cash or bank group keys, pdc-receipt or pdc-issue, card-charges, as the mode needs; party accounts. RV-YYYY-NNNN for receipts, PV-YYYY-NNNN for payments. |
| Edit, delete | An approved voucher is edited only with the force flag: its entries and allocations are reversed and it is posted again. Deleting reverses entries, allocations and statement-log rows and marks the voucher 'cancelled'. |

Table 25. Cash receipts and a payment

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Receipt 100.00 cash, set against invoice SO of 210.00 (110.00 stays outstanding) | Cash in Hand | cash-account-group | 100.00 | |
| | Customer - Al Noor | party account | | 100.00 |
| Receipt 100.00 cash, not set against an invoice | Cash in Hand | cash-account-group | 100.00 | |
| | Customer Advance - Al Noor | party account | | 100.00 |
| Receipt 150.00 cash: 105.00 set against an invoice, 45.00 on account | Cash in Hand | cash-account-group | 150.00 | |
| | Customer - Al Noor | party account | | 105.00 |
| | Customer Advance - Al Noor | party account | | 45.00 |
| Payment 300.00 cash to a vendor, not set against an invoice | Advance to Vendor - Gulf Mills | party account | 300.00 | |
| | Cash in Hand | cash-account-group | | 300.00 |

| **Note.** There is no action that applies an advance to a later invoice; the way is to edit the receipt or payment and allocate it. Until then the advance reduces the party's balance in the party-balances report while the ageing report still shows the invoice as outstanding (section 5.2). |
|---|
