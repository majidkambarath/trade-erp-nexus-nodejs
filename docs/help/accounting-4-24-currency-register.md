---
title: "Currency register"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.24
---

# Currency register

| Foreign-currency register | Foreign-currency register |
|---|---|
| Question it answers | Which receipts and payments were made in a foreign currency, and what do they total in each currency? |
| Where | Screen: Currency register (/currency-register); the currency list and rates are on /currencies. API: GET /api/v1/currencies/register?from=&to=&currency=&type=receipt\ | payment. |
| Source data | Vouchers that carry a foreign amount. |
| Period and filters | from, to as Dubai days (the end day is included); currency a three-letter code; type receipt or payment. |
| Calculation | • Rows: every foreign-currency receipt and payment in the range, including cancelled and bounced ones, marked as such (at most 5,000 rows; truncated says if more). • Totals per currency and direction count **posted (approved) vouchers only**: count, foreign = sum of foreign amounts, aed = sum of AED totals, averageRate = aed / foreign, to six decimals. |
| Included and excluded | AED vouchers are not listed. |
| Controls and reconciliations | aed equals the sum of the AED totals of the same vouchers. |
| Output columns and exports | API: rows[{voucherNo, voucherType, date, party, currency, foreignAmount, exchangeRate, totalAmount, rateDate, rateSource, rateOverridden, paymentMode, status}], truncated, totals. Screen with filters. |
