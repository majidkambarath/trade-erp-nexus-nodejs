---
title: "Reports overview"
audience: client
source: Trade-ERP-Product-Guide 5
---

# Reports overview

This section lists every report in the Reports module and the registers that sit beside it: the question each one answers, where to find it, how to filter it and how to take it out of the system. The debit and credit logic behind each report is in the companion document Reports Logic and Account Mapping.

### What is common to all reports

| Topic | How it works |
|---|---|
| Who can read | Any signed-in user. The server does not restrict report reads by role. Only saving, finalising and filing a VAT return need an admin role. |
| Dates | Dubai calendar days. A range starts at 00:00 on the first day and ends at 23:59:59 on the last day. The trial balance, balance sheet, account ledger and account statement take the dates as typed. |
| Source | The ledger reports read the general ledger, and a reversed entry never counts. Stock reports read the stock movements. Party statements read the ledger when ledger posting is on and the approved documents when it is off. The VAT return reads the approved documents and is compared with the ledger. |
| Catch-up | Before the IFRS statements, stock reports, trial balance, balance sheet, VAT return and dashboard run, the system makes sure ledger posting is on and that approved documents, and opening balances entered on an account while posting was off, that missed the ledger are posted. This runs at most once a minute. The general ledger, day book, ageing and account statement do not do this. |
| Export | CSV (UTF-8 with a byte-order mark, so Excel reads Arabic and other names) and the browser's Print. There is no Excel or PDF download in the Reports module. Order and invoice views have their own PDF (see 4.4 and 4.5). |
| Balances | Shown as an amount with Dr or Cr. Customers normally show Dr, vendors Cr. |
