const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * An employee's own sign-in, D15: tenant-scoped like Admin (it must never cross an organisation), but its
 * own collection, with its own secret and audience (utils/employeeTokens.js) - the four independent
 * barriers PlatformUser already proves work, reused here in the opposite direction (that identity is
 * organisation-LESS on purpose; this one is organisation-bound on purpose). Never an Admin row: the
 * `users` limit counts sign-in accounts for the ERP side, and 200 factory workers would blow a 50-user
 * plan - exactly why Staff.adminId is a link rather than every employee becoming one (see staffModel.js).
 *
 * SCOPE DECISION, stated plainly rather than silently narrowed: Admin's own session model rotates the
 * refresh cookie on every use with reuse detection (a real hardening project of its own - see CLAUDE.md
 * "Attack tests and hardening"). This identity keeps ONE live refresh token at a time instead
 * (`currentRefreshJti`): signing in again, anywhere, invalidates whatever session existed before, and a
 * password change invalidates it too (`sessionsRevokedAt`). That is a real, defensible security posture
 * for a phone-first staff portal with no standing value beyond one person's own attendance/leave/payslip -
 * it is NOT the same guarantee Admin's reuse-detection gives against a copied cookie replayed ALONGSIDE a
 * live session, and is recorded here as the gap, not hidden as parity.
 */
const employeeUserSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    phone: { type: String, required: true, trim: true, match: /^\+?\d{10,15}$/ },
    password: { type: String, required: true, select: false, minlength: 8 },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    mustChangePassword: { type: Boolean, default: true }, // an administrator sets the first password
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    passwordChangedAt: { type: Date, default: null },
    sessionsRevokedAt: { type: Date, default: null },
    currentRefreshJti: { type: String, default: null, select: false },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// DELIBERATELY GLOBAL (utils/__tests__/tenantGuard.test.js GLOBAL_UNIQUE), the same reasoning Admin.email
// already uses: one person's sign-in belongs to one organisation, so signing in needs no organisation
// picker - `phone` alone must find the right person and the right company. `staffId` is global too, but
// safely so: it names a Staff._id, which ObjectId uniqueness already ties to exactly one organisation, so
// a second organisation can never collide on it even without a companyId prefix. Neither uses
// `leadIndexes` for this reason - the plugin below is applied with no options, the same choice
// adminModel.js makes for the same reason.
employeeUserSchema.index({ phone: 1 }, { unique: true });
employeeUserSchema.index({ staffId: 1 }, { unique: true });

employeeUserSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = new Date();
  next();
});

employeeUserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(String(candidate || ""), this.password);
};

employeeUserSchema.virtual("isLocked").get(function () {
  return Boolean(this.lockUntil && this.lockUntil > Date.now());
});

// The same atomic reserve-before-weighing shape Admin.reserveAttempt uses (models/core/adminModel.js):
// counted and locked in ONE update, so parallel guesses cannot all pass the check before any of them is
// weighed. -> { n, locked, lockUntil }.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
employeeUserSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

employeeUserSchema.methods.reserveAttempt = async function () {
  const now = new Date();
  const expired = { $and: [{ $ne: [{ $ifNull: ["$lockUntil", null] }, null] }, { $lte: ["$lockUntil", now] }] };
  const after = await this.constructor
    .findOneAndUpdate(
      { _id: this._id },
      [
        { $set: { loginAttempts: { $cond: [expired, 1, { $add: [{ $ifNull: ["$loginAttempts", 0] }, 1] }] }, lockUntil: { $cond: [expired, "$$REMOVE", "$lockUntil"] } } },
        { $set: { lockUntil: { $cond: [{ $and: [{ $gte: ["$loginAttempts", MAX_ATTEMPTS] }, { $eq: [{ $ifNull: ["$lockUntil", null] }, null] }] }, new Date(now.getTime() + LOCK_MS), "$lockUntil"] } } },
      ],
      { new: true }
    )
    .select("loginAttempts lockUntil")
    .lean();
  const n = after?.loginAttempts ?? MAX_ATTEMPTS + 1;
  return { n, locked: n > MAX_ATTEMPTS, lockUntil: after?.lockUntil || new Date(now.getTime() + LOCK_MS) };
};

employeeUserSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({ $unset: { loginAttempts: 1, lockUntil: 1 } });
};

employeeUserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  delete obj.currentRefreshJti;
  return obj;
};

employeeUserSchema.plugin(tenantPlugin);

module.exports = mongoose.model("EmployeeUser", employeeUserSchema);
