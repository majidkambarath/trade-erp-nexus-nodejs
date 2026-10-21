---
title: "A.2 VAT return"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping A.2 VAT return
---

# A.2 VAT return

Table 70. VAT

| Method and path | Parameters | Notes |
|---|---|---|
| GET /vat-return/return | from, to (both required) | Live boxes with reconciliation. |
| GET /vat-return/detail | from, to, direction = input or output, kind, search, page, limit (max 200) | Documents behind the boxes. |
| GET /vat-return/returns, /returns/:id | id | Saved returns. |
| POST /vat-return/returns | body { from, to, notes } | Saves a draft. Admin or super admin. |
| POST /vat-return/returns/:id/finalize | body { allowUnclassified } | Admin or super admin. |
| POST /vat-return/returns/:id/file | body { reference, filedOn } | Admin or super admin. |
| DELETE /vat-return/returns/:id | id | Drafts only. |
| GET /reports/vat, /reports/vat/:id; POST /reports/vat/:id/finalize, /submit; DELETE /reports/vat/:id | id | Legacy VATReport collection, no longer written (not the VAT return); not used for filing. |
