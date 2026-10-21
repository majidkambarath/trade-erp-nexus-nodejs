---
title: "Sales and purchase analysis"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.18
---

# Sales and purchase analysis

| Sales and purchase analysis | Sales and purchase analysis |
|---|---|
| Question it answers | How much was sold or bought, for how much, at what cost and margin, by item, category or party? |
| Where | Screen: Stock reports > Sales analysis. API: GET /api/v1/stock-reports/sales-analysis?from=&to=&groupBy=item\ | category\ | customer&direction=sales\ | purchases&categoryId=&search=. |
| Source data | Approved trade document lines (and their parties) for revenue; inventory movements for cost. |
| Period and filters | from (default the first day of the current month) to to (default today), Dubai days. Documents are selected by document date, movements by movement date. |
| Calculation | **Sales.** For each group: • revenue = sum of (lineTotal - vatAmount) of sales invoice lines; returns = the same for sales return lines; netRevenue = revenue - returns. So revenue **excludes VAT**, is **after line discounts**, and is **net of returns**. • quantity = sold quantity - returned quantity. • cogs = sum over SALES_DISPATCH movements of cogsAmount (else totalValue) minus the totalValue of SALES_RETURN movements, for approved documents. It is the **actual cost stamped on the movements**, not an estimate. • grossProfit = netRevenue - cogs; marginPct = grossProfit / netRevenue x 100 (empty if netRevenue <= 0); sharePct = netRevenue / total netRevenue x 100. Rows are sorted by netRevenue. **Purchases.** purchased, returned, netValue = purchased - returned (VAT excluded), avgPrice = netValue / quantity, and the number of vendors. |
| Included and excluded | • Statuses APPROVED, PAID and PARTIAL (the last two are what older versions wrote) count as approved. Opening invoices are left out. • A header discount or header charge is not allocated to items, so it is not in these figures. |
| Controls and reconciliations | • Net revenue here differs from the ledger's Sales Revenue by the line discounts (the ledger posts revenue gross) and by header-level amounts. • cogs is built from the same cost figures that are posted to the cost-of-goods account for those documents; the test compares it with the sum of the cost stamped on the movements. |
| Output columns and exports | API: rows with the figures above, totals, groupBy, direction. Screen with CSV. |
