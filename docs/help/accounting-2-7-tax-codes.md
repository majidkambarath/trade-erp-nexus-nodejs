---
title: "Tax codes"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.7
screens: ["/accounting-setup"]
questions:
  - "what is a tax code"
  - "how do I add a VAT rate"
  - "reverse charge"
---

# Tax codes

A tax code says how a line is taxed, not only at what percentage: a zero-rated supply and an exempt supply are both 0 percent but are reported in different boxes of the VAT return.

Table 13. Tax code kinds

| Kind | Starter code (rate) | Effect on the VAT return |
|---|---|---|
| standard | Standard 5% (5, the default) | Output: box for the company's emirate (1a to 1g). Input: box 9. |
| zero_rated | Zero-rated (0) | Output: box 4. A zero-rated purchase appears in no box. |
| exempt | Exempt (0) | Output: box 5. An exempt purchase appears in no box. |
| out_of_scope | Out of scope (0) | Appears in no box (counted in 'not reported'). |
| reverse_charge | none in the starter set | Boxes 3 and 10 (section 4.13). Should carry rate 0 so that nothing is added to the vendor's invoice. |

**Starter set.** A company with no tax codes gets the four codes above (without reverse-charge); 'Standard 5%' is the one default.

**Rate history.** A code has a base rate and an optional history of (date, rate) entries. The rate on a document date is the entry with the latest date on or before that date; if there is none, the base rate applies. Example: 5 percent with an entry '6 percent from 1 January 2027' gives 5 on 1 June 2026 and 6 on 1 March 2027.

**On a document line.** If a line names a tax code, its VAT percent is taken from the code as at the document date (whatever percent the client sent is ignored) and the code's kind is saved on the line as a snapshot (taxKind). A later change to the code never restates a posted document. A line with no code keeps the percent it was sent. An inactive or unknown code is refused (INVALID_TAX_CODE).

**On vouchers.** Expense vouchers and the lines of debit and credit notes take their VAT from the code in force on the voucher date. The code decides the rate only; the kind is read from the code when the VAT return is built.
