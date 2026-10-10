// Load environment variables first. When this script is executed from the `utils` folder
// the default cwd is `utils/`, so dotenv won't find the `.env` file at the project root.
// Explicitly point to the root .env using path.resolve().
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { planSeed } = require("./seedPlan");

// Decided from the environment alone, before anything connects: in production this refuses the old built-in password and takes
// the account from ADMIN_EMAIL / ADMIN_PASSWORD (or generates a strong password and prints it once). See utils/seedPlan.js.
let PLAN;
try {
  PLAN = planSeed(process.env);
} catch (err) {
  console.error(`❌ seed refused: ${err.message}`);
  process.exit(1);
}

const Admin = require("../models/core/adminModel");
const { DEFAULT_TENANT, runWithTenant } = require("./tenantContext");

// Ensure MONGO_URI is defined
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in your .env file");
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI;

// Seeded super admins. The password is hashed by the Admin pre-save hook, so it is passed
// in plain text here. Every run is idempotent: an existing account is not duplicated, and in
// development it is brought back to this definition (in production it is left alone unless
// ADMIN_RESET=1). The list is the PLAN: the known test accounts in development, the one account
// named by ADMIN_EMAIL in production.
const SEED_ADMINS = PLAN.accounts;

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

// The sign-in details of a generated password are printed ONCE, here, and kept nowhere: the account holds only a hash.
function announce({ email, password, generated }) {
  if (!generated) return;
  console.log(`
  Sign in as ${email}
  Generated password (shown once, not stored anywhere): ${password}
  You will be asked to choose your own at the first sign-in.
`);
}

async function upsertAdmin({ name, email, password, mustChangePassword, generated }) {
  const existing = await Admin.findOne({ email }).select("+password");
  if (existing) {
    if (!PLAN.replaceExisting) {
      console.log(`ℹ️ ${email}: already exists, left as it is (set ADMIN_RESET=1 to replace its password)`);
      return;
    }
    existing.name = name;
    existing.password = password;
    existing.type = "super_admin";
    existing.status = "active";
    existing.isActive = true;
    if (mustChangePassword) existing.mustChangePassword = true;
    existing.lockUntil = undefined;
    existing.loginAttempts = 0;
    await existing.save();
    console.log(`ℹ️ ${email}: already exists, updated`);
    announce({ email, password, generated });
    return;
  }

  await new Admin({
    name,
    email,
    password,
    type: "super_admin",
    status: "active",
    isActive: true,
    ...(mustChangePassword ? { mustChangePassword: true } : {}),
  }).save();
  console.log(`✅ ${email}: super admin created`);
  announce({ email, password, generated });
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
