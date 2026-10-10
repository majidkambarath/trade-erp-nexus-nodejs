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
    // Two-factor sign-in, the same block and the same service as a customer's account (services/core/twoFactorService.js).
    twoFactor: {
      enabled: { type: Boolean, default: false },
      enabledAt: { type: Date, default: null },
      secretEnc: { type: String, default: null, select: false },
      pendingSecretEnc: { type: String, default: null, select: false },
      lastStep: { type: Number, default: -1 },
      recoveryCodes: {
        type: [{ _id: false, hash: { type: String, required: true }, usedAt: { type: Date, default: null } }],
        default: undefined,
        select: false,
      },
    },
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
// (Counting is atomic: a read-then-write count let any number of guesses sent together all be weighed before the lock was set.)
platformUserSchema.methods.recordFailure = function recordFailure() {
  const now = new Date();
  const expired = { $and: [{ $ne: [{ $ifNull: ["$lockUntil", null] }, null] }, { $lte: ["$lockUntil", now] }] };
  return this.constructor.updateOne({ _id: this._id }, [
    { $set: { loginAttempts: { $cond: [expired, 1, { $add: [{ $ifNull: ["$loginAttempts", 0] }, 1] }] }, lockUntil: { $cond: [expired, "$$REMOVE", "$lockUntil"] } } },
    { $set: { lockUntil: { $cond: [{ $and: [{ $gte: ["$loginAttempts", 5] }, { $eq: [{ $ifNull: ["$lockUntil", null] }, null] }] }, new Date(now.getTime() + 2 * 3600 * 1000), "$lockUntil"] } } },
  ]);
};
platformUserSchema.methods.recordSuccess = function recordSuccess() {
  return this.updateOne({ $unset: { loginAttempts: 1, lockUntil: 1 }, $set: { lastLogin: new Date() } });
};
platformUserSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.password; delete ret.loginAttempts; delete ret.lockUntil; delete ret.__v;
    ret.twoFactor = { enabled: Boolean(ret.twoFactor?.enabled), enabledAt: ret.twoFactor?.enabledAt || null }; // on or off, never the secret
    return ret;
  },
});

module.exports = mongoose.models.PlatformUser || mongoose.model("PlatformUser", platformUserSchema);
