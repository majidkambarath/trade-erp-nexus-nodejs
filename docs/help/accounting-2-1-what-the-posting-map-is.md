---
title: "What the posting map is"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.1
screens: ["/accounting-setup"]
questions:
  - "what is the posting map"
  - "how are accounts mapped"
  - "account configuration"
---

# What the posting map is

No posting code in the system names a ledger account. Each leg of each posting asks for a **configuration key** (for example vat-sales), and the company's posting map says which ledger account, or which account group, that key stands for. This is what lets a company use its own chart of accounts while every event still posts to a defined place.

| **Rule.** An unmapped key fails loudly. AccountConfigService.resolveAccount throws ACCOUNT_NOT_CONFIGURED (HTTP 422) with the message 'Account not configured: "<key>". Map it under Accounting > Account configuration.' There is deliberately no fallback account, so a posting can never land somewhere nobody chose. |
|---|

**Shape and choice are kept apart.** The canonical list of keys owns each key's display name, category, kind and parent. The company owns only the target account or group. When the list is re-merged into the company's settings, the company's targets are matched by key and kept.

**Kinds.** A key of kind group maps to an account group (a family of accounts). A key of kind account maps to one ledger account. A key of kind none is a header or an implied rule and cannot be mapped.

**Mapping is checked.** A group key accepts only a group whose category equals the key's category (CATEGORY_MISMATCH otherwise). An account key accepts only an active account whose type equals the key's category in lower case (for example vat-sales needs a liability account). A key of kind none is refused (NOT_MAPPABLE). An unknown key is refused (UNKNOWN_CONFIG_KEY).

**All accounts are found before anything is written.** When a document is approved, the posting service resolves every account the document needs first. If one is missing, nothing is written and, because the approval runs in one database transaction, the stock movement is rolled back with it. A leg whose amount is zero needs no account, so a mapping that is only used for freight or round-off is only required by documents that have freight or round-off.
