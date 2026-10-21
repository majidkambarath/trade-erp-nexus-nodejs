---
title: "Party sub-ledger against the control accounts"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 5.2
---

# Party sub-ledger against the control accounts

There is no single 'control account' per party kind in the ledger. The Accounts Receivable group holds the customers' accounts **and** the vendors' advance accounts; the Accounts Payable group holds the vendors' accounts **and** the customers' advance accounts (section 2.4). The party-balances report nets each party's main and advance accounts. The relationship is therefore:

Table 54. Party balances against the group totals

| Measure | Formula (debit - credit unless said) |
|---|---|
| Customers' net (party balances) | sum of Customer - <name> less sum of Customer Advance - <name> |
| Vendors' net (party balances) | sum of Vendor - <name> (credit) less sum of Advance to Vendor - <name> |
| Accounts Receivable group total | sum of Customer - <name> + sum of Advance to Vendor - <name> |
| Accounts Payable group total | sum of Vendor - <name> + sum of Customer Advance - <name> (as a credit balance) |
| Identity | Receivable group total - Payable group total = customers' net - vendors' net |

In the worked month (section 6): receivable group 210.00 + 300.00 = 510.00; payable group 1,050.00 + 100.00 = 1,150.00; difference -640.00. Customers' net 110.00 less vendors' net 750.00 is also -640.00.
