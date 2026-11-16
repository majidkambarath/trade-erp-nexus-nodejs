// A sign-in for recording the garage guides and videos (scripts/guides/walk.mjs, scripts/videos/make.mjs) in the
// Al Manara demo garage, so the owner's own password is never needed or touched. Test credentials for the demo
// organisation only. Safe to run twice (an existing account is left alone).
//   node scripts/demo/garageRecorder.js
require("dotenv").config();
const mongoose = require("mongoose");
const CODE = "al-manara-garage";
const EMAIL = "guide-recorder@almanara-garage.ae";
const PASSWORD = "Recorder#2026";

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Admin = require("../../models/core/adminModel");
  const PlatformOrganisationService = require("../../services/platform/platformOrganisationService");
  const { runUnscoped } = require("../../utils/tenantContext");
  const existing = await runUnscoped("garage recorder: look up", () => Admin.findOne({ email: EMAIL, companyId: CODE }).lean());
  if (existing) console.log("Recorder account already exists.");
  else {
    await PlatformOrganisationService.createUser(CODE, { name: "Guide Recorder", email: EMAIL, password: PASSWORD, type: "super_admin" });
    // the console marks a new account "must change password"; a recording needs to go straight in
    await runUnscoped("garage recorder: clear forced change", () => Admin.updateOne({ email: EMAIL, companyId: CODE }, { $set: { mustChangePassword: false } }));
    console.log("Recorder account created.");
  }
  console.log(`Sign in: ${EMAIL} / ${PASSWORD}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
