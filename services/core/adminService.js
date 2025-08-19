const Admin = require("../../models/core/adminModel");
const jwt = require("jsonwebtoken");
const AppError = require("../../utils/AppError");
const { deleteFromCloudinary } = require("../../middleware/upload");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";

// Generate JWT tokens
const generateTokens = (payload) => {
  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: "ERP-system",
    audience: "ERP-admin",
  });

  const refreshToken = jwt.sign({ ...payload, type: "refresh" }, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
    issuer: "ERP-system",
    audience: "ERP-admin",
  });

  return { accessToken, refreshToken };
};

// Verify token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: "ERP-system",
      audience: "ERP-admin",
    });
  } catch (error) {
    if (error.name === "TokenExpiredError")
      throw new AppError("Token has expired", 401, "TOKEN_EXPIRED");
    if (error.name === "JsonWebTokenError")
      throw new AppError("Invalid token", 401, "INVALID_TOKEN");
    throw new AppError("Token verification failed", 401, "TOKEN_ERROR");
  }
};

// Admin login
const loginAdmin = async (email, password, ipAddress = null) => {
  if (!email || !password)
    throw new AppError(
      "Email and password are required",
      400,
      "MISSING_CREDENTIALS"
    );

  const admin = await Admin.findOne({
    email: email.toLowerCase(),
    isActive: true,
  }).select("+password +loginAttempts +lockUntil");

  if (!admin)
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

  if (admin.isLocked) {
    const lockTime = Math.ceil((admin.lockUntil - Date.now()) / (1000 * 60));
    throw new AppError(
      `Account locked. Try after ${lockTime} minutes`,
      423,
      "ACCOUNT_LOCKED"
    );
  }

  const isValid = await admin.comparePassword(password);
  if (!isValid) {
    await admin.incLoginAttempts();
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }

  if (admin.loginAttempts > 0) await admin.resetLoginAttempts();

  admin.lastLogin = new Date();
  await admin.save();

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: admin.permissions,
    name: admin.name,
  };

  const { accessToken, refreshToken } = generateTokens(tokenPayload);

  return {
    admin: admin.toJSON(),
    tokens: { accessToken, refreshToken, expiresIn: JWT_EXPIRES_IN },
    loginInfo: { lastLogin: admin.lastLogin, ipAddress },
  };
};

// Create new admin
const createAdmin = async (adminData, files = null, creatorId = null) => {
  const existing = await Admin.findOne({
    email: adminData.email.toLowerCase(),
  });
  if (existing) throw new AppError("Email already exists", 400, "EMAIL_EXISTS");

  try {
    // Handle profile image
    if (files?.profileImage) {
      adminData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // Handle company logo
    if (files?.companyLogo) {
      if (!adminData.companyInfo) adminData.companyInfo = {};
      adminData.companyInfo.companyLogo = {
        url: files.companyLogo.path,
        publicId: files.companyLogo.filename
      };
    }

    const admin = new Admin({ ...adminData, createdBy: creatorId });
    await admin.save();
    return admin.toJSON();
  } catch (error) {
    // Cleanup uploaded files if admin creation fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Update admin
const updateAdmin = async (adminId, updateData, files = null, updatedBy = null) => {
  const admin = await Admin.findById(adminId);
  if (!admin) {
    // Cleanup uploaded files if admin not found
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }

  try {
    // Store old image public IDs for cleanup
    const oldProfileImageId = admin.profileImage?.publicId;
    const oldCompanyLogoId = admin.companyInfo?.companyLogo?.publicId;

    // Handle profile image update
    if (files?.profileImage) {
      updateData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // Handle company logo update
    if (files?.companyLogo) {
      // Initialize companyInfo if it doesn't exist
      if (!updateData.companyInfo) {
        updateData.companyInfo = {};
      }
      
      // Merge existing companyInfo with new data
      if (admin.companyInfo) {
        updateData.companyInfo = { 
          ...admin.companyInfo.toObject(), 
          ...updateData.companyInfo 
        };
      }
      
      updateData.companyInfo.companyLogo = {
        url: files.companyLogo.path,
        publicId: files.companyLogo.filename
      };
    }

    // Handle nested company info updates (even without logo)
    if (updateData.companyInfo && admin.companyInfo) {
      updateData.companyInfo = { 
        ...admin.companyInfo.toObject(), 
        ...updateData.companyInfo 
      };
    }

    // Set the updatedBy field using $locals
    if (updatedBy) {
      admin.$locals = admin.$locals || {};
      admin.$locals.updatedBy = updatedBy;
    }

    // Apply updates to the admin object
    Object.assign(admin, updateData);
    
    // Save the updated admin
    const savedAdmin = await admin.save();

    // Delete old images from Cloudinary after successful update
    if (files?.profileImage && oldProfileImageId) {
      await deleteFromCloudinary(oldProfileImageId);
    }
    if (files?.companyLogo && oldCompanyLogoId) {
      await deleteFromCloudinary(oldCompanyLogoId);
    }

    return savedAdmin.toJSON();
  } catch (error) {
    // Cleanup new uploaded files if update fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Get admin by ID
const getAdminById = async (adminId) => {
  const admin = await Admin.findById(adminId)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');
  
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }
  
  return admin.toJSON();
};

// Get all admins with pagination
const getAllAdmins = async (page = 1, limit = 10, filters = {}) => {
  const skip = (page - 1) * limit;
  
  // Build query
  const query = { isActive: true };
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.search) {
    query.$or = [
      { name: { $regex: filters.search, $options: 'i' } },
      { email: { $regex: filters.search, $options: 'i' } },
      { 'companyInfo.companyName': { $regex: filters.search, $options: 'i' } }
    ];
  }

  const [admins, total] = await Promise.all([
    Admin.find(query)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Admin.countDocuments(query)
  ]);

  return {
    admins: admins.map(admin => admin.toJSON()),
    pagination: {
      current: page,
      pages: Math.ceil(total / limit),
      total,
      limit
    }
  };
};

// Delete admin (soft delete)
const deleteAdmin = async (adminId, deletedBy = null) => {
  const admin = await Admin.findById(adminId);
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }

  // Set admin as inactive instead of hard delete
  admin.isActive = false;
  admin.status = 'inactive';
  if (deletedBy) {
    admin.$locals.updatedBy = deletedBy;
  }
  await admin.save();

  // Optionally delete images from Cloudinary
  const imagesToDelete = [];
  if (admin.profileImage?.publicId) {
    imagesToDelete.push(admin.profileImage.publicId);
  }
  if (admin.companyInfo?.companyLogo?.publicId) {
    imagesToDelete.push(admin.companyInfo.companyLogo.publicId);
  }
  
  if (imagesToDelete.length > 0) {
    await deleteFromCloudinary(imagesToDelete);
  }

  return { message: 'Admin deleted successfully' };
};

// Refresh access token
const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken)
    throw new AppError(
      "Refresh token is required",
      400,
      "MISSING_REFRESH_TOKEN"
    );

  const decoded = verifyToken(refreshToken);
  if (decoded.type !== "refresh")
    throw new AppError("Invalid token type", 401, "INVALID_TOKEN_TYPE");

  const admin = await Admin.findById(decoded.id);
  if (!admin || !admin.isActive || admin.status !== "active")
    throw new AppError("Admin not found or inactive", 401, "ADMIN_INACTIVE");

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: admin.permissions,
    name: admin.name,
  };
  const { accessToken } = generateTokens(tokenPayload);

  return { accessToken, expiresIn: JWT_EXPIRES_IN };
};

module.exports = {
  loginAdmin,
  createAdmin,
  updateAdmin,
  getAdminById,
  getAllAdmins,
  deleteAdmin,
  refreshAccessToken,
  verifyToken,
  generateTokens,
};