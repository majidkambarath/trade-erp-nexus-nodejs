const mongoose = require("mongoose");

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

module.exports = mongoose.model("InventoryMovement", inventoryMovementSchema);