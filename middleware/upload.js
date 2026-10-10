const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");
const AppError = require("../utils/AppError");

// Pictures and logos: three kinds of image and nothing else. The kind is judged THREE ways, because each alone is the sender's word:
//   1. the type the browser declared,
//   2. the file's own ending, which must belong to that type (an `.svg` declared as a png is refused), and
//   3. the first bytes of the file, which must be that kind of image (a page of script named logo.png is refused before it is sent anywhere).
// SVG and HTML are never accepted: both can carry script, and a picture is not a document.
const ALLOWED_FORMATS = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const ENDINGS = { ".jpg": ["image/jpeg", "image/jpg"], ".jpeg": ["image/jpeg", "image/jpg"], ".png": ["image/png"], ".webp": ["image/webp"] };

const startsWith = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
// -> "image/jpeg" | "image/png" | "image/webp" | null, from the first twelve bytes
const sniffImage = (buf) => {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
};
const sameKind = (declared, sniffed) => Boolean(sniffed) && (declared === sniffed || (declared === "image/jpg" && sniffed === "image/jpeg"));

// Multer filter for validation (the declared type and the ending; the bytes are checked as the file arrives, below)
const fileFilter = (req, file, cb) => {
  const ending = path.extname(String(file.originalname || "")).toLowerCase();
  if (ALLOWED_FORMATS.includes(file.mimetype) && (ENDINGS[ending] || []).includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError("Invalid file type. Only JPG, PNG, and WEBP are allowed.", 400, "FILE_TYPE_NOT_ALLOWED"), false);
  }
};

// A name the file is stored under: our own letters and digits and a random tail, never the sender's path or punctuation.
const safeUploadName = (originalname) => {
  const stem = path.basename(String(originalname || "file")).split(".")[0].replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "file";
  return `${stem}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
};

// Reads the first `n` bytes of an upload without consuming them: they are put back for whoever stores the file.
function peek(stream, n = 12) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let ended = false;
    const finish = (viaEnd) => {
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", reject);
      const headBytes = Buffer.concat(chunks);
      ended = ended || viaEnd === true;
      // a file that ended before it had enough bytes to be judged is no image of ours; there is nothing left to hand on, and nothing may be put back
      if (headBytes.length && !ended) stream.unshift(headBytes);
      resolve(ended && size < n ? Buffer.alloc(0) : headBytes);
    };
    const onEnd = () => finish(true);
    const onReadable = () => {
      let chunk;
      while (size < n && (chunk = stream.read()) !== null) {
        chunks.push(chunk);
        size += chunk.length;
      }
      if (size >= n) finish();
    };
    stream.on("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", reject);
    onReadable();
  });
}

// Wraps a multer storage engine with the check on the file's first bytes. A refused file is drained and never reaches the engine.
function checkedStorage(inner) {
  return {
    _handleFile(req, file, cb) {
      peek(file.stream).then(
        (headBytes) => {
          if (!sameKind(file.mimetype, sniffImage(headBytes))) {
            file.stream.resume();
            return cb(new AppError("Invalid file type. The file is not the image it says it is.", 400, "FILE_CONTENT_MISMATCH"));
          }
          return inner._handleFile(req, file, cb);
        },
        (error) => cb(error)
      );
    },
    _removeFile(req, file, cb) {
      return inner._removeFile(req, file, cb);
    },
  };
}

// Storage config with Cloudinary
const storage = checkedStorage(new CloudinaryStorage({
  cloudinary,
  params: {
    // one folder per organisation, so one organisation's pictures are never filed among another's
    folder: (req) => (req.tenant?.companyId ? `erp_uploads/${String(req.tenant.companyId).replace(/[^A-Za-z0-9_-]/g, "_")}` : "erp_uploads"),
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
    transformation: [{ width: 800, height: 800, crop: "limit" }],
    public_id: (req, file) => safeUploadName(file.originalname),
  },
}));

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
  // exposed for the tests that prove what is refused
  sniffImage,
  fileFilter,
  safeUploadName,
  checkedStorage,
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