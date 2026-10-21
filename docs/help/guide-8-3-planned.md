---
title: "Planned"
audience: internal
source: Trade-ERP-Product-Guide 8.3
review: "Roadmap and known-limitations wording from 5 Oct. Not served to clients: a status promise is a commitment, and several rows are now wrong."
---

# Planned

None of these is built. The code was searched for each one. The last column says what the item needs first.

| Item | Where things stand today | Depends on |
|---|---|---|
| Arabic language and right-to-left layout | The screens are English only. Settings shows Language as Coming soon. The invoice header already prints the company's Arabic name where the profile has one. | Translation of every screen and message; a review of each page in right-to-left; Arabic on printed documents; a language choice per user. |
| Foreign-currency invoices with realised and unrealised exchange gain or loss | Trade documents have no currency field. Foreign receipts settle dirham invoices at the voucher rate, so no difference arises. There is no gain or loss account in the posting map. | The currency master and rates (available); a currency on orders; exchange gain and loss posting keys; settlement at a different rate; month-end revaluation of open foreign balances. |
| Reverse-charge VAT self-assessment posting | The VAT return already reports boxes 3 and 10, worked out when the report is run. Nothing is posted: the Reverse-charge VAT account exists in the chart and the posting map, but no posting uses it. No reverse-charge tax code is seeded. | A posting rule (debit input VAT, credit reverse-charge VAT) for purchase lines coded reverse charge; pricing that does not charge the vendor the VAT; agreement with the accountant on the treatment. |
| VAT return boxes 2, 6 and 7 | Shown as Not tracked yet: tourist refunds, goods imported, import adjustments. | Import documents and customs data; a place to record adjustments; the accountant's rules. |
| Bank and card reconciliation | No statement import or matching exists. Cheque clearing is the only bank-side step. | Bank statement entry or import; matching rules; reconciled marks on bank ledger lines; card settlement statements. |
| Voucher PDF download and expense attachments | Vouchers have a Print page only, with no company name in the heading. The server can store attachments on vouchers, but no finance screen offers them. Orders already have attachments and PDF. | A PDF layout for vouchers (the order PDF code can be reused); the attachment panel on the expense and other voucher screens. |
| Notifications and document-expiry alerts | Expiry shows as pills and lists. Reminders by email are marked Coming soon. There is no mail or message service in the server and no scheduled job for reminders. | A mail or message provider; a scheduled job; who receives what; the alert rules (expiry, low stock, overdue invoices, approvals). |
| Per-location costing | One cost pool per item. A movement has a location field that nothing uses. There is no warehouse or location master. | A location master; transfers between locations; a cost pool per item and location; reports by location. |
| Live e-invoicing service-provider connection | The sandbox works end to end. The live connection is shown as Coming soon, and any provider other than the sandbox is refused. | The choice of an accredited provider; its credentials and a production environment; testing against it; the mandate dates shown on the e-Invoicing dashboard. |
| Brand pack per client | The product is named Zarvia, shown on the sign-in page, the browser title and the sign-in footer. The installation carries one brand pack, NH FOODS, in the screens and the top bar. | The owner's decision on the name; a brand pack per client; removing the first client's fallback details from the invoice views. |

### Further items suggested by this review

These are not on the owner's list. They come from the limitations in 8.4 and are put forward for agreement.

| Item | Reason | Depends on |
|---|---|---|
| Apply the menu roles and add a user-management screen | Today every signed-in user can change most data, and users are created by script (section 3). | A decision on how the six menu roles map to the server roles; a screen to create, edit and disable users. |
| Move the company profile and bank details to the company record | They sit on a user account, and the invoice views fall back to the first client's details (7.1). | A company record; migration of the saved profile. |
| Customer emirate for the VAT return | All standard-rated supplies go to the company's own emirate box. | A customer address emirate field and the return logic. |
