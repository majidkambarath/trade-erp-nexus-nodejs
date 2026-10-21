---
title: "Tracing a figure to its source"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 5.3
---

# Tracing a figure to its source

Table 55. The audit path

| Report figure | → | Account (click it, or the account ledger) | → | Entry with its voucher number | → | Voucher impact: the balanced lines | → | The document or voucher itself |
|---|---|---|---|---|---|---|---|---|

1. **A ledger report figure.** Open the account ledger for the account and period (section 4.12). The rows are the live entries; their sum is the figure.

2. **An entry.** Each row carries the voucher number (for example SO-2026-0001) and type. The day book lists the voucher; the voucher impact (/accounting/reports/voucher/:id) lists all its lines and whether they balance.

3. **A document.** Open the invoice or voucher by number. A trade document shows its lines, tax treatment, header charges, pricing block and paid and outstanding amounts; the stock movements it caused are in the item ledger under the same number.

4. **A VAT box.** Open the VAT documents detail for the period, filtered by treatment or direction; the rows add up to the box.

5. **A stock value.** Open the item ledger for the item; the closing row is the valuation figure. The reconciliation shows the ledger side by source.

6. **A mapping question.** The account was chosen by the posting map at the time of posting; the entry stores the account's name and code as they were, even if the map has since changed (section 2.6).
