---
title: "Opening balances"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 3.15
screens: ["/opening-balances"]
questions:
  - "how do opening balances post"
  - "opening balance equity"
---

# Opening balances

Opening balances are the go-live set-up: a company moving from another system chooses a go-live date and enters, as at that date, account balances, customer and vendor open invoices, and stock. Everything is posted against **Opening Balance Equity** (key opening-balance-equity), so the opening trial balance balances by construction and the difference lands in equity.

Table 39. Opening balances: the rules

| Rule | Detail |
|---|---|
| Go-live date | One date for the company; every opening entry is dated that day (00:00 UTC, 04:00 Dubai). It is fixed once any live opening entry exists (GO_LIVE_DATE_LOCKED). Setting it warns, without blocking, if approved documents or vouchers are dated earlier. |
| Posting, period, reversal | Posting must be on (POSTING_DISABLED otherwise): there is no 'stored only' mode. Every post and reversal is checked against the fiscal years. An accounts or stock voucher is reversed as a whole while its period is open; an opening invoice only while nothing has been received, paid or noted against it. |
| Numbers | OBV-YYYY-NNNN accounts voucher; OSI- opening sales invoice; OPI- opening purchase invoice; OST- opening stock voucher. |
| Account balances | Debit or credit balances for ordinary accounts. Party accounts, the Inventory account and Opening Balance Equity are refused. An account that already has an opening entry is refused until that voucher is reversed. The difference between total debits and credits goes to Opening Balance Equity on the short side. |
| Customer and vendor open invoices | Each row is a real trade document: type sales_order or purchase_order, status APPROVED, no lines, isOpening true, keeping its original invoice date and optional due date for ageing. A row without a reference is the party's lump sum (one per party). Duplicates and dates after the go-live day are refused. No stock, VAT, cost of goods or e-invoice is created; the party's running balance and statement log are updated as for an approved invoice. |
| Opening stock | Each row is an item, quantity and unit cost, with batch number and expiry for batch-tracked items. Same cost and batch path as a purchase receipt (movement OPENING_STOCK, basis 'opening'), dated the go-live day, with **one** ledger voucher for the submission. Only an item with no movements and no stock on hand can take an opening entry; a later movement blocks the reversal. |

Table 40. Opening entries

| Event | Account | Configuration key | Debit (AED) | Credit (AED) |
|---|---|---|---|---|
| Accounts voucher OBV: cash 5,000, bank 20,000, vehicles 30,000 debit; loan 15,000, capital 10,000 credit | Cash in Hand | chosen account | 5,000.00 | |
| | Bank Account | chosen account | 20,000.00 | |
| | Vehicles | chosen account | 30,000.00 | |
| | Bank Loan | chosen account | | 15,000.00 |
| | Owner's Capital | chosen account | | 10,000.00 |
| | Opening Balance Equity | opening-balance-equity | | 30,000.00 |
| Opening customer invoice INV-1001 of 1,200.50 | Customer - Al Noor | party account | 1,200.50 | |
| | Opening Balance Equity | opening-balance-equity | | 1,200.50 |
| Opening vendor invoice INV-V-77 of 3,000.00 | Opening Balance Equity | opening-balance-equity | 3,000.00 | |
| | Vendor - Gulf Mills | party account | | 3,000.00 |
| Opening stock OST: rice 10 at 5.00 and 30 at 7.00 = 40 bags, average 6.50 | Inventory Stock | inventory-asset | 260.00 | |
| | Opening Balance Equity | opening-balance-equity | | 260.00 |
