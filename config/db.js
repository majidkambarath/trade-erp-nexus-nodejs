const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();
const MONGO_URI = process.env.MONGO_URI; // Ensure full URI is stored in .env

const mongodb = async () => {
  if (!MONGO_URI) {
    console.error("❌ MongoDB URI is missing in environment variables!");
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connection successful!");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

module.exports = { mongodb };
