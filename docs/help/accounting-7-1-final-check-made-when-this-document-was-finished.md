---
title: "Final check made when this document was finished"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 7.1
---

# Final check made when this document was finished

Other people were still changing the system while this document was written.

Table 67. Final check

| Area | What was found | What this document says |
|---|---|---|
| Currency master and foreign receipts and payments | Built (phase 1). A currency master with a base currency, a dated rate history and a tolerance setting. A foreign receipt or payment carries the currency, the foreign amount and the stamped rate, and posts in AED. There is no fallback rate (NO_RATE); a rate more than the tolerance (5 percent by default) from the master rate needs a reason. | Section 3.17 (rules and example), report 4.24 (register), Appendix A. |
| Foreign invoices, exchange gain or loss, revaluation | Not built; the code calls them phase 2. Other vouchers refuse a foreign currency. | Sections 1 and 7 (limitation 12). |
| Dashboard | Built. The five tabs (summary, analytics, sales, inventory, reports) read the ledger, the documents and the stock records. | Report 4.23 and Appendix A. |
| Changes made by others during writing | Manual stock adjustments are now costed, numbered SA-YYYY-NNNN and posted (Stock adjustment against Inventory), except the quantity typed when an item is created and adjustments made while posting was off. The stock valuation counts a posted adjustment on both sides of its first line, so the book reconciles (test added). Switching posting on now also posts stored account opening balances, once, and the automatic switch-on is written to the audit log. The old monthly VATReport collection is no longer written. | Sections 2.5, 3.14, 3.16, 4.13, 4.15, limitation 6 and Appendix B (17 series). |

Every section that depends on the changed code (stock adjustment service, stock and inventory controllers, number series, posting service, chart of accounts service, default chart service, transaction service) was re-read against the code and corrected. The document describes the code as it stood on 5 October 2026.
