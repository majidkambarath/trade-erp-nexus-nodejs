---
title: "A.4 IFRS statements, dashboard and currencies"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping A.4 IFRS statements, dashboard and currencies
---

# A.4 IFRS statements, dashboard and currencies

Table 72. IFRS, dashboard and currencies

| Method and path | Parameters | Notes |
|---|---|---|
| GET /ifrs/financial-position; /profit-or-loss; /changes-in-equity; /cash-flows; /notes | asAt (position and notes) or from and to; from; compare = prior-year, prior-period, none | Cash flows: indirect method. |
| GET /dashboard-summary, /analytics, /sales, /inventory, /reports | period = week, month, quarter; or month = YYYY-MM; or from and to | One part per tab. |
| GET, POST /currencies; GET /currencies/rate; GET /currencies/register; GET, PUT /currencies/settings | rate: code, date; register: from, to, currency, type = receipt or payment; settings body { fxTolerancePercent } | Create and settings changes need admin or super admin. |
| GET, POST /currencies/:code/rates; PUT, DELETE /currencies/:code | rate body { rate, effectiveDate, source, note }; update body { name, symbol, decimals, isActive } | Same-day correction replaces; a used currency cannot be deleted. |
