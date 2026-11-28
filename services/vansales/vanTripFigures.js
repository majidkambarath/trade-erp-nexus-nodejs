// What each van trip's documents were worth, read the same way by the profit report and the van analysis.
const Transaction = require("../../models/modules/transactionModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const rules = require("../../utils/vanSales");

const round2 = rules.round2;

/** The net value of a document: its total less the tax on its lines and charges. */
const netOf = (d) => round2(Number(d.totalAmount || 0) - Number(d.pricing?.lineVat || 0) - Number(d.pricing?.chargesVat || 0));

/**
 * What each trip sold and took back (approved documents, net of VAT) and the cost of those goods from the stock
 * movements they made: Map(tripId -> { sales, cost, returns, returnsCost, invoices }).
 */
async function tripMoney(tripIds) {
  const out = new Map(tripIds.map((id) => [String(id), { sales: 0, cost: 0, returns: 0, returnsCost: 0, invoices: 0 }]));
  if (!tripIds.length) return out;
  const docs = await Transaction.find({ "vanTripRef.tripId": { $in: tripIds }, status: "APPROVED", type: { $in: ["sales_order", "sales_return"] } }).select("type totalAmount pricing vanTripRef").lean();
  const moves = docs.length ? await InventoryMovement.find({ referenceId: { $in: docs.map((d) => d._id) } }).select("referenceId cogsAmount totalValue quantity").lean() : [];
  const costOf = new Map();
  for (const m of moves) {
    const k = String(m.referenceId);
    // a sale's cost is its cost of goods; a return's is the cost it put back (stored positive both ways)
    const c = m.cogsAmount !== null && m.cogsAmount !== undefined ? Number(m.cogsAmount) : Math.abs(Number(m.totalValue) || 0);
    costOf.set(k, round2((costOf.get(k) || 0) + Math.abs(c)));
  }
  for (const d of docs) {
    const row = out.get(String(d.vanTripRef.tripId));
    if (!row) continue;
    if (d.type === "sales_order") {
      row.invoices += 1;
      row.sales = round2(row.sales + netOf(d));
      row.cost = round2(row.cost + (costOf.get(String(d._id)) || 0));
    } else {
      row.returns = round2(row.returns + netOf(d));
      row.returnsCost = round2(row.returnsCost + (costOf.get(String(d._id)) || 0));
    }
  }
  return out;
}

module.exports = { tripMoney, netOf };
