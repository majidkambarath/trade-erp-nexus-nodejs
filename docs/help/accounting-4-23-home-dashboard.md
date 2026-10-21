---
title: "Home dashboard"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.23
---

# Home dashboard

**Status: built, with real figures.** The dashboard does not hold or sample data. Amounts are AED and days are Dubai days. The page (/dashboard) loads the first screen first and the Sales, Inventory and Reports tabs when they are opened.

Table 51. Dashboard period rules (DashboardService.resolvePeriod)

| Parameter | Rule |
|---|---|
| period | week (Monday to today), month (month to date, the default), quarter (calendar quarter to date). |
| month | YYYY-MM: the whole month, or month to date for the current month. A month that has not started is refused (FUTURE_MONTH). |
| from, to | Both YYYY-MM-DD; a period that starts in the future is refused; an end date in the future is cut to today. |
| Previous period | The stretch before: the previous week for the same number of days; for the current month, the previous month up to the same day of the month (cut to its length), and for a past month the whole previous month; the previous quarter for the same number of elapsed days; for custom dates, the same number of days just before. |
| Series | The 8-month charts end with the month of the period's last day. Stock on hand now (reorder, expiring batches) is always today's. |

Table 52. Dashboard figures and where each comes from

| Figure or series | Definition | Source |
|---|---|---|
| Sales value (revenue); gross profit, margin; net profit | As the profit and loss for the period. Change % = (now - before) / before x 100, empty if before <= 0 | Ledger profit and loss (section 4.2) |
| Invoices; average invoice | Count of approved sales invoices with lines in the period (opening invoices excluded); average = sum of line values without VAT / count | Trade documents |
| Collection rate | Receipts in the period / total of the period's sales invoices (VAT included) x 100, one decimal | Receipt vouchers; trade documents |
| Ops status | Active orders = approved / all sales orders of the period; pending purchase orders = drafts / all purchase orders; low stock = items at or below reorder level / active items; new customers = created in the period / all | Trade documents; reorder; customer master |
| 8-month trend; peak | Per Dubai month: revenue, gross profit, net profit (profit and loss definitions) and purchases (approved purchase documents without VAT, net of returns); peak = month with the highest revenue | Ledger; trade documents |
| Top product; best sellers; SKU map; customer mix | Items or customers ranked by net revenue in the period, with the previous period and the last 7 months; the top four customers and 'Others' | Sales analysis |
| VAT this quarter | Output VAT, recoverable VAT and net for the calendar quarter to date ('payable', 'refundable' or 'nil'); unclassified lines; output VAT per month for 6 months | VAT return; vat-sales account |
| Needs attention | Counts: draft sales and purchase orders (any date), VAT lines without a treatment, stock value not agreeing with the Inventory account, customers over their limit, expired batches, batches expiring within 30 days | Trade documents; VAT return; valuation; party balances; expiry |
| Recent activity | The latest 8 vouchers of the day book; a sales or purchase invoice reads 'Paid' (outstanding <= 0.005), 'Part-paid' (paid above zero) or 'Unpaid'; other vouchers 'Posted' | Day book; trade documents |
| Weekly order pulse; documents created by hour | Invoices and returns approved per day for 7 days; documents and vouchers created per two-hour window and weekday over 28 days, Dubai time | Trade documents; creation times |
| Performance; category sales | Collection rate, gross margin, stock availability % (active items with stock above zero / active items); net sales by category this month against last (top 6) and the last 3 months (top 5) | As above; item master |
| Cash inflow vs outflow | Per Dubai month: net inflows and net outflows of vouchers on cash and bank accounts (a transfer between them counts as neither) | Ledger (as the cash flow report) |
| Open orders; this week | Draft sales and purchase orders (count, value); receipts and payments this week against the same stretch last week | Trade documents; vouchers |
| Order pipeline; invoice settlement | Of the period's sales orders: created, approved, with something paid, fully paid. Of its approved invoices, as they stand today: paid, part-paid, unpaid overdue, unpaid not yet due | Trade documents; ageing |
| Ageing; top vendors; collections vs invoicing | Ageing buckets at the period end (section 4.10); purchases by vendor with the change on the previous period; weekly receipts against weekly invoicing for 6 weeks | Ageing; sales analysis; vouchers |
| Inventory tab | Stock value by category with share %; top stock alerts and expiring batches; the Inventory account's balance at each month end | Valuation; reorder; expiry; ledger |
| Reports tab | Gross and net profit; VAT snapshot; monthly gross profit; day-book totals for receipts, payments, journals, contra, expenses; ageing | Profit and loss; VAT return; day book; ageing |

| **Note.** The collection rate compares cash received in the period with invoices raised in the same period. It is not a measure of how much of the invoices raised has been collected. |
|---|
