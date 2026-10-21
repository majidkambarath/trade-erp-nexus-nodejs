---
title: "Report logic"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4
---

# Report logic

Each report is described in the same eight rows (section 1.4). Formulas are written with the names of the fields the code uses. Wherever a report must agree with another, the agreement is listed under 'Controls and reconciliations' and collected in section 5.

**Rules that apply to every report.** Reports are read-only GETs behind authentication; preparing, finalising and filing a VAT return needs the admin or super admin role. Before a ledger report, stock report, IFRS statement, the dashboard, the VAT return or the financial statements is read, the system makes sure a company that never chose has posting on and that approved documents are posted (section 2.5); this runs at most once a minute and never blocks the report. Dates are plain days read as Dubai days (section 1.3; exceptions in section 7). The profit and loss and the cash reports read the group keys of the posting map when they run (section 2.6). Most screens export CSV; the statement of account, the VAT return and the IFRS statements also print; the balance sheet and the dashboard have no export.
