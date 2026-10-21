---
title: "VAT return (FTA form VAT 201)"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.13
---

# VAT return (FTA form VAT 201)

| VAT return | VAT return |
|---|---|
| Question it answers | What are the figures for each box of the UAE VAT return for a period, and do they agree with the VAT accounts? |
| Where | Screen: VAT return (/vat-reports), tabs Return, Documents, Saved returns. API: GET /api/v1/vat-return/return?from=&to=; saved returns under /api/v1/vat-return/returns. |
| Source data | Approved trade documents (invoices and returns, with their lines and header charges), approved ledger-based expense vouchers, and approved ledger-based debit and credit notes. Tax codes (kind). The company profile (emirate). |
| Period and filters | from and to are both required Dubai days, from not after to. Documents are selected by their date. |
| Calculation | **1. Treatment of a line.** kind = the tax-code kind saved on the line when it was priced (taxKind); if none, 'standard' when the line has a VAT percent or amount above zero; otherwise 'unclassified'. **2. Taxable value of a line** = taxableAmount (the value after the line discount); if that and the VAT are zero, gross - discount; if still zero, quantity x price. Header charges: taxable = charge amount, kind 'standard' if the charge has VAT, otherwise 'unclassified'. **3. Direction and sign.** Sales invoice +, sales return - (output). Purchase invoice +, purchase return - (input). Expense voucher + (input). Customer credit note - and customer debit note + (output); vendor debit note - and vendor credit note + (input). The taxable value and the VAT both take the sign, so a return or a note is **netted into the box of the supply it corrects**. **4. Reverse charge.** For a line of kind reverse_charge the VAT counted is rcmVat = round(\ | taxable\ | x percent / 100), using the line's percent, or 5 percent if the line has none; the line's own VAT is counted as zero. **5. Boxes** (table below): each line adds its taxable value and VAT to one box, or to 'unclassified' or 'not reported'. **6. Totals.** Box 8 = boxes 1a to 1g, 3, 4, 5. Box 11 = boxes 9 and 10. Box 12 = VAT of box 8. Box 13 = VAT of box 11. Box 14 = box 12 - box 13: payable if positive, refundable if negative. |
| Included and excluded | • **Emirate rule.** Standard-rated supplies are all placed in the one box 1a to 1g that matches the **company's own emirate** (Settings > company profile; 'Dubai', box 1b, if it is blank or not one of the seven). The code does not look at the customer's emirate or the place of supply. • **Unclassified lines.** A 0 percent line with no tax code is not guessed into zero-rated or exempt. It is counted, listed (up to 25 lines) and left out of every box. • **Not reported.** Out-of-scope lines (both directions) and zero-rated or exempt purchases appear in no box and are counted in 'not reported'. • **Not tracked.** Box 2 (tourist refunds), box 6 (goods imported) and box 7 (import adjustments) are listed as not tracked rather than shown as zero. • **Excluded.** Drafts, rejected and cancelled documents, opening invoices, and expense and note vouchers in the older (non-ledger) format. |
| Controls and reconciliations | • **Reconciliation to the VAT accounts.** Output VAT per documents = sum of the line VAT of output lines that are not reverse charge. Per ledger = credit - debit on the vat-sales account in the period. Input VAT per documents = the same for input lines; per ledger = debit - credit on vat-purchase. Difference = documents - ledger; 'agrees' when its size is below 0.01. • Typical causes of a difference: posting switched off for part of the period, a journal posted to a VAT account, a reverse-charge amount (reported but not posted), a document edited after a return was saved. |
| Output columns and exports | API: boxes[{box, label, amount, vat}], totals{outputVat, recoverableVat, netPayable}, unclassified{count, amount, vat, lines}, notReported, notTracked, reconciliation, emirate, currency. Screen: the box table with print and CSV. |

Table 45. The boxes and the exact source of each (VatReturnService.compute)

| Box | Label | Amount column (value without VAT) | VAT column |
|---|---|---|---|
| 1a | Standard-rated supplies in Abu Dhabi | Output standard-rated taxable value, only if the company's emirate is Abu Dhabi | Their VAT |
| 1b | Standard-rated supplies in Dubai | As 1a, when the emirate is Dubai (also the default) | Their VAT |
| 1c, 1d | Sharjah, Ajman | As 1a, for that emirate | Their VAT |
| 1e, 1f, 1g | Umm Al Quwain, Ras Al Khaimah, Fujairah | As 1a, for that emirate | Their VAT |
| 3 | Supplies subject to the reverse charge | Taxable value of reverse-charge lines, output and input | rcmVat of those lines |
| 4 | Zero-rated supplies | Output zero_rated taxable value | 0 |
| 5 | Exempt supplies | Output exempt taxable value | 0 |
| 8 | Total supplies | Sum of 1a to 1g, 3, 4, 5 | Sum of their VAT |
| 9 | Standard-rated expenses | Input standard taxable value (purchases, expenses, vendor notes) | Their VAT |
| 10 | Expenses subject to the reverse charge | Input reverse_charge taxable value | rcmVat |
| 11 | Total expenses | Sum of 9 and 10 | Sum of their VAT |
| 12 | Total VAT due | none | Box 8 VAT |
| 13 | Recoverable input VAT | none | Box 11 VAT |
| 14 | Net VAT payable or refundable | none | Box 12 - box 13 |
| 2, 6, 7 | Tourist refunds, goods imported, import adjustments | Not tracked | Not tracked |

### 4.13.1 Saved returns: draft, finalised, filed

Table 46. Saved returns (VatReturnService)

| Action | Allowed from | What happens | Refused when |
|---|---|---|---|
| Save draft (POST /returns) | any period without a final return | The live figures for the period are stored as a DRAFT named VAT-<from>..<to>. Saving the same period again replaces the draft. | The period overlaps a FINALIZED or FILED return (PERIOD_OVERLAP). |
| Finalise (POST /returns/:id/finalize) | DRAFT | The figures are recalculated for the stored period and stored as the record; status FINALIZED, with time and user. | Not a draft (NOT_DRAFT); lines without a tax treatment remain, unless allowUnclassified is sent (UNCLASSIFIED_LINES). |
| File (POST /returns/:id/file) | FINALIZED | The FTA filing reference and date are recorded; status FILED. | Not finalised (NOT_FINALIZED); no reference (REFERENCE_REQUIRED). |
| Delete (DELETE /returns/:id) | DRAFT | The draft is removed. | Any other status (NOT_DRAFT). |

The stored boxes are a record: a document approved later, or edited, does not change a finalised or filed return. There is no action to reopen or amend a filed return; a correction is made in a later period.
