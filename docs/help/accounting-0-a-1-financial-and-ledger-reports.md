---
title: "A.1 Financial and ledger reports"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping A.1 Financial and ledger reports
---

# A.1 Financial and ledger reports

Table 69. Financial and ledger reports

| Method and path | Parameters | Notes |
|---|---|---|
| GET /vouchers/reports/financial | reportType = trial_balance, profit_loss, balance_sheet, cash_flow, expense_summary, party_statement; dateFrom, dateTo; partyId and partyType (party_statement) | Trial balance, older profit and loss, balance sheet (uses dateTo only). Dates read as sent. |
| GET /accounting/reports/general-ledger | from, to, category, includeZero | Dubai days. |
| GET /accounting/reports/profit-loss | from, to | Profit and loss with gross profit. |
| GET /accounting/reports/day-book | from, to, type, search, page, limit (max 200), includeLines | includeLines gives the journals register. |
| GET /accounting/reports/voucher/:id | voucher id | Balanced lines of one voucher; 404 NOT_POSTED if none. |
| GET /accounting/reports/cash-book | from, to, kind = cash or bank | |
| GET /accounting/reports/cash-flow | from, to | Cash flow by kind of voucher. |
| GET /accounting/reports/party-balances | type = customer or vendor; asOn; includeZero | Credit exposure for customers. |
| GET /accounting/reports/ageing | type = receivable or payable; asOf | asOf read as sent. |
| GET /accounting/reports/statement | partyId, partyType = Customer or Vendor; from, to | source = ledger or documents. |
| GET /accounting/accounts/:id/ledger | from, to | One account with running balance. |
| GET /accounting/chart | asOf | Chart with balances; opens the default chart and runs the readiness routine. |
| GET /accounting/accounts/postable | none | Flat list of accounts a voucher can post to. |
| GET /accounting/audit-log | entity, action, paging | Audit trail. Actions named in this document: ACCOUNT_MAPPING_CHANGED, LEDGER_POSTING_ENABLED, LEDGER_POSTING_DISABLED. |
