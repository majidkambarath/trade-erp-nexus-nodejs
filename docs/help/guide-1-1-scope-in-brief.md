---
title: "Scope in brief"
audience: client
source: Trade-ERP-Product-Guide 1.1
questions:
  - "what is Zarvia"
  - "what does this system do"
  - "what is it for"
---

# Scope in brief

Trade ERP is a business system that runs in a web browser. It is made for a company that buys food from vendors and sells it to customers in the United Arab Emirates. It records the buying and the selling, keeps stock by item and by batch with expiry dates, and keeps the company's accounts in one general ledger in dirhams (AED), with UAE VAT. The first installation is for NH FOODS.

| Area | What the system covers |
|---|---|
| Trade | Purchase orders, purchase returns, sales orders (sales invoices) and sales returns. Each is a draft until it is approved. Approval is what moves stock and posts the accounts. |
| Parties | Customers and vendors, with VAT registration (TRN), credit limits and terms, contacts, bank details and know-your-customer documents with expiry dates. |
| Stock | Items, categories, units of measure, batches with expiry, first-expiry-first-out issue, write-offs, weighted average cost. |
| Money | Receipts, payments (cash, bank, transfer, cheque, card), journals, contra transfers, expenses with VAT, debit and credit notes, cheque register, bank, card-type and card masters. |
| Accounts | One chart of accounts, a posting map that says which account each kind of entry uses, fiscal years with a period lock, document numbering, tax codes, opening balances for go-live, an audit log. |
| Reports | Financial statements, IFRS statements, ledger reports, party balances and ageing, account statements, stock reports, the VAT return, e-invoicing dashboards, and a home dashboard. |
| Company | Company profile, business rules (credit control, returns, tax identity), invoice bank details, display preferences, password change, staff records. |

### What is outside the current scope

These are not built. Section 8 gives the reason and the dependency for each.

More than one company or branch. The code carries a company and branch field on its newer records, but every request uses one default company and one branch.

Arabic screens and a right-to-left layout.

A live connection to an accredited e-invoicing service provider (the e-invoicing screens work against a built-in sandbox).

Bank and card statement reconciliation.

Payroll. The People module holds staff records only.

Notifications by email or message, including document-expiry alerts.
