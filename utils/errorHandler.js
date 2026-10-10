const mongoose = require("mongoose");
const logger = require("./logger");
const TxRetry = require("./withTransactionSession");

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

  // The request body could not be read: malformed JSON, too big, or in an encoding we do not take. A fault of the caller, said as one
  // (these used to fall through to "Internal Server Error", and the parser's own text must not be echoed).
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400 && "body" in err)) {
    return res.status(400).json({ success: false, message: "The request body is not valid JSON", errorCode: "INVALID_JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "The request is too large", errorCode: "PAYLOAD_TOO_LARGE" });
  }
  if (err.type === "encoding.unsupported" || err.type === "charset.unsupported") {
    return res.status(415).json({ success: false, message: "Unsupported content encoding", errorCode: "UNSUPPORTED_ENCODING" });
  }
  if (err.type === "request.aborted" || err.type === "request.size.invalid" || err.type === "stream.encoding.set") {
    return res.status(400).json({ success: false, message: "The request could not be read", errorCode: "BAD_REQUEST" });
  }

  // Duplicate key error (unique constraints). The NAMES of the fields that clashed, never the values: the value is the caller's own
  // input back again at best, and at worst another organisation's (an email address is unique across organisations), and the
  // index also carries the organisation and branch of the row.
  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      message: "Duplicate field value",
      errorCode: "DUPLICATE_FIELD",
      fields: Object.keys(err.keyValue || {}).filter((k) => k !== "companyId" && k !== "branchId"),
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

  // A value in the request that cannot be what the field needs (an id that is not an id, text where a number goes): the caller's
  // fault, said as one. Left to fall through it answered 500 "Internal Server Error" to anyone who typed a bad id into an address.
  if (err.name === "CastError") {
    return res.status(400).json({ success: false, message: "A value in the request is not valid", errorCode: "INVALID_INPUT" });
  }

  // Two writers on the same record at the same moment, and this service did not retry (many keep their own transaction): the
  // loser's transaction was aborted whole, so nothing was written. Said in words and retryable, not a bare 500.
  if (TxRetry.isTransient(err)) {
    return res.status(409).json({
      success: false,
      message: "Another change to the same record was being saved at that moment, so this one was not saved. Please try again.",
      errorCode: "WRITE_CONFLICT",
      details: null,
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
