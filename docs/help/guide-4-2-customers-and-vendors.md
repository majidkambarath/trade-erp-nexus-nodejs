---
title: "Customers and vendors"
audience: client
source: Trade-ERP-Product-Guide 4.2
screens: ["/customers", "/vendors"]
questions:
  - "how do I add a customer"
  - "how do I add a supplier"
  - "where do I set a credit limit"
  - "how do I record a TRN"
---

# Customers and vendors

Every customer and vendor has one master record. It holds what is needed to trade with them, tax them and collect from them: VAT registration, credit limit and terms, contacts, bank accounts and know-your-customer documents with expiry dates. Saving it also creates the party's account in the ledger.

| Add party | → | Fill six tabs | → | Save | → | Ledger account made | → | Expiry watched |
|---|---|---|---|---|---|---|---|---|

| Who | Sales Executive (customers), Purchase Officer (vendors), Admin. The server lets any signed-in user do this. Only super_admin or admin change the document types. |
|---|---|
| Screens | Sales: Customers, Receivables. Purchase: Vendors, Payables. Accounts: KYC documents, Chart of accounts (a party can also be created there). |
| Status | Available |

### Steps

1. Open Customers or Vendors and choose Add. The same six-tab dialog opens for both.

2. Basic and VAT. Name, contact person, phone, email, website, status and address (customers also a billing and shipping address and a sales person). VAT status (VAT registered, Not registered, Exempt, Designated zone), the 15-digit TRN and the trade licence number.

3. Credit and terms. Credit limit in AED (customers only, 0 means no limit), payment terms (Net 30 for customers and 30 days for vendors by default; Net 45, Net 60, Cash on Delivery, Prepaid or any number of days) and credit days, 0 to 365, kept in step with the terms.

4. Contacts and bank accounts. One primary contact. For each bank account, the bank (from the bank master), account number or IBAN, SWIFT, and one primary account.

5. KYC documents. Type, number, issue and expiry dates, one file (PDF, image, Word or Excel, up to 10 MB) and a Verified tick.

6. Choose Save. The server gives the identifier (CUST2026001, VEND2026001) and creates the ledger account.

### What the system checks

TRN. Exactly 15 digits for a VAT-registered or designated-zone party (spaces and dashes are removed). Not allowed for a not-registered party. Optional for an exempt party, but 15 digits if given. Two customers cannot share a TRN, nor two vendors; a customer and a vendor can.

Formats. Email, phone (7 to 20 characters), website, account number (4 to 34), IBAN (format and checksum; a UAE IBAN has 23 characters) and SWIFT (8 or 11).

Rows. Exactly one primary contact. A bank row needs a bank and an account number or IBAN. A document number must fit its type's length; a type that requires an expiry needs one, after the issue date.

The server requires a contact person for both, and an address for vendors.

| Note. Deleting a customer or vendor is permanent. The server does not check for documents, the identifier is released for reuse, and the ledger account is retired only if it was never posted to. Do not delete a party with history. |
|---|

| Note. The customer's minimum remaining shelf life (used for first-expiry-first-out in 4.5) has no field in the form; it can be set only through the server interface. Reminders by email for expiring documents are not built: the screens say Coming soon. |
|---|

### Document expiry

| Status | Meaning | Where it shows |
|---|---|---|
| Valid / No expiry | More than 30 days left, or the document type does not expire. | No mark |
| Expiring soon | 0 to 30 days left. The Expiring documents list also offers 7, 60 and 90 days. | A Document expiring pill under the party name, and the list |
| Expired | The expiry day is before today (Dubai calendar day). | A Document expired pill, and the list |

The default document types are Trade licence, VAT certificate, Emirates ID, Passport, Bank letter and Other. A type can set a minimum and maximum number length and whether an expiry date is required. Defaults can be edited or switched off, not deleted.

### Accounting effect

Saving a customer creates the account Customer - name under Accounts Receivable (an asset). Saving a vendor creates Vendor - name under Accounts Payable (a liability). Renaming the party renames its accounts. An advance account is created the first time an advance is recorded. Nothing is posted when a party is saved.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| The TRN is wrong or already in use | Correct it on the VAT tab. The server names the party that holds it. |
| A document has expired | Open the party, go to KYC documents, enter the new number, dates and file. |
| A party was entered twice, or must stop being used | Delete a duplicate only if it has no documents. Otherwise set the status to Inactive. Statuses are labels today and do not stop orders. |
| Two parties have the same name | Give them distinct names. Ledger accounts are matched by name, so two parties with the same name would share one account. |
