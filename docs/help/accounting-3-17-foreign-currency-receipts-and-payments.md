---
title: "Foreign-currency receipts and payments"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.17
---

# Foreign-currency receipts and payments

**Status: built, phase 1.** The ledger is kept only in the base currency (AED). Only receipts and payments can be made in a foreign currency. A foreign voucher is converted to AED once, when it is made; everything after that (allocation to invoices, advances, the cash or bank leg, the cheque register, the card fee and credit-card limit, reversal and deletion) runs on the AED amount exactly as for an AED voucher.

Table 42.

| Rule | Detail |
|---|---|
| Currencies | The currency must be in the list and active (three-letter code). The seed list is AED (base, locked) plus USD, EUR, GBP, SAR, INR, KWD, BHD, OMR and QAR, all switched off and without rates until the company enables them. foreignAmount may have no more decimal places than the currency (2; 3 for KWD, BHD, OMR). |
| Rate | If none is typed, the rate in force on the voucher's Dubai day is used: the latest master rate effective on or before that day. There is no fallback: no rate means NO_RATE (HTTP 422), never a silent 1. A rate is base units per one foreign unit (USD 1 = AED 3.6725), at most six decimals. |
| Typed rate | A typed rate is compared with the master rate. Further away than the tolerance (default 5%) needs a reason of at least three characters (RATE_OUT_OF_TOLERANCE); the voucher then records rateOverridden, the reason and rateSource 'voucher'. With no master rate at all, a typed rate is refused. |
| AED amount | totalAmount = round half up(foreignAmount x rate, 2 decimals), worked in whole numbers so that floating-point error cannot move a cent. |
| What is stored | On the voucher: currency, exchangeRate, foreignAmount, rateDate (the day of the master rate), rateSource (manual, cbuae, import or voucher) and the override fields; an AED voucher stores 'AED', rate 1 and no foreign amount. On the money-side ledger legs: currency, rate and their share of the foreign amount, split in proportion to their AED amounts so that the shares add back exactly. Every ledger amount is AED. |
| Editing, other vouchers, cheques | An edit that leaves currency, day and rate alone keeps the original rate even if the master has moved; a new day, currency or typed rate is judged afresh. Journals, contra, expenses and notes refuse a foreign currency (FOREIGN_CURRENCY_NOT_SUPPORTED). A foreign cheque keeps its foreign value and clears at the AED value it was received at. |

Table 43. Receipt of USD 1,000.00 in cash at 3.6725. The cash leg is stamped USD 1,000.00 at 3.6725.

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Cash in Hand | cash-account-group | 3,672.50 | |
| Customer Advance - Al Noor | party account | | 3,672.50 |
| Total | | 3,672.50 | 3,672.50 |

| **Note.** Not built (phase 2): invoices in a foreign currency, the realised exchange gain or loss when an invoice is settled at a rate other than the one it was raised at, and revaluation of open foreign balances at period end. A foreign receipt settles an AED invoice at the voucher's rate, so no exchange difference arises in phase 1. A correction of the rate for a day replaces that day's rate; the replaced value goes to the audit log. |
|---|
