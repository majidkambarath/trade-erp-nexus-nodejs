const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const inventoryMovementSchema = new mongoose.Schema({
  stockId: { 
    type: String, 
    required: true,
    index: true // For faster queries
  }, // Stock.itemId
  
  quantity: { 
    type: Number, 
    required: true 
  }, // + for IN, - for OUT
  
  previousStock: {
    type: Number,
    required: true
  }, // Stock before this movement
  
  newStock: {
    type: Number,
    required: true
  }, // Stock after this movement
  
  eventType: {
    type: String,
    enum: [
      "INITIAL_STOCK",      // Initial stock entry
      "OPENING_STOCK",      // Go-live stock quantity and cost (Opening balances)
      "STOCK_ADJUSTMENT",   // Manual stock adjustment
      "PURCHASE_RECEIVE",   // Purchase order received (GRN)
      "SALES_DISPATCH",     // Sales order dispatched
      "PURCHASE_RETURN",    // Return to supplier
      "SALES_RETURN",       // Return from customer
      "DAMAGED_STOCK",      // Damaged/expired stock
      "TRANSFER_IN",        // Transfer from another location
      "TRANSFER_OUT"        // Transfer to another location
    ],
    required: true,
  },
  
  referenceType: {
    type: String,
    enum: ["Transaction", "Adjustment", "Transfer", "Initial"],
    required: true
  },
  
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  
  referenceNumber: {
    type: String, // Transaction number for easy reference
    required: true
  },
  
  unitCost: {
    type: Number,
    default: 0
  }, // Cost per unit for this movement
  
  totalValue: {
    type: Number,
    default: 0
  }, // Total value of this movement
  
  date: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  
  notes: { 
    type: String 
  },
  
  createdBy: {
    type: String,
    required: true
  },
  
  location: {
    type: String,
    default: "MAIN"
  }, // For multi-location inventory
  
  batchNumber: {
    type: String
  }, // Track batch-wise movements
  
  expiryDate: {
    type: Date
  }, // Track expiry for specific movements
  
  // Cost audit trail: every movement records the average cost before and after, and the pool
  // it left behind, so it can be audited without replaying the ledger.
  costBasis: {
    type: String,
    enum: ["purchase", "purchaseReturn", "sale", "salesReturn", "opening", "adjustment", null],
    default: null
  },
  rateBefore: { type: Number, default: null },
  rateAfter: { type: Number, default: null },
  costPoolAfter: { type: Number, default: null },
  poolQtyAfter: { type: Number, default: null },
  // Cost of goods sold for a sales dispatch (quantity x average cost); null for other events.
  cogsAmount: { type: Number, default: null },
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  branchId: { type: String, default: "main" }, // the branch; head office is "main"
  isReversed: {
    type: Boolean,
    default: false
  }, // Track if this movement was reversed
  
  reversalReference: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "InventoryMovement"
  } // Reference to reversal movement
}, {
  timestamps: true
});

// Indexes for better query performance
inventoryMovementSchema.index({ stockId: 1, date: -1 });
inventoryMovementSchema.index({ referenceId: 1, referenceType: 1 });
inventoryMovementSchema.index({ eventType: 1, date: -1 });
inventoryMovementSchema.index({ companyId: 1, branchId: 1, stockId: 1, date: 1, _id: 1 });

// Virtual for movement direction
inventoryMovementSchema.virtual('movementType').get(function() {
  return this.quantity > 0 ? 'IN' : 'OUT';
});

// Static method to get stock history
inventoryMovementSchema.statics.getStockHistory = async function(stockId, startDate, endDate) {
  const query = { stockId };
  
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }
  
  return this.find(query).sort({ date: -1 });
};

// Static method to calculate stock at specific date
inventoryMovementSchema.statics.getStockAtDate = async function(stockId, date) {
  const movements = await this.find({
    stockId,
    date: { $lte: new Date(date) }
  }).sort({ date: 1 });
  
  return movements.reduce((total, movement) => total + movement.quantity, 0);
};

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
inventoryMovementSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("InventoryMovement", inventoryMovementSchema);