---
title: "Screen and web address list"
audience: client
source: Trade-ERP-Product-Guide Appendix A
questions:
  - "what are all the screens"
  - "list of pages"
  - "where is each screen"
---

# Screen and web address list

This appendix lists every screen of the program and its web address (route), by module. The routes are read from the program's route file and menu configuration. A route that is in the program but not yet in the menu is marked.

| Module | Screen | Route | In the menu |
|---|---|---|---|
| Access | Sign in | / | Login page |
| Home | Operations Overview (dashboard, four tabs) | /dashboard | Yes |
| Sales | Sales orders | /sales-order | Yes |
| Sales | Sales returns | /sales-return | Yes |
| Sales | Customers | /customer-creation | Yes |
| Sales | Receivables (customer accounts) | /credit-accounts | Yes |
| Sales | Customer account detail and statement | /credit-accounts/customer/:customerId | No (detail page) |
| Purchase | Purchase orders | /purchase-order | Yes |
| Purchase | Purchase returns | /purchase-return | Yes |
| Purchase | Vendors | /vendor-creation | Yes |
| Purchase | Payables (vendor accounts) | /debit-accounts | Yes |
| Purchase | Vendor account detail and statement | /debit-accounts/vendor/:vendorId | No (detail page) |
| Inventory | Stock items | /stock-item-creation | Yes |
| Inventory | Stock movements | /inventory | Yes |
| Inventory | Categories | /category-management | Yes |
| Inventory | Units of measure | /unit-setup | Yes |
| Inventory | Batches and expiry | /batches | Yes |
| Inventory | Stock item detail | /stock-detail/:id | No (detail page) |
| Finance | Receipt vouchers | /receipt-voucher | Yes |
| Finance | Payment vouchers | /payment-voucher | Yes |
| Finance | Journal vouchers | /journal-voucher | Yes |
| Finance | Contra vouchers | /contra-voucher | Yes |
| Finance | Expense vouchers | /expense-voucher | Yes |
| Finance | Debit and credit notes | /debit-credit-notes | Yes |
| Finance | Cheque register | /cheques | Yes |
| Finance | Cash and bank balances | /cash-and-bank | Yes |
| Finance | Account ledger | /ledger | Yes |
| Finance | Redirects to /ledger | /transactions | Redirect |
| Finance | Redirects to /cash-and-bank | /transactors | Redirect |
| Accounts | Chart of accounts | /chart-of-accounts | Yes |
| Accounts | Bank master | /banks | Yes |
| Accounts | KYC documents and document types | /kyc-documents | Yes |
| Accounts | Card types | /card-types | Yes |
| Accounts | Cards | /cards | Yes |
| Accounts | Opening balances (go-live) | /opening-balances | Yes |
| Accounts | Currencies and exchange rates | /currencies | Yes |
| Accounts | Accounting setup (posting accounts, fiscal years, tax codes, audit log) | /accounting-setup | Yes |
| Reports | Trial balance, profit and loss, cash flow, balance sheet | /financial-statements | Yes |
| Reports | IFRS statements | /ifrs-statements | Yes |
| Reports | General ledger, day book, journals, cash and bank book | /ledger-reports | Yes |
| Reports | Party balances | /party-balances | Yes |
| Reports | Ageing | /ageing | Yes |
| Reports | Account statement | /statement | Yes |
| Reports | Stock reports (seven tabs) | /stock-reports | Yes |
| Reports | Currency register | /currency-register | Yes |
| Reports | VAT return | /vat-reports | Yes |
| Reports | e-Invoicing | /e-invoicing | Yes |
| People | Staff records | /staff-records | Yes |
| Settings | Settings (five tabs) | /settings | Yes |

Any other web address shows the Not found page.
