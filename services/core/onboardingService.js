const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Stock = require("../../models/modules/stockModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");

// "Getting started": which first steps this organisation has already taken, read from the books themselves so a
// step done any way (a guide, an import, a colleague) counts. Read-only, booleans only - never a count or a name.
// A step is listed only to a person whose role holds the key that would let them take it, so nobody is shown a
// step they could never finish. Each step names the guide that teaches it (src/guides on the frontend).
const STEPS = [
  { id: "customer", guide: "add-customer", needs: "sales.view", done: () => Customer.exists({}) },
  { id: "vendor", guide: "add-vendor", needs: "purchase.view", done: () => Vendor.exists({}) },
  { id: "item", guide: "add-item", needs: "inventory.view", done: () => Stock.exists({}) },
  { id: "sale", guide: "create-sales-order", needs: "sales.view", done: () => Transaction.exists({ type: "sales_order", isOpening: { $ne: true } }) },
  { id: "purchase", guide: "create-purchase-order", needs: "purchase.view", done: () => Transaction.exists({ type: "purchase_order", isOpening: { $ne: true } }) },
  { id: "receipt", guide: "receive-payment", needs: "finance.view", done: () => Voucher.exists({ voucherType: "receipt" }) },
];

exports.checklist = async (req) => {
  const grants = new Set(req.admin?.grants || []);
  const mine = STEPS.filter((s) => grants.has(s.needs));
  const done = await Promise.all(mine.map((s) => s.done().then(Boolean)));
  const steps = mine.map((s, i) => ({ id: s.id, guide: s.guide, done: done[i] }));
  return { steps, complete: steps.length > 0 && steps.every((s) => s.done) };
};
