const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { permissionsFor } = require("../../utils/adminPermissions");
const tenantPlugin = require("../../utils/tenantPlugin");

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minLength: [2, "Name must be at least 2 characters"],
      maxLength: [50, "Name cannot exceed 50 characters"]
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      // Any address of the form something@domain.ending, the ending two or more characters. The old pattern allowed a
      // two or three letter ending only, so a customer on .company, .agency, .africa or .travel could not be created.
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Please enter a valid email"]
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minLength: [6, "Password must be at least 6 characters"],
      select: false
    },
    profileImage: {
      url: {
        type: String,
        default: null
      },
      publicId: {
        type: String,
        default: null
      }
    },
    // The organisation this person belongs to, and the branch they work from. One person belongs to one
    // organisation, so the email stays unique across all of them and signing in needs no organisation picker.
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    type: {
      type: String,
      enum: {
        values: ["super_admin", "admin", "manager", "operator", "viewer"],
        message: "Type must be one of: super_admin, admin, manager, operator, viewer"
      },
      default: "viewer"
    },
    // The role this person holds: a built-in role key or the key of one their organisation made (models/core/roleModel.js).
    // Empty means "the role of my type", which is how every account made before roles existed keeps what it had. A person
    // with a custom role keeps type "viewer", the safest base, so anything still reading the type fails closed.
    roleKey: { type: String, default: null, lowercase: true, trim: true },
    // Roles that differ by branch: in this branch the person holds this role INSTEAD of their own, and a person who belongs
    // to another branch may work here only by being listed. A person with any of these works in one branch at a time (there
    // is no "all branches" view for them, because their role is not the same in all of them). Set only through the users
    // API (utils/adminPermissions SYSTEM_FIELDS), never from a request body.
    branchRoles: {
      type: [{ _id: false, branchId: { type: String, required: true, lowercase: true, trim: true }, roleKey: { type: String, required: true, lowercase: true, trim: true } }],
      default: [],
    },
    // LEGACY: the old coarse list, still written from the type and still carried in the token, but nothing trusts it.
    // What a person may do is their role (utils/permissions.js), resolved from the database on every request.
    permissions: {
      type: [String],
      default: []
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active"
    },
    
    // Company Information
    companyInfo: {
      companyName: {
        type: String,
        trim: true,
        maxLength: [100, "Company name cannot exceed 100 characters"]
      },
      addressLine1: {
        type: String,
        trim: true,
        maxLength: [100, "Address line 1 cannot exceed 100 characters"]
      },
      addressLine2: {
        type: String,
        trim: true,
        maxLength: [100, "Address line 2 cannot exceed 100 characters"]
      },
      city: {
        type: String,
        trim: true,
        maxLength: [50, "City cannot exceed 50 characters"]
      },
      state: {
        type: String,
        trim: true,
        maxLength: [50, "State/Province cannot exceed 50 characters"]
      },
      country: {
        type: String,
        trim: true,
        maxLength: [50, "Country cannot exceed 50 characters"]
      },
      postalCode: {
        type: String,
        trim: true,
        maxLength: [20, "Postal code cannot exceed 20 characters"]
      },
      phoneNumber: {
        type: String,
        trim: true,
        maxLength: [20, "Phone number cannot exceed 20 characters"]
      },
      emailAddress: {
        type: String,
        lowercase: true,
        trim: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid company email"]
      },
      website: {
        type: String,
        trim: true,
        maxLength: [100, "Website URL cannot exceed 100 characters"]
      },
      companyLogo: {
        url: {
          type: String,
          default: null
        },
        publicId: {
          type: String,
          default: null
        }
      },
      
      // Bank Details
      bankDetails: {
        bankName: {
          type: String,
          trim: true,
          maxLength: [100, "Bank name cannot exceed 100 characters"]
        },
        accountNumber: {
          type: String,
          trim: true,
          maxLength: [50, "Account number cannot exceed 50 characters"]
        },
        accountName: {
          type: String,
          trim: true,
          maxLength: [100, "Account name cannot exceed 100 characters"]
        },
        ibanNumber: {
          type: String,
          trim: true,
          maxLength: [50, "IBAN number cannot exceed 50 characters"]
        },
        swiftCode: {
          type: String,
          trim: true,
          uppercase: true,
          maxLength: [11, "SWIFT / BIC code cannot exceed 11 characters"]
        },
        currency: {
          type: String,
          trim: true,
          maxLength: [10, "Currency cannot exceed 10 characters"],
          default: "USD"
        }
      }
    },
    
    lastLogin: {
      type: Date,
      default: null
    },
    // True from the moment someone ELSE sets this person's password (an administrator adding or resetting them, the developer
    // console) until they choose their own: until then the server refuses everything but changing it (PASSWORD_CHANGE_REQUIRED).
    mustChangePassword: {
      type: Boolean,
      default: false
    },
    passwordChangedAt: {
      type: Date,
      default: null
    },
    // Set when every sign-in this person holds is ended at once (a password reset by email, an administrator resetting their
    // two-factor). An access token issued before it is refused (middleware/authMiddleware.js); the refresh sessions are revoked.
    sessionsRevokedAt: {
      type: Date,
      default: null
    },
    // Two-factor sign-in (utils/totp.js; services/core/twoFactorService.js). The secret is encrypted at rest (utils/secretBox.js)
    // and, with the recovery code hashes, is never selected unless a sign-in or an enrolment asks for it.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      enabledAt: { type: Date, default: null },
      secretEnc: { type: String, default: null, select: false },
      pendingSecretEnc: { type: String, default: null, select: false }, // an enrolment begun and not yet proved with a code
      lastStep: { type: Number, default: -1 }, // the last time step accepted: a code for it, or an earlier one, is a replay
      recoveryCodes: {
        type: [{ _id: false, hash: { type: String, required: true }, usedAt: { type: Date, default: null } }],
        default: undefined,
        select: false
      }
    },
    loginAttempts: {
      type: Number,
      default: 0
    },
    lockUntil: {
      type: Date
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual field
adminSchema.virtual("isLocked").get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Indexes
adminSchema.index({ email: 1 }, { unique: true });
adminSchema.index({ type: 1 });
adminSchema.index({ companyId: 1, type: 1 });
adminSchema.index({ status: 1 });
adminSchema.index({ createdAt: -1 });
adminSchema.index({ "companyInfo.companyName": 1 });

// Pre-save hook to hash password
adminSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Pre-save hook to assign permissions
adminSchema.pre("save", function (next) {
  if (this.isModified("type") || this.isNew) {
    // By type (utils/adminPermissions.js). This used to hand all seven to every account, so a viewer
    // could do anything a super admin could wherever permissions were checked.
    this.permissions = permissionsFor(this.type);
  }
  next();
});

// Pre-save hook to set updatedBy
adminSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified() && this.$locals.updatedBy) {
    this.updatedBy = this.$locals.updatedBy;
  }
  next();
});

// Instance method: compare password
adminSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (err) {
    throw err;
  }
};

// Instance method: check specific permission
adminSchema.methods.hasPermission = function (permission) {
  return this.permissions.includes(permission);
};

// Instance method: check any of given permissions
adminSchema.methods.hasAnyPermission = function (permissions) {
  return permissions.some((perm) => this.permissions.includes(perm));
};

// The lock-out: five attempts, then fifteen minutes (a lock-out is also a way to shut someone else out on purpose, so it
// ends soon on its own).
//
// An attempt is COUNTED BEFORE the secret is weighed, in ONE atomic statement that also starts the lock. Counting after a failure
// (read the count, then add one) let any number of requests sent together all pass the check, all be weighed against the
// password, and only then be counted: forty parallel guesses were forty guesses. Now request number six and everything after it is
// refused without being weighed, however they arrive. A caller whose secret turns out right gives its attempt back
// (`giveBackAttempt`) or clears the count (`resetLoginAttempts`).
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
adminSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

// -> { n, locked, lockUntil }: this attempt's number, and whether it may be weighed at all (the sixth and later may not).
adminSchema.methods.reserveAttempt = async function () {
  const now = new Date();
  // a lock that has run out starts the count again, in the same statement
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
  const n = after?.loginAttempts ?? MAX_ATTEMPTS + 1; // an account that vanished mid-request is refused
  return { n, locked: n > MAX_ATTEMPTS, lockUntil: after?.lockUntil || new Date(now.getTime() + LOCK_MS) };
};

// The secret was right but the sign-in is not finished (the second factor is still to come): this attempt does not count against the
// person. If reserving it is what started the lock, the lock goes with it.
adminSchema.methods.giveBackAttempt = function () {
  return this.constructor.updateOne({ _id: this._id }, [
    { $set: { loginAttempts: { $max: [0, { $subtract: [{ $ifNull: ["$loginAttempts", 0] }, 1] }] } } },
    { $set: { lockUntil: { $cond: [{ $lt: ["$loginAttempts", MAX_ATTEMPTS] }, "$$REMOVE", "$lockUntil"] } } },
  ]);
};

// A failed attempt is simply one that was reserved and not given back; this stays for callers that fail without having reserved.
adminSchema.methods.incLoginAttempts = async function () {
  await this.reserveAttempt();
};

// Instance method: reset login attempts
adminSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $unset: { loginAttempts: 1, lockUntil: 1 }
  });
};

// Static method: find active
adminSchema.statics.findActive = function () {
  return this.find({ status: "active", isActive: true });
};

// Static method: find by type
adminSchema.statics.findByType = function (type) {
  return this.find({ type, status: "active", isActive: true });
};

// Remove sensitive data from output
adminSchema.methods.toJSON = function () {
  const admin = this.toObject();
  delete admin.password;
  delete admin.loginAttempts;
  delete admin.lockUntil;
  // Two-factor: whether it is on and since when. Never the secret, the pending secret or a recovery code hash.
  admin.twoFactor = { enabled: Boolean(admin.twoFactor?.enabled), enabledAt: admin.twoFactor?.enabledAt || null };
  return admin;
};

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
adminSchema.plugin(tenantPlugin);

const Admin = mongoose.model("Admin", adminSchema);

module.exports = Admin;