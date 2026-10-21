---
title: "A.5 Setup and posting (the calls that feed the reports)"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping A.5 Setup and posting (the calls that feed the reports)
---

# A.5 Setup and posting (the calls that feed the reports)

Table 73. Setup and posting

| Method and path | Parameters | Notes |
|---|---|---|
| GET, PUT /accounting/account-configuration | PUT body { mappings: [{ configKey, targetAccount or targetGroup }] } | The posting map. PUT: admin or super admin. |
| GET /accounting/account-configuration/readiness; PUT /account-configuration/posting | PUT body { enabled } | Mappable keys, mapped, missing; the switch (runs the catch-up when turned on). |
| GET, POST /accounting/fiscal-years; POST /:id/close, /:id/reopen | code, startDate, endDate | Period lock. |
| GET /accounting/number-series; GET, PUT /accounting/settings; GET, POST, PUT /accounting/tax-codes | settings: creditControl, returnWindowDays, requireReturnLink, fiscalYearStartMonth, profile | Counters, company settings, tax codes. |
| POST /transactions/transactions; PATCH /transactions/transactions/:id/process; DELETE /transactions/transactions/:id | type, partyId, partyType, items, charges, discount, date, returnOf; process body { action = approve, reject, cancel; riskAck_limit_party_credit } | Draft (priced by the server), approval, reversal. |
| POST /vouchers/vouchers; PUT, DELETE /vouchers/vouchers/:id; PATCH /vouchers/vouchers/:id/approve | voucherType and the fields of that type; forceUpdate | Receipt, payment, journal, contra, expense, debit_note, credit_note. Edit reverses and reposts. |
| GET /banking/cheques; POST /banking/cheques/:id/clear, /bounce, /cancel | clearedOn, note; reason, on | Cheque register. |
| GET /opening-balances/summary; PUT /go-live; GET, POST, DELETE /accounts, /parties, /stock | date, lines or rows | Go-live set-up. |
| PUT /stock/stock/:id; PATCH /stock/stock/:id/quantity; POST /inventory/inventory | currentStock (and purchasePrice as the cost of a gain); quantity; stockId (item code), quantity (signed change), eventType, referenceNumber, unitCost, batchNumber, expiryDate | Manual stock adjustment: costed, batched and posted when posting is on. |
