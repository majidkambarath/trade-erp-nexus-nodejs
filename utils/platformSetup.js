// Creates the FIRST developer-console account. There is deliberately no default: the account that can create and
// suspend organisations must never exist with a password that is written in the source.
//
//   PLATFORM_ADMIN_EMAIL=you@yourcompany.com PLATFORM_ADMIN_PASSWORD='a long one with digits 123' npm run seed:platform
//
// Run once. With the email already present it changes nothing (reset a password from the console, or with
// PLATFORM_ADMIN_RESET=1 here).
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

async function main() {
  const { PLATFORM_ADMIN_EMAIL: email, PLATFORM_ADMIN_PASSWORD: password, PLATFORM_ADMIN_NAME: name, PLATFORM_ADMIN_RESET: reset } = process.env;
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not defined in your .env file");
  if (!email || !password) {
    throw new Error("Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (12+ characters, letters and digits). There is no default account.");
  }
  const Auth = require("../services/platform/platformAuthService");
  const PlatformUser = require("../models/platform/platformUserModel");
  await mongoose.connect(process.env.MONGO_URI);
  const existing = await PlatformUser.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    if (!/^(1|true|yes)$/i.test(String(reset || ""))) { console.log(`${email}: already a platform account, left as it is`); return; }
    await Auth.update(existing._id, { password, status: "active" });
    console.log(`${email}: password reset`);
    return;
  }
  const user = await Auth.create({ name: name || "Platform administrator", email, password });
  console.log(`${user.email}: platform account created. Sign in at /platform.`);
}

main()
  .catch((error) => { console.error("seed:platform failed:", error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
