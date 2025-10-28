const mongoose = require("mongoose");

const stockPurchaseLogSchema = new mongoose.Schema({
  transactionNo: {
    type: String,
    unique: true,
    required: [true, "Transaction number is required"],
    trim: true,
  },
  type: {
    type: String,
    default: "purchase_order",
  },
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: "partyTypeRef",
  },
  partyType: {
    type: String,
    enum: ["Vendor"],
    required: true,
  },
  partyTypeRef: {
    type: String,
    enum: ["Vendor"],
    required: true,
  },
  date: {
    type: Date,
    required: [true, "Transaction date is required"],
    default: Date.now,
  },
  deliveryDate: {
    type: Date,
    required: [true, "Delivery date is required"],
  },
  items: [
    {
      itemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Stock",
        required: [true, "Item ID is required"],
      },
      description: {
        type: String,
        trim: true,
      },
      qty: {
        type: Number,
        required: [true, "Quantity is required"],
        min: [0, "Quantity cannot be negative"],
      },
      rate: {
        type: Number,
        required: [true, "Rate is required"],
        min: [0, "Rate cannot be negative"],
      },
      vatPercent: {
        type: Number,
        default: 0,
        min: [0, "VAT percentage cannot be negative"],
      },
      price: {
        type: Number,
        required: [true, "Price is required"],
        min: [0, "Price cannot be negative"],
      },
     
    },
  ],
  terms: {
    type: String,
    trim: true,
    default: "",
  },
  notes: {
    type: String,
    trim: true,
    default: "",
  },
  priority: {
    type: String,
    enum: ["Low", "Medium", "High"],
    default: "Medium",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
stockPurchaseLogSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update the updatedAt field before updating
stockPurchaseLogSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});


module.exports = mongoose.model("StockPurchaseLog", stockPurchaseLogSchema);
