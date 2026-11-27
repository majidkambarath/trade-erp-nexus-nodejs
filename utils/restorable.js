// Which deleted records can be put back from DeletedRecord, and who may do it (pure: no database).
//
// Only MASTERS that come back whole are restorable: their record is everything there is of them. A trade document or a
// voucher is not: its number was released or retired when it went, and another document may carry it now. Neither is
// a ledger account, an account group, a card or a van (each carries its own place in the chart), a person, a role or a
// branch (who may sign in and see what is not undone from a list), or a contact (it lives inside a customer's own
// record too). The frontend twin is src/lib/restorable.js.

// entity -> { model: module path from the backend root, permission: the key that ADDS such a record }
const RESTORABLE = {
  Customer: { model: "models/modules/customerModel", permission: "sales.create", label: "Customer" },
  Vendor: { model: "models/modules/vendorModel", permission: "purchase.create", label: "Vendor" },
  Stock: { model: "models/modules/stockModel", permission: "inventory.create", label: "Item" },
  Category: { model: "models/modules/categoryModel", permission: "inventory.create", label: "Category" },
  UOM: { model: "models/modules/uomModel", permission: "inventory.create", label: "Unit" },
  UOMConversion: { model: "models/modules/uomConversionModel", permission: "inventory.create", label: "Unit conversion" },
  Staff: { model: "models/modules/staffModel", permission: "staff.manage", label: "Staff record" },
  DocumentType: { model: "models/modules/documentTypeModel", permission: "accounts.manage", label: "Document type" },
  TaxCode: { model: "models/modules/financial/taxCodeModel", permission: "accounts.manage", label: "Tax code" },
  CostCentre: { model: "models/modules/financial/costCentreModel", permission: "accounts.manage", label: "Cost centre" },
  Budget: { model: "models/modules/financial/budgetModel", permission: "accounts.manage", label: "Budget" },
  ExpenseCategory: { model: "models/modules/financial/expenseTypeModel", permission: "finance.create", label: "Expense category" },
  BankMaster: { model: "models/modules/banking/bankingModels", exportName: "BankMaster", permission: "banking.manage", label: "Bank" },
  CardType: { model: "models/modules/banking/bankingModels", exportName: "CardType", permission: "banking.manage", label: "Card type" },
  Department: { model: "models/modules/hr/departmentModel", permission: "hr.manage", label: "Department" },
  LeaveType: { model: "models/modules/hr/leaveTypeModel", permission: "hr.manage", label: "Leave type" },
  SalaryComponent: { model: "models/modules/hr/salaryComponentModel", permission: "hr.payroll", label: "Salary component" },
  PriceList: { model: "models/modules/vansales/priceListModel", permission: "vansales.manage", label: "Price list" },
  Promotion: { model: "models/modules/vansales/promotionModel", permission: "vansales.manage", label: "Promotion" },
  ContainerType: { model: "models/modules/vansales/containerTypeModel", permission: "vansales.manage", label: "Container type" },
  VanRoute: { model: "models/modules/vansales/vanRouteModel", permission: "vansales.manage", label: "Van route" },
  Lead: { model: "models/modules/crm/leadModel", permission: "crm.create", label: "Enquiry" },
  Vehicle: { model: "models/modules/garage/vehicleModel", permission: "garage.create", label: "Vehicle" },
  Bay: { model: "models/modules/garage/bayModel", permission: "garage.manage", label: "Bay" },
  GarageService: { model: "models/modules/garage/garageServiceModel", permission: "garage.manage", label: "Service" },
  ProcessRoute: { model: "models/modules/processRouteModel", permission: "inventory.adjust", label: "Process route" },
};

// why a record cannot come back, in words a person reads beside it
const WHY = {
  Transaction: "A trade document's number was released when it was deleted, so it is not put back; enter it again.",
  Quotation: "A document's number was released when it was deleted, so it is not put back; enter it again.",
  DeliveryNote: "A document's number was released when it was deleted, so it is not put back; enter it again.",
  TradeOrder: "A document's number was released when it was deleted, so it is not put back; enter it again.",
  GoodsReceipt: "A document's number was released when it was deleted, so it is not put back; enter it again.",
  LedgerAccount: "An account is part of the chart: add it again in the chart of accounts.",
  AccountGroup: "A group is part of the chart: add it again in the chart of accounts.",
  CardMaster: "A card carries its own ledger account: add it again in Banking.",
  Van: "A van carries its own cash account: add it again in Vans and routes.",
  Admin: "Who may sign in is not undone from a list: add the person again in Users and roles.",
  Role: "Roles are not undone from a list: add the role again in Users and roles.",
  Branch: "Branches are not undone from a list: add the branch again in Settings.",
  Contact: "A contact is kept inside its customer or supplier too: add the person again there.",
};
const DEFAULT_WHY = "This kind of record is not put back from the deleted records.";

const restorableOf = (entity) => (typeof entity === "string" && Object.prototype.hasOwnProperty.call(RESTORABLE, entity) ? RESTORABLE[entity] : null);
const whyNot = (entity) => (restorableOf(entity) ? null : WHY[entity] || DEFAULT_WHY);

module.exports = { RESTORABLE, restorableOf, whyNot };
