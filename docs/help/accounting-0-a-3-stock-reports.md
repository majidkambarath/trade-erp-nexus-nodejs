---
title: "A.3 Stock reports"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping A.3 Stock reports
---

# A.3 Stock reports

Table 71. Stock reports and write-off

| Method and path | Parameters | Notes |
|---|---|---|
| GET /stock-reports/valuation | asOn, categoryId, search, groupBy = item or category, includeZero | With the Inventory reconciliation. |
| GET /stock-reports/movement | from, to, categoryId, search, includeZero | |
| GET /stock-reports/item-ledger | itemId, from, to | Up to 5,000 rows. |
| GET /stock-reports/sales-analysis | from, to, groupBy = item, category or customer; direction = sales or purchases; categoryId, search | |
| GET /stock-reports/expiry; /slow-moving; /reorder; /lookups | withinDays (0 to 3,650); days (1 to 3,650); categoryId, search | Lookups gives items and categories for the filters. |
| GET /batches; POST /batches/:id/write-off | stockId, status, expiringWithinDays; body { qty, reason = expiry or damage, note } | Write-off: super admin, admin or manager. |
