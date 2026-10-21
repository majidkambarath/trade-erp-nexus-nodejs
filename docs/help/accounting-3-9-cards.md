---
title: "Cards"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.9
questions:
  - "how does a card sale post"
  - "card commission"
  - "settlement"
---

# Cards

Table 30. Card receipts and payments (PaymentModeService, CardService)

| Direction | Card kinds | Posting | Rules |
|---|---|---|---|
| Receipt (customer pays by card) | Merchant terminal only | Dr the terminal's settlement bank account for amount - fee; Dr card-charges for the fee; Cr customer | Approval code from the slip is required. Fee = round(amount x fee% / 100); the fee % is the terminal's own if set, otherwise the card type's. |
| Payment (we pay a vendor by card) | Company credit, debit or prepaid card; not a terminal | Cr the card's account (credit card: its own liability account); Dr vendor | A credit card cannot exceed its limit: owed + payment <= limit (CARD_LIMIT_EXCEEDED). An expired card is refused. |

Table 31. Card receipt and card payment

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Receipt AED 200.00 on a terminal with a 2.5% fee | Settlement Bank | bank-account-group | 195.00 | |
| | Card Processing Fees | card-charges | 5.00 | |
| | Customer Advance - Al Noor | party account | | 200.00 |
| Payment AED 3,000.00 on the company credit card (limit 5,000.00) | Advance to Vendor - Gulf Mills | party account | 3,000.00 | |
| | Credit Card - Company Amex | credit-card-group | | 3,000.00 |

**Card accounts.** A credit card's account is a liability 'Credit Card - <label>' in the credit-card group; a prepaid card's account is an asset 'Prepaid Card - <label>' in the bank group; a terminal or debit card points at an existing bank account. A credit card needs a credit limit; every card except a terminal needs a holder's name.

**What is stored.** Only the last four digits and the expiry. A longer number or a CVV is refused (ONLY_LAST4, NO_FULL_NUMBER). A card's kind and account cannot change after creation.
