---
title: "The eight design principles"
audience: client
source: Trade-ERP-Product-Guide 1.3
---

# The eight design principles

The system was built around eight rules. Each is applied by the server. The last column says where to see it work.

| # | Principle | What it means in practice | See |
|---|---|---|---|
| 1 | One ledger behind everything | Every approved order, voucher, opening balance and stock write-off writes balanced debit and credit lines to one general ledger (ledger posting is on by default). Reports read that ledger. Customer and vendor statements read it too, when ledger posting is on. | 4.5, 4.8, 5 |
| 2 | The server calculates prices, tax and totals | The screen sends quantities, prices, discounts and tax codes. The server works out each line, the VAT, the charges and the total. A total typed on the screen is kept only as a small round-off of up to AED 1.00 either way. Anything further away is ignored. | 4.5 |
| 3 | Nothing posts outside an open period | Every create, approve, delete and cancel checks the fiscal year first. A date with no fiscal year, or in a closed year, is refused. Until a first fiscal year is defined, posting is allowed. | 4.13 |
| 4 | Important changes are audited | Changes to setup and master data, and the exceptions that need a record (credit warnings and blocks, cheque outcomes, opening balances, stock write-offs, e-invoice actions), are written to an audit log with who, when and what. Everyday orders and vouchers keep their own history on the document instead. | 4.13 |
| 5 | Documents are numbered by the server | Numbers such as PO-2026-0001 are issued by the server, one atomic counter per series and fiscal year. They are never reused. A transaction that fails leaves a gap, never a duplicate. | 4.13 |
| 6 | The posting map has no fallback accounts | Each kind of entry finds its ledger account through the posting map. If a key is not mapped, the server refuses the posting and names the key. It never falls back to a default account. | 4.1, 4.13 |
| 7 | Dubai calendar days | Dates are Dubai days (UTC+4, no daylight saving) in the screens, the reports and the numbering. The default fiscal year is 1 January to 31 December. | 4.13 |
| 8 | AED is the base currency | Every ledger amount is in AED. The base currency cannot be removed or given a rate. | 4.8 |

| Rule. Approval is its own step. A document is saved as a draft first. Only approving it moves stock, posts the ledger, updates the party's balance and runs the credit check. The server refuses to save a document directly as Approved, Rejected or Cancelled. |
|---|

| Note. Principle 4 is narrower than the wording "every change is audited" suggests. The audit log does not list each order or voucher edit. Section 4.13 lists exactly what it records, and section 8 lists this under known limitations. |
|---|
