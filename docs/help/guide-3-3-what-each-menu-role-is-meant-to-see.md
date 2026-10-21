---
title: "What each menu role is meant to see"
audience: client
source: Trade-ERP-Product-Guide 3.3
screens: ["/users"]
questions:
  - "what should each role see"
review: "Menu role names are cosmetic; the real boundary is the permission set."
---

# What each menu role is meant to see

The table is read from the menu configuration. It shows the design, not what the server enforces. A dash means the tab is hidden for that role once roles are applied.

| Menu area | Admin | Accountant | Purchase Officer | Sales Executive | Inventory Manager | HR |
|---|---|---|---|---|---|---|
| Home: Dashboard | Yes | Yes | Yes | Yes | Yes | Yes |
| Sales: Orders, Returns | Yes | - | Yes | Yes | - | - |
| Sales: Customers | Yes | - | - | Yes | - | - |
| Sales: Receivables | Yes | Yes | - | - | - | - |
| Purchase: Orders, Returns | Yes | - | Yes | Yes | - | - |
| Purchase: Vendors | Yes | - | Yes | - | - | - |
| Purchase: Payables | Yes | Yes | - | - | - | - |
| Inventory: all five tabs | Yes | - | - | - | Yes | - |
| Finance: all nine tabs | Yes | Yes | - | - | - | - |
| Accounts: all eight tabs | Yes | Yes | - | - | - | - |
| Reports: all ten tabs | Yes | Yes | - | - | - | - |
| People: Staff | Yes | - | - | - | - | Yes |
| Settings | Yes | Yes | Yes | Yes | Yes | Yes |

| Rule. Whatever the menu shows, the server decides. A hidden tab does not protect the data behind it, because the server does not read the menu roles. |
|---|
