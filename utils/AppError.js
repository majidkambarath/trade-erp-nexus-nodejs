class AppError extends Error {
  // `code` is the machine-readable errorCode the error handler sends to the client
  // (e.g. PERIOD_CLOSED, ACCOUNT_NOT_CONFIGURED). Optional, so existing callers are unchanged.
  constructor(message, statusCode, code, details) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (details) this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
