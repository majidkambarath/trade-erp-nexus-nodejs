// READ-ONLY health check of the books at a date: is the trial balance balanced, what are the balances, does stock agree with the ledger.
const { api, r2 } = require("./abc-lib.cjs");
const ASOF = process.env.ASOF || new Date().toISOString().slice(0, 10);
const FROM = process.env.FROM || "2025-01-01";
(async () => {
  const tb = await api("GET", `/vouchers/reports/financial?reportType=trial_balance&dateFrom=${FROM}&dateTo=${ASOF}`);
  const rep = tb.body?.report;
  if (!rep) { console.log("trial balance failed:", tb.status, tb.message); return; }
  const rows = (rep.trialBalance || []).filter((r) => Math.abs(r.balance || 0) > 0.004 || r.totalDebits || r.totalCredits);
  console.log(`TRIAL BALANCE ${FROM} -> ${ASOF}   balanced: ${rep.summary?.isBalanced}   debits ${rep.summary?.totalDebits}  credits ${rep.summary?.totalCredits}`);
  for (const r of rows) console.log(`  ${String(r.accountCode || "").padEnd(9)} ${String(r.accountName).padEnd(52)} Dr ${String(r2(r.totalDebits)).padStart(14)}  Cr ${String(r2(r.totalCredits)).padStart(14)}  bal ${String(r2(r.balance)).padStart(14)}`);
  const lc = await api("GET", `/stock-reports/ledger-check?asOn=${ASOF}`);
  const c = lc.body || {};
  console.log("\nSTOCK vs LEDGER:", lc.status, JSON.stringify({ stockValue: c.stockValue ?? c.valuation, ledger: c.ledgerValue ?? c.inventoryLedger, difference: c.difference, reconciled: c.reconciled, basis: c.basis, exact: c.exact }));
  if (lc.status !== 200) console.log(" ", lc.message);
})().catch((e) => console.log("ERR", e.message));
