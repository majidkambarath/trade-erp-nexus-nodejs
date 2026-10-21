---
title: "Period lock, fiscal years, numbering series and audit log"
audience: client
source: Trade-ERP-Product-Guide 4.13
screens: ["/accounting-setup"]
questions:
  - "why does it say posting is closed"
  - "how do I close a month"
  - "how do I close the year"
  - "what is the audit log"
  - "document numbering"
---

# Period lock, fiscal years, numbering series and audit log

This flow keeps the books controlled: it decides which dates can still be posted to, numbers every document without duplicates, and records who changed the setup. It is run at set-up and at each period end.

| Define fiscal year | → | Post during the year | → | Close the year | → | Reopen if needed | → | Review audit log |
|---|---|---|---|---|---|---|---|---|

| Who | Admin or Accountant. Opening, closing and reopening a year need the super_admin or admin server role. |
|---|---|
| Screens | Accounts, Setup (Posting accounts, Fiscal years with Document numbering, Tax codes, Audit log). |
| Status | Available |

### Steps

1. Setup, Fiscal years, New fiscal year: name (it appears in document numbers), start date, end date.

2. Work through the year. Every create, approve, delete and cancel checks the date against the fiscal years.

3. At period end choose Close. Nothing can then be created, approved or deleted with a date in that year. To correct something, choose Reopen, correct, and close again. Both actions are audited.

4. Audit log: filter by what (for example FiscalYear), action (PERIOD_CLOSED) and dates. Dates are in Dubai time. Expand a row to see before and after values.

### What the system checks

While no fiscal year exists, posting is not restricted. Once any year exists, a date outside every year is refused (NO_FISCAL_YEAR) and a date in a closed year is refused (PERIOD_CLOSED). Years cannot overlap.

The lock covers orders, vouchers, cheque outcomes, write-offs, stock adjustments, opening balances and deletion of approved documents.

Numbers come from one atomic counter per series and fiscal year. They are never reused. A failed transaction leaves a gap, never a duplicate. If no fiscal year covers the date, the Dubai calendar year is the key.

The audit log is append-only: the screen cannot edit or delete an entry.

| Rule. No posting outside an open period. Every create, approve, delete and cancel path calls the same check, so no screen can write into a closed year. |
|---|

| Note. The audit log records: accounts created and changed, the default chart restored, posting-map changes, ledger posting switched on or off (including the automatic switch-on, with the number of earlier documents and opening balances it posted), fiscal years created, closed and reopened, tax codes, company settings, currencies, rates and tolerance, banks, card types and cards, cheque cleared, bounced and cancelled, KYC document types, party accounts, the go-live date and opening-balance postings and reversals, stock write-offs, credit warnings acknowledged and blocks, and e-invoice settings, sending, retries and inbound decisions. It does not record each order or voucher create, edit or delete; those keep their own status and creator on the document (section 8). |
|---|

### Document numbers

| Series | Document | Example |
|---|---|---|
| PO / SO / PR / SR | Purchase order, sales order, purchase return, sales return | SO-2026-0001 |
| RV / PV | Receipt voucher, payment voucher | RV-2026-0001 |
| JV / CV / EV | Journal, contra, expense voucher | JV-2026-0001 |
| DN / CN, WO, SA | Debit note, credit note, stock write-off, stock adjustment | CN-2026-0001 |
| OBV / OSI / OPI / OST | Opening balance, opening sales invoice, opening purchase invoice, opening stock voucher | OSI-2026-0001 |

The middle part is the fiscal-year name, so numbering restarts each year. Customer and vendor identifiers and item codes do not come from these series.

### Accounting effect

Fiscal years and numbering post nothing. The lock decides whether a posting is allowed. The default year the system makes for itself runs from 1 January to 31 December in Dubai time.

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| A document needs a date in a closed year | Reopen the year (super_admin or admin), post, close again. The audit log shows both actions. |
| Posting is refused with NO_FISCAL_YEAR | Add a fiscal year that covers the date, or correct the date. |
| There is a gap in the numbers | A number was issued and its document did not complete. This is expected. A number is never issued twice. |
