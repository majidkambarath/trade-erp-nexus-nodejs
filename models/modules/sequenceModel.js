const mongoose = require("mongoose");

const sequenceSchema = new mongoose.Schema({
  year: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ["vendor", "customer"],
    required: true,
  },
  usedNumbers: {
    type: [Number],
    default: [],
  },
  deletedNumbers: {
    type: [Number],
    default: [],
  },
});

// Unique index on year and type to ensure separate sequences for vendors and customers
sequenceSchema.index({ type: 1 }, { unique: true });

module.exports = mongoose.model("Sequence", sequenceSchema);
