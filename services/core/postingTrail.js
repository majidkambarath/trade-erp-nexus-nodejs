// The pieces the audit trails share: how a ledger entry is shown, how its totals are added up,
// and how a reversal is told apart from the posting it undoes. Used by documentAuditService
// (trade documents) and voucherAuditService (receipts, payments, journals, contras, expenses
// and notes), so the two screens cannot drift apart.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A reversal row is written by FinancialService.reverseLedgerEntries, which then marks every row
// of the voucher reversed - original and reversal alike. The narration is what tells them apart.
const isReversalRow = (entry) => /^Reversal:/i.test(entry.narration || "");

const shapeEntry = (e) => ({
  _id: e._id,
  accountId: e.accountId,
  accountCode: e.accountCode || "",
  accountName: e.accountName,
  debit: round2(e.debitAmount),
  credit: round2(e.creditAmount),
  narration: e.narration || "",
  date: e.date,
  createdAt: e.createdAt,
});

const totals = (entries) =>
  entries.reduce(
    (t, e) => ({
      debit: round2(t.debit + (e.debitAmount || 0)),
      credit: round2(t.credit + (e.creditAmount || 0)),
    }),
    { debit: 0, credit: 0 }
  );

// One source document's ledger rows, split into what it posted and what undid it.
function splitEntries(entries) {
  const posted = entries.filter((e) => !isReversalRow(e));
  const reversals = entries.filter(isReversalRow);
  const sums = totals(posted);
  return {
    posted: posted.length > 0,
    isReversed: reversals.length > 0,
    reversedAt: reversals.length ? posted[0]?.reversedAt || null : null,
    entries: posted.map(shapeEntry),
    reversals: reversals.map(shapeEntry),
    totals: sums,
    balanced: Math.abs(sums.debit - sums.credit) < 0.01,
  };
}

module.exports = { round2, isReversalRow, shapeEntry, totals, splitEntries };
