// A person who runs the PRODUCT (as opposed to a customer's staff, who are `Admin`s inside an organisation).
//
// Deliberately its own collection and not a role on Admin: a platform user belongs to no organisation, signs in
// to a different place with a token that a customer's token can never be mistaken for, and can create, change
// and suspend organisations. Making that a flag on Admin would put the keys to every customer one forgotten
// check away from every customer's own staff.
//
// NOT scoped by the tenant plugin: it has no companyId, because it belongs to none.
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const platformUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That email address does not look right"] },
    password: { type: String, required: true, select: false },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    lastLogin: { type: Date, default: null },
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
  },
  { timestamps: true }
);

platformUserSchema.pre("save", async function hash(next) {
  if (!this.isModified("password")) return next();
  try {
    this.password = await bcrypt.hash(this.password, await bcrypt.genSalt(12));
    next();
  } catch (error) {
    next(error);
  }
});

platformUserSchema.virtual("isLocked").get(function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil > Date.now());
});
platformUserSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(String(candidate || ""), this.password);
};
// Five wrong passwords lock the account for two hours, as for a customer's staff.
platformUserSchema.methods.recordFailure = function recordFailure() {
  if (this.lockUntil && this.lockUntil < Date.now()) return this.updateOne({ $unset: { lockUntil: 1 }, $set: { loginAttempts: 1 } });
  const update = { $inc: { loginAttempts: 1 } };
  if ((this.loginAttempts || 0) + 1 >= 5 && !this.isLocked) update.$set = { lockUntil: new Date(Date.now() + 2 * 3600 * 1000) };
  return this.updateOne(update);
};
platformUserSchema.methods.recordSuccess = function recordSuccess() {
  return this.updateOne({ $unset: { loginAttempts: 1, lockUntil: 1 }, $set: { lastLogin: new Date() } });
};
platformUserSchema.set("toJSON", { transform: (_doc, ret) => { delete ret.password; delete ret.loginAttempts; delete ret.lockUntil; delete ret.__v; return ret; } });

module.exports = mongoose.models.PlatformUser || mongoose.model("PlatformUser", platformUserSchema);
