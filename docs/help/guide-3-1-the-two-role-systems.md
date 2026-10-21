---
title: "The two role systems"
audience: client
source: Trade-ERP-Product-Guide 3.1
screens: ["/users"]
questions:
  - "what can each role do"
  - "who can approve"
review: "Predates the shipped RBAC. Roles ARE enforced by the server now: users and roles screen, per-module permissions, approval limits, roles per branch."
---

# The two role systems

| Layer | Roles | Where it comes from | Effect today |
|---|---|---|---|
| Server role (account type) | super_admin, admin, manager, operator, viewer | Stored on each user account. New accounts default to viewer. The role is carried in the sign-in token. | Checked on a small set of actions (3.2). Everything else is open to any signed-in user. |
| Menu role | Admin, Accountant, Purchase Officer, Sales Executive, Inventory Manager, HR | Role lists in the menu configuration decide which tabs each role sees. | Not applied. The screen treats every signed-in user as Admin, so every tab is shown to everyone. |
| Permission list | users_manage, inventory_manage, transactions_manage, transactions_approve, financial_reports, system_settings, backup_restore | Given to every account when it is created or its type changes. | None. The check exists but no route uses it. |

| Note. The menu role names do not match the server role names, and joining them is a product decision not yet taken. Until then the server rules in 3.2 are the real protection. Section 8 lists the mapping and a user-management screen as planned work. |
|---|
