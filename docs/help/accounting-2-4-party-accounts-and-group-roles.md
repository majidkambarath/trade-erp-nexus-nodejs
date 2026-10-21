---
title: "Party accounts and group roles"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.4
screens: ["/chart-of-accounts"]
questions:
  - "what is a party account"
  - "where is the customer's account"
  - "account groups and roles"
---

# Party accounts and group roles

Every customer and every vendor has ledger accounts of its own. They are found or made in one place (ensurePartyAccount), so invoices, receipts, payments, notes and the customer form all end up with the same account. The name is the lookup key.

Table 9. The four party accounts

| Account | Name pattern | Type | Filed under (key) | Code | Used for |
|---|---|---|---|---|---|
| Customer receivable | Customer - <name> | asset | account-receivable-group | AR0001, AR0002... | Sales invoices, sales returns, allocated receipts, customer notes. |
| Vendor payable | Vendor - <name> | liability | account-payable-group | AP0001, AP0002... | Purchase invoices, purchase returns, allocated payments, vendor notes. |
| Customer advance | Customer Advance - <name> | liability | account-payable-group | AP000n | Part of a receipt not set against an invoice. |
| Vendor advance | Advance to Vendor - <name> | asset | account-receivable-group | AR000n | Part of a payment not set against an invoice. |

**Note the filing.** An advance is filed with the group of the opposite party kind: the customer advance (a liability) sits with the payables, and the vendor advance (an asset) sits with the receivables. The accounts keep their natural type, so the balance sheet is right, but the group totals of Accounts Receivable and Accounts Payable each contain one party kind's balance and the other kind's advances (section 5.2).

**When they are made.** On the first of: the party being created (the customer and vendor services call a hook), the first document or voucher that needs the account, or the chart being opened (a backfill gives every existing customer and vendor its main account). Advance accounts are made only when an advance is first taken.

**Code.** The next code of the filing group (AR0001). If the group key is not mapped, the account is created without a group, with a legacy code (CUST, VEND, CADV or VADV plus the last six characters of the party's id).

**Rename and delete.** Renaming a party renames its accounts unless an account with the new name already exists (accounts are never merged). Deleting a party switches its accounts off only if they have never been posted to.

**Created from the chart.** Choosing a Receivable or Payable group on the account form creates a customer or vendor through the normal service, filed in the chosen group (a sub-group is allowed; GROUP_CATEGORY_MISMATCH if the category differs).

### 2.4.1 Group roles

The role of a group tells the screens what kind of accounts it holds. It is worked out from the posting map: the group that a role key points at, and every group under it, has that role. The nearest mapped ancestor wins; a group under none of them has the role 'other'.

Table 10. Group roles (AccountConfigService.GROUP_ROLE_KEYS)

| Role | Key that defines it | What the code does with it |
|---|---|---|
| cash | cash-account-group | Cash vouchers pick from these accounts; contra uses them; cash cannot be overdrawn by a contra; cash book, cash flow and IFRS cash. |
| bank | bank-account-group | Bank, transfer, cheque and card vouchers pick from these accounts; the account form asks for bank details (bank, number, IBAN with checksum). |
| receivable | account-receivable-group | The account form for this group is a customer form. |
| payable | account-payable-group | The account form for this group is a vendor form. |
| creditCard | credit-card-group | A company credit card's liability account is created here; its limit and amount owed are read from this account. |
