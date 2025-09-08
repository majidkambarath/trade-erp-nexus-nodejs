const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema({
  staffId: { type: String, unique: true, required: true },
  name: { type: String, required: true, trim: true },
  designation: { type: String, required: true, trim: true },
  contactNo: {
    type: String,
    required: true,
    trim: true,
    match: /^\+?\d{10,15}$/,
  },
  idNo: { type: String, required: true, trim: true, unique: true },
  joiningDate: { type: Date, required: true },
  idProof: { type: String }, // Cloudinary public_id
  idProofUrl: { type: String }, // Cloudinary URL
  addressProof: { type: String }, // Cloudinary public_id
  addressProofUrl: { type: String }, // Cloudinary URL
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: String, required: true },
});

module.exports = mongoose.model("Staff", staffSchema);
