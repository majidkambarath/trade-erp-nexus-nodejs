// Whether a master record has history, and so may only be switched off, never deleted. A customer, supplier or item that
// appears on a document, a voucher or a ledger entry is part of the books: deleting it would leave those records naming
// nothing (and the FTA's software requirements ask for no deletion of posted records). The pattern is CostCentreService's
// `usage` / `remove`: count, and refuse with the counts and what to do instead.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");

const model = (name) => (mongoose.modelNames().includes(name) ? mongoose.model(name) : null);
const count = async (name, filter, session) => {
  const M = model(name);
  if (!M) return 0;
  const q = M.countDocuments(filter);
  return session ? q.session(session) : q;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function refuse(code, name, parts, instead) {
  const used = parts.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));
  if (!used.length) return;
  throw new AppError(`${name} cannot be deleted: it is on ${used.join(", ")}. ${instead}`, 409, code, { usage: Object.fromEntries(parts.map(([n, one]) => [one, n])) });
}

class InUseService {
  /** A customer or supplier with any document, voucher or ledger entry. */
  static async assertPartyFree(kind, party, { session } = {}) {
    const id = party._id;
    const partyType = kind === "vendor" ? "Vendor" : "Customer";
    const [documents, vouchers, entries, quotations, notes, orders] = await Promise.all([
      count("Transaction", { partyId: id }, session),
      count("Voucher", { partyId: id }, session),
      count("LedgerEntry", { partyId: id, partyType }, session),
      kind === "customer" ? count("Quotation", { partyId: id }, session) : 0,
      kind === "customer" ? count("DeliveryNote", { partyId: id }, session) : count("GoodsReceipt", { partyId: id }, session),
      count("TradeOrder", { partyId: id }, session),
    ]);
    const name = (kind === "vendor" ? party.vendorName : party.customerName) || "This party";
    refuse("PARTY_IN_USE", name, [
      [documents, "invoice or return", "invoices and returns"], [vouchers, "voucher"], [entries, "ledger entry", "ledger entries"],
      [quotations, "quotation"], [notes, kind === "vendor" ? "goods receipt" : "delivery note"], [orders, "order"],
    ], kind === "vendor"
      ? "It stays with its history; stop using it for new purchases instead."
      : "It stays with its history; set its status to Inactive instead.");
  }

  /** An item that has moved, been sold or bought, or quoted. */
  static async assertItemFree(item, { session } = {}) {
    const [movements, documents, quotations, batches] = await Promise.all([
      count("InventoryMovement", { stockId: item.itemId }, session),
      count("Transaction", { "items.itemId": item._id }, session),
      count("Quotation", { "items.itemId": item._id }, session),
      count("StockBatch", { stockId: item._id }, session),
    ]);
    refuse("ITEM_IN_USE", item.itemName || "This item", [
      [movements, "stock movement"], [documents, "invoice or return", "invoices and returns"], [quotations, "quotation"], [batches, "batch", "batches"],
    ], "It stays with its history; set its status to Inactive instead.");
  }

  /** A unit an item is counted in. */
  static async assertUnitFree(unit, { session } = {}) {
    const items = await count("Stock", { unitOfMeasure: unit._id }, session);
    refuse("UNIT_IN_USE", unit.unitName || "This unit", [[items, "item"]], "Give those items another unit first, or switch the unit off.");
  }

  /** A person on the payroll or under contract. */
  static async assertStaffFree(staff, { session } = {}) {
    const [payslips, contracts] = await Promise.all([
      count("Payslip", { staffId: staff._id }, session),
      count("EmployeeContract", { staffId: staff._id }, session),
    ]);
    refuse("STAFF_IN_USE", staff.name || staff.fullName || "This person", [[payslips, "payslip"], [contracts, "contract"]],
      "Their record stays with its history; mark them as having left instead.");
  }
}

module.exports = InUseService;
