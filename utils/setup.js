// Load environment variables first. When this script is executed from the `utils` folder
// the default cwd is `utils/`, so dotenv won't find the `.env` file at the project root.
// Explicitly point to the root .env using path.resolve().
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

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
    const existingAdmin = await Admin.findOne({ email: "admin@test.com" }).select("+password");
    if (existingAdmin) {
      existingAdmin.name = "Super Admin";
      existingAdmin.password = "12312312";
      existingAdmin.type = "super_admin";
      existingAdmin.status = "active";
      existingAdmin.isActive = true;
      await existingAdmin.save();
      console.log("ℹ️ Admin account already exists and was updated");
    } else {
      const newAdmin = new Admin({
        name: "Super Admin",
        email: "admin@test.com",
        password: "12312312",
        type: "super_admin",
        status: "active",
        isActive: true,
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
