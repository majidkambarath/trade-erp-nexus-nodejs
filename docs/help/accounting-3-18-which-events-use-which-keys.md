---
title: "Which events use which keys"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.18
---

# Which events use which keys

Table 44. Events and the keys they read

| Event | Configuration keys and accounts used |
|---|---|
| Purchase invoice, purchase return | inventory-asset, vat-purchase, freight-purchase, discount-purchase, round-off-purchase, vendor account |
| Sales invoice, sales return | sales-revenue, vat-sales, discount-sales, freight-sales, round-off-sales, cogs, inventory-asset, customer account |
| Receipt, payment by cash, bank, transfer | cash-account-group or bank-account-group; party and advance accounts |
| Cheque, card | bank-account-group, pdc-receipt or pdc-issue; credit-card-group, card-charges |
| Expense voucher, debit and credit notes | The chosen accounts; vat-purchase (expenses, vendor notes) or vat-sales (customer notes); the payment mode's keys |
| Journal, contra | Journal: none. Contra: the two group keys, to check the accounts |
| Stock write-off | write-off-expiry or damage-loss with inventory-asset |
| Manual stock adjustment | stock-adjustment with inventory-asset |
| Opening balances, account opening balance | opening-balance-equity; inventory-asset for stock; party accounts |
| Foreign-currency receipt or payment | As the mode used; the currency master (no account) |
