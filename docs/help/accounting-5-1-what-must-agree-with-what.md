---
title: "What must agree with what"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 5.1
---

# What must agree with what

Table 53. Controls and reconciliations

| # | Check: what must equal what | Where it is shown | If they differ, usually |
|---|---|---|---|
| 1 | **Trial balance balances**: Sum of closing debits = Sum of closing credits | Trial balance: 'In balance' flag; general ledger totals | An entry made outside the posting code (a direct insert or import). Every posting is refused if it does not balance, so a difference is not a rounding matter. |
| 2 | **Each voucher balances**: Debits of the voucher = Credits of the voucher | Day book: 'balanced' on every row; voucher impact | A voucher with an entry added or removed afterwards by hand. |
| 3 | **Balance sheet balances**: Total assets = Liabilities + equity (including profit to date) | Balance sheet: isBalanced; IFRS position: isBalanced and difference | As check 1: the sheet balances whenever the trial balance does. |
| 4 | **Stock value = Inventory account**: Value of live stock movements, all items = Balance of the account behind inventory-asset | Stock reports > Valuation and Movement: reconciliation, split by source | The quantity typed when an item is created, or a manual adjustment made while posting was off (not posted); an item created with stock (implicit opening); a journal posted to Inventory; posting switched off for a period. |
| 5 | **Item quantity = movements**: Quantity on the item master = Sum of live movements | Valuation: 'out of sync' flag (today only) | Quantity changed without a movement, or history missing. |
| 6 | **VAT boxes = VAT accounts**: Output VAT and input VAT per documents (reverse charge excluded) = vat-sales credit - debit and vat-purchase debit - credit in the period | VAT return: reconciliation rows | Posting off for part of the period; a journal to a VAT account; a document edited after a return was saved; reverse-charge VAT (reported, not posted). |
| 7 | **Cash flow closing = cash and bank ledger**: Opening + inflows - outflows = Sum of (debit - credit) on active cash and bank accounts up to the end | Cash flow: 'reconciles'; cash and bank book totals | Arithmetic only in normal use. An inactive cash or bank account is outside both sides. |
| 8 | **IFRS cash flow closes at the ledger**: Opening cash + net increase = Cash and bank per ledger | IFRS cash flows: reconciles and difference, for both columns | A one-sided entry; cash in an account that has been switched off is shown as 'Other' and still reconciles. |
| 9 | **Party sub-ledger = control accounts**: Customers' net and vendors' net (party balances) = Group totals of Accounts Receivable and Accounts Payable | Party balances; chart of accounts; trial balance (section 5.2) | Advances are filed with the opposite group; a hand journal to a party account; a party account renamed or merged by hand. |
| 10 | **Ageing = party balance**: Ageing total (open invoices) = Party balance (ledger) | IFRS notes: 'not set against invoices' | Receipts and payments kept on account, returns, notes without an invoice reference. The difference is these amounts. |
| 11 | **Statement closing = party account**: Statement closing = Party account balance in the trial balance | Statement of account | A vendor's advance account is not read by the vendor statement; with posting off the statement is built from documents. |
| 12 | **Profit and loss = trial balance**: Net profit of the period = Income - expenses of the trial balance for the same days | Profit and loss; trial balance | Different date handling at the edges of the period (section 7). |
| 13 | **Balance sheet profit = P&L profit**: Profit to date = Sum of net profit of all periods from the first entry | Balance sheet | None expected: the balance sheet adds the profit of every period from the first entry. |
| 14 | **IFRS profit = ledger profit**: Profit for the period (IFRS) = Net profit (profit and loss) | IFRS profit or loss | None expected: the IFRS statement is built from the profit and loss. |
| 15 | **Equity statement = position**: Closing total equity of the changes statement = Equity of the statement of financial position | IFRS changes in equity: reconciles | A one-sided entry. |
| 16 | **Sales analysis cost = cost posted**: Cost of goods in the sales analysis = Cost-of-goods account movement from sales and sales returns | Compare the two reports | Cost of goods written off or adjusted by a journal; a re-cost not yet run. |
| 17 | **Opening trial balance**: Debits of all opening entries = Credits of all opening entries | Opening balances: summary 'balanced'; Opening Balance Equity shows the difference | None expected: the difference is posted to Opening Balance Equity by construction. |
| 18 | **Currency register = vouchers**: AED total in the register = AED totals of the same posted vouchers | Currency register | Cancelled and bounced vouchers are listed but not totalled. |
| 19 | **Dashboard = reports**: A dashboard figure = The report it links to | Dashboard cards link to the report | None expected; the tests compare the monthly series with the reports. |
| 20 | **Numbers are unique**: Voucher and document numbers = Number series counters | Number series list | Gaps are possible (a rolled-back save); duplicates are not. |
