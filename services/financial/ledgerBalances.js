const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const { round2 } = require("../../utils/accounting");

// The ledger balance of each account follows its entries (the same sign rule as
// FinancialService.updateAccountBalances), applied once per account instead of once per entry.
async function applyBalances(docs, session) {
  const net = new Map();
  for (const d of docs) net.set(String(d.accountId), (net.get(String(d.accountId)) || 0) + (d.debitAmount || 0) - (d.creditAmount || 0));
  const accounts = await LedgerAccount.find({ _id: { $in: [...net.keys()] } }).select("accountType").session(session).lean();
  const ops = accounts.map((a) => {
    const n = net.get(String(a._id));
    return { updateOne: { filter: { _id: a._id }, update: { $inc: { currentBalance: round2(["asset", "expense"].includes(a.accountType) ? n : -n) } } } };
  });
  if (ops.length) await LedgerAccount.bulkWrite(ops, { session });
}

// Entries written together with the balances they move (opening balances, year-end closing).
async function writeEntries(docs, session) {
  if (!docs.length) return;
  await LedgerEntry.insertMany(docs, { session });
  await applyBalances(docs, session);
}

module.exports = { applyBalances, writeEntries };
