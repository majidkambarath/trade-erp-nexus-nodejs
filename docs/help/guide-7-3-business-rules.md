---
title: "Business rules"
audience: client
source: Trade-ERP-Product-Guide 7.3
---

# Business rules

Each panel saves on its own. The rules below are applied by the server.

| Rule | Allowed values | Default | What it does |
|---|---|---|---|
| Credit control mode | Off, Warn, Block | Off | Checked only when a sales order is approved. Warn stops the approval with a warning until the user confirms. Block refuses it with no override. |
| Overdue block days | Whole number, 0 or more | 0 (ignore) | An open invoice more than this many days past due counts as a breach. |
| Return window days | Whole number, 0 or more | 0 (no limit) | A return dated more than this many days after the original document is refused. |
| Require return link | On or off | Off | When on, a return must name the document it returns. |
| Tax identity | Registered name, 15-digit TRN, registered for VAT, address, city, emirate, email, phone | Registered for VAT: on | The seller details on tax invoices and e-invoices. Blank fields are filled from the Company tab. The TRN must be exactly 15 digits. |

The credit test is: what the customer owes plus this order is more than their credit limit, applied only when the customer has a limit above zero. A confirmed warning is written to the audit log.

Other company settings exist but have no control in Settings:

Ledger posting on or off, and the posting accounts: Accounts, Setup, Posting accounts.

The first month of the fiscal year (default January): accepted by the server, no screen yet.

Decimals: amounts 2, quantities 3, rates 5. Base currency AED.

The allowed foreign-exchange rate difference (default 5%): set on the Currencies page.

The opening-balance (go-live) date: Accounts, Opening balances.
