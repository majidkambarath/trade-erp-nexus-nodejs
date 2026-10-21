---
title: "Known limitations"
audience: internal
source: Trade-ERP-Product-Guide 8.4
review: "Roadmap and known-limitations wording from 5 Oct. Not served to clients: a status promise is a commitment, and several rows are now wrong."
---

# Known limitations

These were found in the code while writing this guide. Items marked (read, not run) were read from the code and not tested in a running system. They are listed so the team can decide what to close before real data is entered.

### Access and security

Roles are not applied. The server restricts only the actions in section 3.2. Any signed-in user, including type viewer, can create, edit, approve and delete orders, vouchers, parties and items.

User accounts. There is no screen to manage users. Creating and deleting a user are not protected by a sign-in on the server. The setup script seeds starter administrators with a known password. If the token-signing secret is not set in the server's environment, the code falls back to a fixed text. Requests are accepted from any web origin. All of these must be closed before go-live.

Sessions. The silent token refresh does not work as written: the screen sends no refresh token, so when the access token expires (7 days by default) the user returns to sign-in (read, not run). A password change does not end other sessions, and signing out does not call the server.

### Audit and corrections

Audit log scope. It records setup, master and exception events (4.13), not each order or voucher create, edit or delete.

Approved orders. No screen cancels or deletes an approved order or return; corrections use a return or a note. The server can reverse an approved document, but no screen calls it, and it does not check whether receipts or payments are set against the invoice. Reverse the voucher first.

Deleting a customer, vendor or item does not check for documents or movements, and a deleted party's number can be reused.

Order statuses. Pending approval, Confirmed and Invoiced are stored as labels and approve nothing.

### Stock and costing

Short stock does not stop a sale. Stock can go negative, costed at the last average cost.

Manual stock adjustment is costed, batched and posted (4.7). Two cases are not posted: a quantity typed on a brand-new item, and adjustments made while ledger posting was off.

Item edit form. Purchase price overwrites the weighted average cost on an item with stock. A category change on edit may be dropped (read, not run). Category pickers in the item form and order quick-create show the first 10 categories only, and the Active and Inactive counts on Categories read zero (read, not run).

Codes. Item codes (three letters and a random four-digit number) and staff identifiers have no retry on a clash.

Unused fields. Unit conversions are stored and not used. The customer's minimum shelf life and e-invoice participant details have no field in the customer form.

Advances are not applied to later invoices by the system. Credit control reads the running balance kept on the customer record, not the ledger. There is one cost pool per item.

### Accounting and reports

No year-end closing entries. The balance sheet shows profit to date inside equity. Closing a year locks the period and posts nothing.

VAT return. Boxes 2, 6 and 7 are not tracked. Out-of-scope sales and zero-rated or exempt purchases appear in no box. All standard-rated supplies go to the company's own emirate. Reverse charge is reported, not posted. Marking filed records a reference and does not contact the FTA.

IFRS statements. Other comprehensive income is fixed at zero. Current and non-current classification and equity columns are assigned by matching words in account and group names. The notes are basic and say so. Note ageing uses what is outstanding now.

Dates and export. The trial balance, balance sheet, account ledger and account statement take dates as typed; other reports use Dubai days. Reports export CSV and print only, and the balance sheet has neither.

Dashboard. The collection rate can exceed 100%. The sales, purchases and profit chart mixes ledger and document sources. The category sales chart always compares the calendar month of the period end with the month before. Recent activity ignores the chosen period.

### Documents and printing

Company details are stored on the signed-in user's account. The sales and purchase invoice views carry fallback details of the first client and print them when the profile is empty.

Invoice views. Send shows a message and sends nothing. VAT (5%) is fixed text. No QR code. On sales tables Download saves the Internal Copy and Duplicate the Customer Copy; in purchase tables both do nothing.

Vouchers. The print page has no company name, the view does not list settled invoices, and there is no PDF download.

Staff files. The form accepts PDF, but the server accepts only JPG, PNG and WEBP up to 5 MB (read, not run). A company email ending in more than three letters after the last dot passes the screen and fails on save.

### e-Invoicing, and notes for the implementers

e-Invoicing is sandbox only. The Outbound and Inbound lists show 25 documents and do not page. The retry limit (5) is not editable. Accepting an inbound invoice creates no purchase document.

One company and one branch: every request uses the default scope.

Two route files require controller files whose letter case differs from the file name (inventoryMovementController, UOMController). This works on Windows and fails on a case-sensitive server such as Linux.

Older routes remain on the server although their screens were removed: /account-v2, /account and /reports/vat. The old monthly VAT report table is no longer written when a document is approved; only rows from older versions remain readable.

| Rule. Before the system holds real data: close the user-account and token items under Access and security, decide the role mapping, and set the posting accounts and the first fiscal year. |
|---|
