---
title: "Opening balance entered when an account is created"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.16
---

# Opening balance entered when an account is created

The account form accepts an opening balance with a side (debit or credit) and a date (today if none), in an open period. If posting is on, the account and Opening Balance Equity are posted with voucher number OB-<account code> and voucher type 'opening'. If posting is off, the balance is only stored on the account and no entry is written; when posting is switched on, the catch-up posts it once, dated the day the account was created (section 2.5). Creating a customer or vendor through a Receivable or Payable group uses the same routine. An account that carries an opening balance from its creation counts as already entered in Opening balances, and a party with such a balance cannot also be given opening invoices (PARTY_HAS_ACCOUNT_OPENING), because they would count the same money twice.

Table 41. Bank account ENBD Current created with a debit opening balance of AED 5,000.00

| Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|
| Emirates NBD Current | bank-account-group | 5,000.00 | |
| Opening Balance Equity | opening-balance-equity | | 5,000.00 |
| Total | | 5,000.00 | 5,000.00 |
