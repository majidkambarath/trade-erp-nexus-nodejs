---
title: "VAT: tax codes, the VAT return and saved returns"
audience: client
source: Trade-ERP-Product-Guide 4.11
screens: ["/vat-return"]
questions:
  - "how do I file VAT"
  - "what is a tax code"
  - "how do I do the VAT return"
  - "VAT 201"
---

# VAT: tax codes, the VAT return and saved returns

UAE VAT is recorded line by line on every sales and purchase document, and the VAT return is built from those documents on demand. This flow shows how a line gets its treatment, how the return is read, and how a finished return is kept.

| Tax code on line | → | Document approved | → | VAT return built | → | Draft saved | → | Finalised | → | Marked filed |
|---|---|---|---|---|---|---|---|---|---|---|

| Who | Accountant prepares. Saving, finalising and marking filed need the super_admin or admin server role. Anyone signed in can read the return. |
|---|---|
| Screens | Accounts, Setup, Tax codes. Reports, VAT (Return, Documents, Saved returns). |
| Status | Available |

### Steps

1. In Setup, Tax codes, check the codes. To change a rate, add the new rate with an effective date: the rate in force on the document date is used.

2. On each order line choose the tax code. The server takes the rate and keeps a copy of the code's kind on the line, so a later change never restates an approved document.

3. Approve the documents. Approved invoices, returns and notes, and expense vouchers with VAT, feed the return. Drafts, cancelled and rejected documents and opening invoices do not.

4. Open Reports, VAT, choose the period (this quarter, last quarter, this month or your own dates) and read the Return tab, including Agrees with the ledger?. Use the Documents tab, filter No treatment, to find lines needing a code.

5. Choose Save as draft (a later draft for the same period replaces it). Choose Finalise to freeze the figures. After filing on the FTA portal choose Mark filed and enter the FTA reference and date.

### What the system checks

Returns and notes are netted into the box of the supply they correct.

A line with VAT and no tax code is standard-rated. A 0% line with no code is not guessed: it shows as No treatment and is left out of the boxes.

All standard-rated supplies go to the box of the company's own emirate (Dubai unless the profile says otherwise), because customers do not carry an emirate yet. Boxes 2, 6 and 7 show Not tracked yet, never zero.

The return is compared with the Output VAT and Input VAT accounts for the same days. A difference is reported, not hidden (posting off, VAT edited by hand, reverse-charge amounts).

A draft is refused if it overlaps a finalised or filed return. Finalising is refused while lines have no treatment, unless the user chooses Finalise anyway. Only a draft can be deleted.

Mark filed needs a finalised return and an FTA reference. It records the reference; it files nothing with the FTA.

| Rule. The VAT return is built live from approved documents, so it cannot disagree with them, and it shows when it disagrees with the ledger. A saved return stores boxes, totals and status, not the documents. |
|---|

### Tax codes and treatments

| Treatment (kind) | Meaning | Where it goes on the VAT return |
|---|---|---|
| Standard | Taxed at the code's rate. A new company starts with Standard 5%. | Boxes 1a to 1g (sales), 9 (purchases) |
| Zero-rated | Taxable at 0%. | Box 4 (sales). Purchases: no box |
| Exempt | Not taxable and not recoverable. | Box 5 (sales). Purchases: no box |
| Out of scope | Outside the VAT system. | No box; counted in a note |
| Reverse charge | The buyer accounts for the VAT. | Boxes 3 and 10, worked out when the report runs |
| Unclassified | Not a code: a 0% line with no tax code. | Listed for the user to fix; no box |

### Accounting effect

A sale posts its VAT to Output VAT and a purchase to Input VAT, as part of the order posting (4.4, 4.5). Saving, finalising and filing a return post nothing: the return is a statement built from documents. Reverse-charge self-assessment is not posted to the ledger today (section 8).

### Exceptions and how to correct

| Situation | How to correct it |
|---|---|
| A sale was taxed with the wrong code | While it is a draft, correct the line and approve. After approval, return or credit it as the case requires. |
| A line shows No treatment | Open the Documents tab, filter No treatment, and give the line a tax code before finalising. |
| The return does not agree with the ledger | Read the difference: posting off, hand-edited VAT or reverse charge. Correct the cause and reopen the Return tab. |
| A finalised return needs a change | It cannot be edited or deleted. Prepare the correction in the next period, as the FTA allows. |
