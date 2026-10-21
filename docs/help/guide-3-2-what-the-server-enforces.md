---
title: "What the server enforces"
audience: client
source: Trade-ERP-Product-Guide 3.2
screens: ["/users"]
questions:
  - "what does the server enforce"
  - "why was I refused"
  - "it will not let me"
review: "Rewrite against the shipped permission system."
---

# What the server enforces

Reading is open to any signed-in, active user. Changing is open too, except for the actions below.

| Area | Action | Who may do it |
|---|---|---|
| Everyone signed in | Create, edit and approve orders and returns; create and edit vouchers; manage customers, vendors, items, categories, units and staff; read every report and the dashboard; upload attachments | Any active user, whatever the account type |
| Accounting setup | Create or edit accounts and account groups, restore the default chart, map posting accounts, switch ledger posting on or off, open, close and reopen fiscal years, create or edit tax codes, change company settings and business rules | super_admin or admin |
| Banking and currencies | Create or edit banks, card types, cards and currencies; add a rate; clear, bounce or cancel a cheque | super_admin or admin |
| Opening balances and parties | Set the go-live date; post or reverse opening entries; create or change a customer or vendor account from the chart; change KYC document types | super_admin or admin |
| VAT return | Save a draft, finalise, mark filed, delete a draft | super_admin or admin |
| e-Invoicing | Change settings, fix a party's e-invoice details, register an inbound invoice | super_admin or admin |
| e-Invoicing | Send an invoice, retry a failed one, accept or reject an inbound invoice | super_admin, admin or manager |
| Batches | Write off stock from a batch | super_admin, admin or manager |

### Sign-in and sessions

A user signs in with email and password. After 5 wrong passwords the account is locked for 2 hours.

An access token is valid for 7 days and a refresh token for 30 days unless the server is set otherwise. The browser keeps them for the session only. Closing the browser ends the session.

| Note. Creating and deleting a user account are not protected by a sign-in in the current code, there is no screen for managing users, and the setup script gives its starter accounts a known password. These must be closed before real data is held (section 8). |
|---|
