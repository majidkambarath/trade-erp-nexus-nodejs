---
title: "Changing a mapping, and what changes"
audience: client
source: Trade-ERP-Reports-and-Account-Mapping 2.6
screens: ["/accounting-setup"]
questions:
  - "can I change an account mapping"
  - "what happens if I remap an account"
---

# Changing a mapping, and what changes

A mapping is changed with PUT /accounting/account-configuration, body { mappings: [{ configKey, targetAccount | targetGroup }] }. Sending no target clears the mapping. Reading is open to any signed-in admin; changing needs the admin or super admin role. The change is written to the audit log as ACCOUNT_MAPPING_CHANGED.

Table 12. Effect of changing a mapping

| What changes | What does not change |
|---|---|
| • Documents and vouchers saved after the change post to the new account. • Reports that read the map at the time they run use the new mapping for every period: the profit and loss decides what is revenue and what is a direct cost from sales-income-group, direct-income-group, purchase-expense-group and direct-expense-group; the cash and bank book, cash flow and IFRS statements decide what is cash or bank from the two cash keys. • An account that a key points at cannot be deactivated (ACCOUNT_IN_USE_BY_CONFIGURATION) until the key is remapped. | • Ledger entries already posted stay on the account they were posted to. Each entry stores the account id, and a copy of the account's name and code at the time. • Documents already approved are not re-posted. Reversing and editing a document reverses the entries it actually made, not the entries the current map would make. • Closed fiscal years stay closed. |

| **Note.** Because the group keys are read when a report runs, moving a group key changes how past periods are presented (for example which accounts are revenue), even though no entry has changed. The accountant should treat a change to a group key as a change of reporting policy. |
|---|
