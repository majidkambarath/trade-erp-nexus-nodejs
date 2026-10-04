const mongoose = require("mongoose");
const logger = require("./logger");

const errorHandler = (err, req, res, next) => {
  logger.error("Error handler caught error", { name: err.name, message: err.message, code: err.code, stack: process.env.NODE_ENV === "production" ? undefined : err.stack });

  // Mongoose validation errors
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      success: false,
      message: "Validation Error",
      errorCode: "VALIDATION_ERROR",
      errors: Object.values(err.errors).map((e) => e.message),
    });
  }

  // Duplicate key error (unique constraints)
  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      message: "Duplicate field value",
      errorCode: "DUPLICATE_FIELD",
      fields: err.keyValue,
    });
  }

  // Custom AppError
  if (err.isOperational) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message,
      errorCode: err.code || "APP_ERROR",
      details: err.details || null,
    });
  }

  // JWT errors (optional)
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
      errorCode: "INVALID_TOKEN",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Token has expired",
      errorCode: "TOKEN_EXPIRED",
    });
  }

  // Unknown / unhandled errors
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    errorCode: "INTERNAL_ERROR",
  });
};

// The auth middleware builds its 401 / 403 errors with createAppError, which this module is
// supposed to provide. It was never exported, so every denied permission threw a TypeError and
// reached the client as a 500. The handler stays the default export, as before.
const AppError = require("./AppError");
module.exports = errorHandler;
module.exports.createAppError = (message, statusCode, code, details) => new AppError(message, statusCode, code, details);
