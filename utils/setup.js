// Load environment variables first
require("dotenv").config();

const mongoose = require("mongoose");
const Admin = require("../models/core/adminModel");

// Ensure MONGO_URI is defined
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in your .env file");
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI;

// Connect to MongoDB
mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ MongoDB connected successfully");
    return setupAdmin(); // call your logic after connection
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

async function setupAdmin() {
  try {
    // Check if super admin already exists
    const existingAdmin = await Admin.findOne({ role: "superadmin" });
    if (existingAdmin) {
      console.log("ℹ️ Super admin already exists");
    } else {
      // Create default superadmin
      const newAdmin = new Admin({
        name: "Super Admin",
        email: "admin@example.com",
        password: "admin123", // make sure to hash in model or update later
        role: "superadmin",
      });

      await newAdmin.save();
      console.log("✅ Super admin created successfully");
    }

    mongoose.disconnect(); // Close DB connection after setup
  } catch (error) {
    console.error("❌ Error during admin setup:", error.message);
    process.exit(1);
  }
}
