const mongoose = require("mongoose");

const expenseTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Expense type name is required"],
    unique: true,
    trim: true,
    maxlength: [100, "Expense type name cannot exceed 100 characters"],
  },
  createdBy: {
    type: String,
    required: true,
  },
  updatedBy: {
    type: String,
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
expenseTypeSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update the updatedAt field before updating
expenseTypeSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

module.exports = mongoose.model("ExpenseType", expenseTypeSchema);