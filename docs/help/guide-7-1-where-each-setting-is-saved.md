---
title: "Where each setting is saved"
audience: client
source: Trade-ERP-Product-Guide 7.1
---

# Where each setting is saved

Each tab keeps its values in a different place, as the table shows.

| Tab | Saved where | Who can change it |
|---|---|---|
| Company (profile and logo) | On the signed-in user's own account (the user record's company information). Not in the company settings record. | The user, for their own account |
| Business rules | In the company settings record, through /accounting/settings. Every change is written to the audit log. | super_admin or admin |
| Invoice bank details | On the signed-in user's own account, with the company profile. | The user, for their own account |
| Preferences | In the browser only (local storage). Not on the server. Each browser, and each person on a shared computer, keeps their own. | Each user |
| Security | The user's own password, stored as a salted hash. | The user, for their own account |

| Note. Because the company profile and the invoice bank details sit on the user account of the person who saved them, printed invoices read the profile of whoever is signed in. The purchase and sales invoice views also carry built-in fallback company details of the first client, used for any profile field that is empty. A user, or an installation for another client, that has not filled the profile would therefore print the first client's name and bank details on an invoice. The project should move these details to the company record and remove the fallback. This is listed in section 8. |
|---|
