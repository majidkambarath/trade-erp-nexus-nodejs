const mongoose = require("mongoose");
const AppError = require("./AppError");

const isSession = (v) =>
  Boolean(v) && typeof v === "object" && typeof v.startTransaction === "function" && typeof v.inTransaction === "function";

// Many writers on one record (twenty invoices for one customer approved together) take turns: each round one wins and
// the rest retry. Jitter keeps them from colliding again in lockstep, and when a writer still cannot get its turn the
// person is told so in words and may press the button again - nothing was written (the transaction aborted whole).
const RETRY_ATTEMPTS = 8;
const backoff = (attempt) => new Promise((r) => setTimeout(r, 25 * attempt + Math.floor(Math.random() * 75 * attempt)));
const conflictError = (err) =>
  new AppError("Another change to the same record was being saved at that moment, so this one was not saved. Please try again.", 409, "WRITE_CONFLICT", { cause: err?.message });

// Two writers briefly in each other's way inside a transaction, not a real fault: MongoDB reports it as a
// TransientTransactionError label, code 112 (WriteConflict) or - the one case FinancialService.withTransactionRetry
// already retried for vouchers - code 251 (NoSuchTransaction).
const isTransient = (err) => Boolean(err?.errorLabels?.includes?.("TransientTransactionError") || err?.code === 112 || err?.code === 251);

// Runs `fn(...args, session)` in a MongoDB transaction: committed if it returns, rolled back if it
// throws. When the LAST argument is already a session, the caller is itself inside a transaction
// (a quotation becoming an invoice, a delivery note raising one) and `fn` joins it, so both
// documents are written together or not at all - and a transient conflict there is the OUTER
// transaction's to retry, not this nested call's, so it is not retried here.
//
// Otherwise this call owns its session outright, so a transient conflict is retried on a FRESH
// session (an aborted one cannot be reused) - found by the data-bleed sweep firing several order
// creations at once, where the loser used to surface as a raw 500 instead of a quiet retry.
function withTransactionSession(fn, maxRetries = RETRY_ATTEMPTS) {
  return async (...args) => {
    if (isSession(args[args.length - 1])) return fn(...args);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const result = await fn(...args, session);
        await session.commitTransaction();
        return result;
      } catch (err) {
        await session.abortTransaction();
        if (!isTransient(err)) throw err;
        if (attempt >= maxRetries) throw conflictError(err);
        await backoff(attempt);
      } finally {
        session.endSession();
      }
    }
  };
}

// Retries `fn()` when MongoDB reports a transient write conflict inside a transaction. `fn` must open
// and close its OWN session on every call (an aborted session cannot be reused), the way
// `FinancialService.withTransactionRetry` already does for vouchers; this is the same pattern, shared,
// for callers that do not manage a voucher's own session plumbing.
function retryTransientTransaction(fn, maxRetries = RETRY_ATTEMPTS) {
  return async (...args) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        if (!isTransient(err)) throw err;
        if (attempt >= maxRetries) throw conflictError(err);
        await backoff(attempt);
      }
    }
  };
}

module.exports = { withTransactionSession, isSession, retryTransientTransaction, isTransient, conflictError, backoff, RETRY_ATTEMPTS };
