---
title: "The configuration keys"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.2
screens: ["/accounting-setup"]
questions:
  - "what are the posting keys"
  - "what does vat-sales mean"
  - "which account does the system use"
---

# The configuration keys

The table lists every key: 37 in all, of which 14 are group keys, 20 single-account keys and 3 headers that cannot be mapped. The 34 mappable keys must all be mapped before posting can be switched on. 'Default target' is what the default chart maps the key to (name and code, section 2.3). 'Used by' and 'If unmapped' were read from the call sites; six mappable keys are read by no code and are marked so (limitation 8, section 7).

Table 6. All 37 configuration keys

| Key | Display name | Category | Kind | Parent | Default target | Used by (events and reports) | What breaks if unmapped |
|---|---|---|---|---|---|---|---|
| cash-account-group | Cash accounts | Asset | group | | Cash group (CASH) | Cash receipts, payments and expenses; contra (cash side, no negative cash); cash and bank book; cash flow; IFRS cash and notes. | Cash-mode vouchers cannot be saved (ACCOUNT_NOT_CONFIGURED, after one attempt to restore the defaults). Cash reports list no cash accounts. |
| bank-account-group | Bank accounts | Asset | group | | Bank group (BANK) | Bank, transfer, cheque and card vouchers; card master (terminal and debit-card accounts must be bank accounts; prepaid-card accounts are created here); contra; cash and bank book; cash flow; IFRS. | Bank-mode vouchers and the card master fail with ACCOUNT_NOT_CONFIGURED. Reports list no bank accounts. |
| account-receivable-group | Trade receivables (customers) | Asset | group | | Accounts Receivable group (AR) | Filing of 'Customer - name' and 'Advance to Vendor - name' accounts; the 'receivable' role; IFRS receivables note. | Posting still works; new party accounts are made without a group, with a legacy code (CUST or VADV + 6 characters). IFRS note empty. |
| account-payable-group | Trade payables (vendors) | Liability | group | | Accounts Payable group (AP) | Filing of 'Vendor - name' and 'Customer Advance - name' accounts; the 'payable' role; IFRS payables note. | Posting still works; new party accounts are made without a group, with a legacy code (VEND or CADV + 6 characters). IFRS note empty. |
| inventory-asset-group | Inventory | Asset | group | | Inventory group (INV) | IFRS notes only (inventories table). | The IFRS inventories note shows nothing. No posting is affected. |
| sales-income-group | Sales income | Income | group | | Sales Income group (SAL) | Profit and loss and dashboard: income accounts in this group and its sub-groups are revenue. | Revenue reads zero, all income is 'other income', gross profit is wrong. |
| purchase-expense-group | Purchases / cost of goods | Expense | group | | Cost of Goods Sold group (COGS) | Profit and loss and dashboard: expense accounts in this group and its sub-groups are direct costs. | Direct costs read zero; gross profit is overstated. |
| direct-income-group | Direct income | Income | group | | Sales Income group (SAL) | Added to sales-income-group when deciding what is revenue. | Nothing, if sales-income-group is mapped. |
| indirect-income-group | Indirect income | Income | group | | Other Income group (OI) | Not read by any code. Income outside the direct groups is other income. | Nothing. |
| direct-expense-group | Direct expenses | Expense | group | | Cost of Goods Sold group (COGS) | Added to purchase-expense-group when deciding what is a direct cost. | Nothing, if purchase-expense-group is mapped. |
| indirect-expense-group | Indirect expenses | Expense | group | | Operating Expenses group (OPEX) | Not read by any code. Expenses outside the direct groups are operating expenses. | Nothing. |
| share-capital-group | Share capital & equity | Equity | none | | none (header) | Header only. Equity is recognised by category. | Cannot be mapped (NOT_MAPPABLE). |
| pdc-receipt-group | Post-dated cheques received | Asset | group | | Post-dated Cheques Received group (PDCR) | Not read by any code. The default Cheques in Hand account sits in this group. | Nothing. |
| pdc-issue-group | Post-dated cheques issued | Liability | group | | Post-dated Cheques Issued group (PDCI) | Not read by any code. The default Cheques Issued account sits in this group. | Nothing. |
| credit-card-group | Company credit cards | Liability | group | | Credit Cards group (CC) | Card master: a credit card's liability account 'Credit Card - label' is created here; the 'creditCard' role. | A credit card cannot be added (ACCOUNT_NOT_CONFIGURED after one retry). |
| pdc-receipt | Cheques in hand (received, not yet cleared) | Asset | account | | Cheques in Hand (PDCR0001) | Cheque received: debited here until it clears; clearing, bounce and cancel. | Cheque receipts and clearings fail (after one attempt to restore the defaults). |
| pdc-issue | Cheques issued (not yet cleared) | Liability | account | | Cheques Issued (PDCI0001) | Cheque issued: credited here until it clears. | Cheque payments and clearings fail (after one attempt to restore the defaults). |
| card-charges | Card processing fees | Expense | account | | Card Processing Fees (OPEX0009) | Card receipt on a terminal whose fee is above zero: the fee is debited here. | A card receipt with a fee fails; a zero fee needs no account. |
| stock-adjustment | Stock adjustment | Expense | account | | Stock Adjustment (COGS0003) | Manual stock adjustments: the other side of Inventory. A gain credits it, a loss debits it (section 3.14). | A manual quantity change that carries a cost fails while posting is on. |
| inventory-asset | Inventory (stock on hand) | Asset | account | | Inventory Stock (INV0001) | Purchase and return; stock leg of sales and returns; re-cost; write-off; manual stock adjustment; opening stock; valuation reconciliation; day book; dashboard. | Every purchase approval fails; every sale that moves stock fails; valuation cannot be compared with the ledger. |
| opening-balance-equity | Opening balance equity | Equity | account | | Opening Balance Equity (EQ0003) | Opening balances (accounts, customers, vendors, stock) and the balance entered when an account is created. | Opening entries are refused; creating an account with an opening balance fails while posting is on. |
| purchase-group | Purchase postings | none | none | | none (header) | Header only. | Cannot be mapped. |
| vat-purchase | Input VAT | Asset | account | purchase-group | Input VAT (TAXA0001) | Input VAT on purchases, purchase returns, expense vouchers and vendor notes; VAT reconciliation; IFRS notes. | Purchases, returns and expenses that carry VAT fail; the reconciliation reports 'not mapped'. |
| rcm-purchase | Reverse-charge VAT (purchases) | Liability | account | purchase-group | Reverse-charge VAT (TAXL0002) | Not read by any code. Reverse-charge VAT is reported on the VAT return but not posted. | Nothing. |
| discount-purchase | Purchase discounts received | Income | account | purchase-group | Purchase Discounts Received (OI0002) | Header (settlement) discount on a purchase: credited here. | Fails only for a purchase with a header discount. |
| freight-purchase | Freight & handling on purchases | Expense | account | purchase-group | Freight on Purchases (OPEX0002) | Header charges on a purchase (freight, handling): debited here. | Fails only for a purchase with header charges. |
| round-off-purchase | Round-off (purchases) | Expense | account | purchase-group | Round-off Expense (Purchases) (OPEX0003) | Round-off on a purchase invoice or return. | Fails only for a document with a round-off. |
| purchase-variance | Purchase price / quality variance | Expense | account | purchase-group | Purchase Variance (COGS0002) | Not read by any code; an ordinary expense account a note may use. | Nothing. |
| sales-group | Sales postings | none | none | | none (header) | Header only. | Cannot be mapped. |
| sales-revenue | Sales revenue | Income | account | sales-group | Sales Revenue (SAL0001) | Revenue on a sales invoice (gross, before discounts); reversed by a sales return. | Every sale approval fails. |
| vat-sales | Output VAT | Liability | account | sales-group | Output VAT (TAXL0001) | Output VAT on sales and returns; customer notes; VAT reconciliation; IFRS notes; dashboard VAT series. | Sales that carry VAT fail. |
| discount-sales | Sales discounts given | Expense | account | sales-group | Sales Discounts Given (OPEX0001) | Line and header discounts on a sale: debited here. | Fails only for a sale with a discount. |
| freight-sales | Freight & handling recovered | Income | account | sales-group | Freight Recovered (OI0001) | Header charges on a sale: credited here. | Fails only for a sale with header charges. |
| round-off-sales | Round-off (sales) | Expense | account | sales-group | Round-off Expense (Sales) (OPEX0004) | Round-off on a sales invoice or return. | Fails only for a document with a round-off. |
| cogs | Cost of goods sold | Expense | account | sales-group | Cost of Goods Sold (COGS0001) | Cost-of-goods leg of a sale and its reversal on a return; re-cost after a back-dated purchase; left out of the day book amount. | Every sale that moves stock fails. |
| write-off-expiry | Stock written off - expiry | Expense | account | sales-group | Stock Write-off - Expiry (COGS0004) | Stock write-off for expiry: debited here. | A write-off for expiry fails while posting is on (its stock movement is rolled back). |
| damage-loss | Stock written off - damage / loss | Expense | account | sales-group | Stock Write-off - Damage (COGS0005) | Stock write-off for damage: debited here. | A write-off for damage fails while posting is on. |
