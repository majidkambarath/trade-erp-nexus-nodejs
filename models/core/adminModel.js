const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

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
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid email"]
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
    type: {
      type: String,
      enum: {
        values: ["super_admin", "admin", "manager", "operator", "viewer"],
        message: "Type must be one of: super_admin, admin, manager, operator, viewer"
      },
      default: "viewer"
    },
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
    const allPermissions = [
      "users_manage",
      "inventory_manage",
      "transactions_manage",
      "transactions_approve",
      "financial_reports",
      "system_settings",
      "backup_restore"
    ];
    this.permissions = allPermissions;
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

// Instance method: increment login attempts
adminSchema.methods.incLoginAttempts = function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockUntil: 1 },
      $set: { loginAttempts: 1 }
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + 2 * 60 * 60 * 1000 }; // lock for 2 hours
  }

  return this.updateOne(updates);
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
  return admin;
};

const Admin = mongoose.model("Admin", adminSchema);

module.exports = Admin;