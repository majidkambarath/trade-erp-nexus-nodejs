---
title: "Trial balance"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 4.1
screens: ["/financial-statements"]
questions:
  - "why is my trial balance out"
  - "what is on the trial balance"
  - "debits do not equal credits"
---

# Trial balance

| Trial balance | Trial balance |
|---|---|
| Question it answers | Do total debits equal total credits, and what is the balance of every account at the end date? |
| Where | Screen: Financial statements > Trial balance (/financial-statements). API: GET /api/v1/vouchers/reports/financial?reportType=trial_balance&dateFrom=&dateTo= (FinancialService.getTrialBalance). |
| Source data | Ledger entries not marked reversed, joined to the account (type, group) and the group (name, category). |
| Period and filters | dateTo (optional): entries dated up to and including it. dateFrom (optional): entries before it are the opening balance, entries from it are the period. The screen defaults to the first day of the year up to today and sends dateTo with the time 23:59:59.999. The dates are read as sent, not as Dubai days (section 7). |
| Calculation | Per account: • openingDebit, openingCredit = sums of debit and credit before dateFrom (zero if no dateFrom). • periodDebit, periodCredit = sums from dateFrom to dateTo. • category = the group's category; if the account has no group, the category implied by its account type. • openingBalance = naturalBalance(category, openingDebit, openingCredit). • balance = naturalBalance(category, openingDebit + periodDebit, openingCredit + periodCredit). • net = (openingDebit + periodDebit) - (openingCredit + periodCredit); closingDebit = net if net > 0; closingCredit = -net if net < 0. Summary: sums of the period debits, period credits, closing debits and closing credits. isBalanced = \ | sum of closingDebit - sum of closingCredit\ | < 0.01. |
| Included and excluded | • Every posted entry: invoices, returns, vouchers, notes, opening balances, cheque clearances, write-offs. • Not included: reversed entries; accounts that have no entries at all. An inactive account appears if it has entries. • Sorted by account code, then name. |
| Controls and reconciliations | • isBalanced must be true. Every posting is checked before it is written (a template that does not balance is refused with UNBALANCED_POSTING; a journal with UNBALANCED), so a difference means an entry made outside the posting code. • Closing balances equal the general ledger closing (net) and the chart-of-accounts balances: all read the same entries. • The profit and loss and the balance sheet are built from it. |
| Output columns and exports | API: trialBalance[] with accountName, accountCode, accountType, category, groupName, openingBalance, totalDebits, totalCredits, balance, closingDebit, closingCredit; and summary. Screen columns: Account, Category, Opening, Debit, Credit, Closing Dr, Closing Cr, with an 'In balance' flag. CSV with a total row. Clicking an account opens its ledger. |
