---
title: "Readiness, the posting switch and catching up earlier documents"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.5
screens: ["/chart-of-accounts"]
questions:
  - "is ledger posting on"
  - "why are my documents not in the ledger"
  - "catch up earlier documents"
---

# Readiness, the posting switch and catching up earlier documents

Ledger posting has a company-level switch. While it is off, approving a trade document still moves stock and the party's running balance, but writes no ledger entries. Two things are checked or done around the switch.

### 2.5.1 The readiness check

The readiness check lists every active key of kind group or account that has no target. The result is the number of mappable keys (34 in the canonical list), the number mapped, and the keys that are missing. **Switching posting on is refused while any key is missing** (ACCOUNT_NOT_CONFIGURED, 'Map these accounts first:...'), so an approval can never fail half way on a missing account. Clearing a mapping later does not switch posting off; it makes approvals that need that key fail until it is mapped again.

### 2.5.2 Automatic switch-on

A company that has never chosen is switched on automatically, so approved documents always have their effect. The routine (the system) runs at server start, and when the chart or a ledger report is opened. The opening calls are limited to once a minute per server process, and the minute starts only once the company's posting choice is settled (settled: posting is on, or deliberately off). The run at server start on a database with no company settings therefore does not start the minute, so the first real chart open is not skipped. Callers that arrive during a run share it. When the routine switches posting on it writes LEDGER_POSTING_ENABLED to the audit log ('Switched on automatically once every posting account was mapped; N earlier document(s) and M opening balance(s) posted').

Table 11. Automatic switch-on (the system; at most once a minute once the posting choice is settled)

| Backfill the main account of every customer and vendor | → | Posting never chosen by a person? | → | Any key unmapped? Map defaults (never over a choice) | → | All keys mapped? Switch posting on | → | Post every approved document and every stored account opening that missed the ledger | → | Write LEDGER_POSTING_ENABLED to the audit log |
|---|---|---|---|---|---|---|---|---|---|---|

A person's choice is respected. Once someone has switched posting on or off by hand, ledgerPostingTouched is true and the routine never changes the switch again.

Switching on by hand (PUT /accounting/account-configuration/posting) also runs the catch-up and returns its result.

Vouchers (receipts, payments, journals, contra, expenses, notes) post their entries when they are saved whether the switch is on or off. Only trade documents depend on the switch. A company that has posting off and records receipts therefore has credits on party accounts with no invoices to match until the switch is on and the catch-up has run. This is why the automatic switch-on exists.

### 2.5.3 Catching up earlier documents (the system)

1. Take every document with status APPROVED, of the four trade types, that is not an opening invoice, oldest first.

2. If the document already has any ledger entry (the voucher id is found on any entry, reversed or not), leave it alone and count it as skipped.

3. Otherwise, in a database transaction of its own, read the cost the stock moved at from the document's live inventory movements (cogsAmount, else the absolute totalValue) and post it exactly as an approval would.

4. A document that cannot be posted (for example, its party was deleted) is reported in the result with the reason; the others continue.

5. Then post the opening balance of every account created with one while posting was off (postStoredOpenings): the account against Opening Balance Equity, dated the day the account was created, voucher OB-<account code>. The stored figure is replaced by the entry, not added to it, and an account that already has its entry is left alone. The result carries the count as openingsPosted, and failures are added to failed.

| **Rule.** The catch-up is safe to repeat. A document that has any ledger entry is never posted a second time, an opening invoice is never posted through the sales or purchase template, and each document is posted in its own transaction, so a failure leaves nothing half written. Running it again immediately posts zero documents and zero opening balances. The catch-up does not cover manual stock adjustments made while posting was off (section 3.14). |
|---|
