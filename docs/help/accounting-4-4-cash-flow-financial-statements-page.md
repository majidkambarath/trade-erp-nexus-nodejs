---
title: "Cash flow (financial statements page)"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.4
questions:
  - "cash flow statement"
  - "how is cash flow calculated"
---

# Cash flow (financial statements page)

| Cash flow by kind of voucher | Cash flow by kind of voucher |
|---|---|
| Question it answers | Where did cash and bank money come from and where did it go in the period? |
| Where | Screen: Financial statements > Cash flow. API: GET /api/v1/accounting/reports/cash-flow?from=&to= (LedgerReportsService.cashFlow). |
| Source data | Ledger entries not marked reversed on the active accounts in the families of cash-account-group and bank-account-group. |
| Period and filters | from, to as Dubai days. Without from the opening is zero. |
| Calculation | • opening = sum of (debit - credit) on those accounts dated before from. • For every voucher with entries on those accounts in the period: net = sum of (debit - credit) of those entries. Inflow = net if net > 0. Outflow = -net if net < 0. • Vouchers are grouped by voucher type; the line shows the sum of inflows, the sum of outflows, the net and the number of vouchers. Lines with no inflow and no outflow are not shown. • totalIn, totalOut, net = totalIn - totalOut. • closing = opening + totalIn - totalOut. closingPerLedger = sum of (debit - credit) on those accounts up to to. reconciles = \ | closing - closingPerLedger\ | < 0.01. |
| Included and excluded | • A voucher counts by its net effect on cash and bank together. A move from cash to bank has a net of zero and is neither in nor out. • A cheque is cash when it clears, not when it is received: the clearing entries carry the type 'cheque_clearance' and appear under that line, dated the clearing date. • Only active accounts are included. Cash that sits in an inactive cash or bank account falls outside both figures. • Labels: receipt 'Received from customers', payment 'Paid to vendors', expense 'Expenses paid', contra 'Moved between cash and bank', journal 'Journal entries', opening 'Opening balances'. |
| Controls and reconciliations | • reconciles must be true; the closing equals the balances of the cash and bank accounts in the trial balance and the closing of the cash and bank book. • The IFRS statement of cash flows starts from the same opening cash and ends at the same closing cash. |
| Output columns and exports | API: opening, lines[{voucherType, label, inflow, outflow, net, count}], totalIn, totalOut, net, closing, closingPerLedger, reconciles, accounts. Screen with CSV. |
