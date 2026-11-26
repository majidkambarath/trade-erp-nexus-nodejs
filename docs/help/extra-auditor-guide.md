---
title: "A guide for auditors"
audience: client
source: Written by hand, 27 Nov 2026
screens: ["/accounting-setup", "/vat-reports", "/financial-statements", "/ledger-reports", "/ageing", "/stock-reports", "/bank-reconciliation"]
questions:
  - "what does an auditor need"
  - "how do I give my auditor access"
  - "where is the audit trail"
  - "who changed this record"
  - "can a posted invoice be deleted"
  - "how do I download the FTA audit file"
  - "where is the FAF file"
  - "how do I check the books are complete"
  - "how long are records kept"
  - "is the audit log editable"
---

# A guide for auditors

This page is for the person who checks the books: an external auditor, a tax agent, or the business's own
reviewer. It says where each record is, what cannot be changed, and how to prove the books are complete.

## Giving the auditor access

Add the auditor as a person under People > Users and roles, with a role that can only look: the ready-made
Viewer role, plus the Audit log permission (Accounting setup > Audit log needs it) and the Financial reports and
VAT permissions if they are to see the statements and the VAT return. A role that can only look cannot post,
approve, change or delete anything, whatever screen it opens.

## The audit trail: who did what, and what it was before

Accounting setup > **Audit log** lists every change, newest first:

- who made it (their sign-in), when, and from which internet address;
- what it was (a customer, a supplier, an item, an account, a tax code, a setting, a user, a role, a branch,
  a document, a voucher);
- for a change, **each field it touched, with the old value and the new one**. A secret (a password, a key) is
  shown only as "changed", never with its value.

Filter it by what, by action, by who and by dates. Every document also has its own **Audit trail** button (on
its row and on its screen): what it posted to the ledger, the stock it moved, the payments set against it, and
every step of its life.

**The audit log cannot be changed or deleted** by anyone, including the business's own administrators: the
system refuses it.

## Nothing posted is ever deleted

- An **approved** invoice, return or note cannot be deleted. Choosing Delete on one **cancels** it: everything
  it posted (to the ledger, to stock, to the customer's or supplier's balance) is reversed, and the document
  stays in its list marked **Cancelled**, with who cancelled it, when and why. Its number stays used.
- A draft may be deleted. So may a customer, supplier, item or unit that has never been used. Anything that
  is deleted is first **kept whole** under Audit log > **Deleted records**, with who deleted it and when.
- A customer, supplier, item, unit or staff member that appears on any document, voucher or ledger entry
  **cannot be deleted**; it can only be switched off.
- A voucher that is deleted is kept as cancelled, and its ledger entries and its lines on the customer's or
  supplier's statement are reversed by matching entries, never removed.

## Numbering

Accounting setup > **Numbering** shows every document type's number series, every number ever given out, and
**Deleted & gaps**: a report that explains any gap in a sequence (a draft deleted before approval, a number
retired). A tax invoice, a credit note or a self-billed invoice number is never given out twice.

## Periods that are closed stay closed

- **Months and years** are closed under Accounting setup > Fiscal years. Nothing dated in a closed month or
  year can be entered, changed, approved or deleted.
- A **VAT return** that has been finalised or filed locks its period the same way. A finalised return can be
  reopened by someone with the VAT permission, and that is in the audit log; a filed one cannot.

## VAT

Reports > **VAT**:

- **Return**: the VAT 201 boxes for any period, worked out from the approved documents, with each box's
  documents one click away, and a reconciliation of the return to the VAT accounts in the ledger.
- **By tax code and emirate**: the period's taxable amounts and VAT for each tax code, and the standard-rated
  supplies by emirate (a branch can have its own emirate). Both can be downloaded as CSV.
- **Saved returns**: each return as it was prepared, with who prepared, finalised and filed it. A return
  opens with its boxes, says plainly when entries dated in its period have been posted since, and downloads as
  a PDF of the stored figures.
- **FTA audit file**: the FTA VAT Audit File (FAF) for any period, generated from the books when it is asked
  for: company information, the purchase listing, the supply listing and the general ledger, each with its
  totals. Its VAT totals are the return's.

## Tax invoices and credit notes

A tax invoice carries the seller's and the buyer's names, addresses and TRNs, the date, the number, each line's
value, rate and VAT, and the totals in words. A **credit or debit note** names the invoice it corrects and
that invoice's date, says why it was issued, and states the value on the original invoice, the correct value,
the difference and the tax on the difference. A **self-billed** invoice (one the business raises for a supplier
under a written agreement) is titled "Tax Invoice raised by buyer", carries its own number, names both sides
and the agreement, and its credit note is a "Tax Credit Note created by buyer".

## Checking that the books are complete

1. **Trial balance** (Reports > Statements): debits equal credits.
2. **VAT**: the return's reconciliation rows agree with the VAT accounts; any difference is listed.
3. **Stock**: Reports > Stock > valuation agrees with the Inventory account in the ledger, and says so.
4. **Customers and suppliers**: Reports > Ageing totals agree with the customer and supplier accounts in the
   ledger; the difference (returns and advances not yet set against an invoice) is shown.
5. **Bank**: Finance > Reconcile proves each bank account's statement balance against the ledger as at a date.
6. **Numbering**: Deleted & gaps explains every gap.
7. **Audit log**: any change to a master, a setting or a user is there, with its old and new values.

## How long records are kept

Nothing in the application deletes the books. Settings > Business rules > **Record keeping** says how long they
must be kept: five years after the end of the tax period, or fifteen for records about real estate. For backups and
how a restore is tested, ask the business for its backup record.

## Versions

The version in use is shown on the sign-in page and under Settings. What changed in each version is under
Settings > **What's new**.
