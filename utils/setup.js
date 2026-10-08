// Load environment variables first. When this script is executed from the `utils` folder
// the default cwd is `utils/`, so dotenv won't find the `.env` file at the project root.
// Explicitly point to the root .env using path.resolve().
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Admin = require("../models/core/adminModel");
const { DEFAULT_TENANT, runWithTenant } = require("./tenantContext");

// Ensure MONGO_URI is defined
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in your .env file");
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI;

// Seeded super admins. The password is hashed by the Admin pre-save hook, so it is passed
// in plain text here. Every run is idempotent: an existing account is brought back to this
// definition rather than duplicated.
const SEED_ADMINS = [
  { name: "Super Admin", email: "admin@test.com", password: "12312312" },
  { name: "Super Admin", email: "admin@test.uae", password: "12312312" },
];

// Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");
    // An account must belong to an organisation, and signing in checks that it exists, so the original
    // organisation is adopted first; the seeded admins are then made as members of it.
    return require("../services/core/organisationService")
      .ensureDefault()
      .then(() => runWithTenant({ companyId: DEFAULT_TENANT.companyId, branchId: DEFAULT_TENANT.branchId }, setupAdmins));
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

async function upsertAdmin({ name, email, password }) {
  const existing = await Admin.findOne({ email }).select("+password");
  if (existing) {
    existing.name = name;
    existing.password = password;
    existing.type = "super_admin";
    existing.status = "active";
    existing.isActive = true;
    await existing.save();
    console.log(`ℹ️ ${email}: already exists, updated`);
    return;
  }

  await new Admin({
    name,
    email,
    password,
    type: "super_admin",
    status: "active",
    isActive: true,
  }).save();
  console.log(`✅ ${email}: super admin created`);
}

async function setupAdmins() {
  try {
    for (const admin of SEED_ADMINS) {
      await upsertAdmin(admin);
    }
  } catch (error) {
    console.error("❌ Error during admin setup:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
