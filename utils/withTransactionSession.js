const mongoose = require("mongoose");

const isSession = (v) =>
  Boolean(v) && typeof v === "object" && typeof v.startTransaction === "function" && typeof v.inTransaction === "function";

// Runs `fn(...args, session)` in a MongoDB transaction: committed if it returns, rolled back if it
// throws. When the LAST argument is already a session, the caller is itself inside a transaction
// (a quotation becoming an invoice, a delivery note raising one) and `fn` joins it, so both
// documents are written together or not at all. A function that is not handed a session behaves
// exactly as before.
function withTransactionSession(fn) {
  return async (...args) => {
    if (isSession(args[args.length - 1])) return fn(...args);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(...args, session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  };
}

module.exports = { withTransactionSession, isSession };
