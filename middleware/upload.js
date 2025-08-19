const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");
const AppError = require("../utils/AppError");

// Allowed MIME types
const ALLOWED_FORMATS = ["image/jpeg", "image/png", "image/webp", "image/jpg"];

// Multer filter for validation
const fileFilter = (req, file, cb) => {
  if (ALLOWED_FORMATS.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError("Invalid file type. Only JPG, PNG, and WEBP are allowed.", 400), false);
  }
};

// Storage config with Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "erp_uploads",
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
    transformation: [{ width: 800, height: 800, crop: "limit" }],
    public_id: (req, file) => {
      // Generate unique filename with timestamp
      const timestamp = Date.now();
      const originalName = file.originalname.split('.')[0];
      return `${originalName}_${timestamp}`;
    }
  },
});

// Base multer config
const multerConfig = {
  storage,
  fileFilter,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB max per file
    files: 10 // Maximum 10 files at once
  },
};

// Different upload configurations
const uploadConfigs = {
  // Single image upload
  single: (fieldName = 'image') => multer(multerConfig).single(fieldName),
  
  // Multiple images upload (same field name)
  multiple: (fieldName = 'images', maxCount = 5) => 
    multer(multerConfig).array(fieldName, maxCount),
  
  // Multiple fields with different names
  fields: (fieldsConfig) => multer(multerConfig).fields(fieldsConfig),
  
  // Any files upload
  any: () => multer(multerConfig).any()
};

// Middleware for handling upload errors
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return next(new AppError('File size too large. Maximum size is 5MB.', 400));
      case 'LIMIT_FILE_COUNT':
        return next(new AppError('Too many files. Maximum allowed is 10 files.', 400));
      case 'LIMIT_UNEXPECTED_FILE':
        return next(new AppError('Unexpected field name in file upload.', 400));
      default:
        return next(new AppError('File upload error occurred.', 400));
    }
  }
  
  if (error.message.includes('Invalid file type')) {
    return next(error);
  }
  
  next(error);
};

// Helper function to extract file information
const extractFileInfo = (files) => {
  if (!files) return null;
  
  // Handle single file
  if (!Array.isArray(files)) {
    return {
      url: files.path,
      publicId: files.filename,
      originalName: files.originalname,
      size: files.size,
      format: files.mimetype
    };
  }
  
  // Handle multiple files
  return files.map(file => ({
    url: file.path,
    publicId: file.filename,
    originalName: file.originalname,
    size: file.size,
    format: file.mimetype
  }));
};

// Helper function to delete images from Cloudinary
const deleteFromCloudinary = async (publicIds) => {
  try {
    const ids = Array.isArray(publicIds) ? publicIds : [publicIds];
    const results = await Promise.all(
      ids.map(id => cloudinary.uploader.destroy(id))
    );
    return results;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw new AppError('Failed to delete images from storage.', 500);
  }
};

module.exports = {
  // Upload configurations
  uploadSingle: uploadConfigs.single,
  uploadMultiple: uploadConfigs.multiple,
  uploadFields: uploadConfigs.fields,
  uploadAny: uploadConfigs.any,
  
  // Middleware and utilities
  handleUploadError,
  extractFileInfo,
  deleteFromCloudinary,
  
  // Direct access to configurations
  uploadConfigs
};