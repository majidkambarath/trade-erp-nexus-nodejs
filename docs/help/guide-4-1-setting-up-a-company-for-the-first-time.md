---
title: "Setting up a company for the first time"
audience: client
source: Trade-ERP-Product-Guide 4.1
screens: ["/accounting-setup", "/settings"]
questions:
  - "how do I set up a new company"
  - "where do I set the fiscal year"
  - "what is the posting map"
  - "first time setup"
---

# Setting up a company for the first time

A new installation is empty. This checklist takes the company from a blank system to the point where it can enter opening balances and start trading. The order matters: later items depend on earlier ones.

| Sign in and secure | → | Company and tax identity | → | Chart and posting | → | Rules and masters | → | Opening balances | → | Go live |
|---|---|---|---|---|---|---|---|---|---|---|

| Who | Owner or Admin with the super_admin or admin server role, together with the accountant. |
|---|---|
| Screens | Settings; Accounts (Chart of accounts, Setup, Banks, Card types, Cards, KYC documents, Currencies, Opening balances); Sales (Customers); Purchase (Vendors); Inventory. |
| Status | Available |

### Checklist

| # | Task | Where | Done when |
|---|---|---|---|
| 1 | Sign in with the starter administrator account and change its password at once. Create the real users (by script today, see section 3). | Settings, Security | The starter password no longer works. |
| 2 | Enter the company profile and logo, then the tax identity: registered name, 15-digit TRN, address, emirate, registered for VAT. | Settings: Company, Business rules | Name, address and TRN are saved. |
| 3 | Open the chart of accounts for the first time. The system creates the default chart (33 accounts in 19 groups), maps the posting accounts, creates the starter tax codes, gives every customer and vendor a ledger account, and switches ledger posting on. | Accounts, Chart of accounts | The chart shows the five categories with accounts under them. |
| 4 | Review the chart. Add the bank accounts the company really uses (under the Bank group, with bank, number and IBAN) and the expense accounts it needs. | Chart of accounts | Every real bank account exists. |
| 5 | Check the posting accounts: all 34 keys mapped, ledger posting On. Change a mapping only if the chart differs from the default. | Accounts, Setup, Posting accounts | The panel shows all mapped and posting On. |
| 6 | Add the fiscal year, for example 1 January to 31 December. Until one exists, posting is not restricted by date. | Setup, Fiscal years | The year is listed as Open. |
| 7 | Check the tax codes (Standard 5%, Zero-rated, Exempt, Out of scope). Add Reverse charge if needed. | Setup, Tax codes | Each kind of supply has a code. |
| 8 | Set the business rules: credit control mode and overdue days, return window, whether a return must name its original. | Settings, Business rules | Each panel is saved. |
| 9 | Set up banks, card types (with processing-fee %), cards and the KYC document types. | Accounts: Banks, Card types, Cards, KYC documents | The banks, cards and document types in use exist. |
| 10 | Create customers and vendors (4.2), then categories, units and items (4.3). | Sales, Purchase, Inventory | Every party and item exists. |
| 11 | If foreign-currency receipts and payments are needed, switch on the currencies and enter rates (4.8). | Accounts, Currencies | A currency is on and has a rate. |
| 12 | If moving from another system, enter opening balances (4.10). If e-invoicing is to be used, complete readiness (4.12). | Accounts, Opening balances; Reports, e-Invoicing | Review shows nothing missing. |

### What the system checks

An unmapped posting key stops ledger posting being switched on and names the keys still to map. There is no fallback account. A mapped group must be of the right category and a mapped account active and of the right type.

A TRN must be exactly 15 digits. An IBAN must pass format and checksum (a UAE IBAN has 23 characters). Fiscal years of one company cannot overlap.

The fiscal year is not part of the posting-map check: a company can have posting on and no fiscal year.

| Rule. Set the posting accounts before the first document is approved. If a key is missing at approval, the server refuses and names the key. It never posts to a default account. |
|---|

| Note. Posting is on by default. Once every key is mapped, a company that has never chosen otherwise has ledger posting switched on automatically. Documents approved earlier, and opening balances entered on a chart account while posting was off, are then posted with their own dates. The automatic switch-on is written to the audit log as LEDGER_POSTING_ENABLED, with the number of earlier documents and opening balances posted. |
|---|

### Accounting effect

Setting up posts nothing. It decides which accounts later postings use. The default chart and the posting keys are in the companion document Reports Logic and Account Mapping.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| A posting key was mapped to the wrong account | Change it in Setup, Posting accounts. Entries already posted keep their accounts; only new postings follow. Plan the correction with the accountant. |
| A fiscal year has the wrong dates | Years cannot be edited in the screen today. Close the wrong year only if nothing is posted in it, and add the right one. |
| The TRN was entered wrongly | Correct it in Business rules, Tax identity. The change is audited. |
