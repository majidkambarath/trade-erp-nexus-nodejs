// Bank reconciliation for one bank account to a date, and (for the collection account) the card settlement.
//   KEY=enbd|rak  ASOF=2025-06-30  [CARD=1]  [DRY=1]  node abc-recon.cjs
// The "bank statement" is built from the account's own ledger the way a bank would show it (money in = credit, money out =
// debit), plus the two things only a bank knows - interest and charges - which are then posted from the statement lines.
const { api, rec, r2, loadState, saveState, log, addDays, parse, iso } = require("./abc-lib.cjs");
const D = require("./abc-data.cjs");

const KEY = process.env.KEY || "enbd";
const ASOF = process.env.ASOF;
const DRY = !!process.env.DRY;
const CARD = !!process.env.CARD;
if (!ASOF) { console.log("ASOF=YYYY-MM-DD is required"); process.exit(1); }

const dmy = (d) => { const [y, m, dd] = String(d).slice(0, 10).split("-"); return `${dd}/${m}/${y}`; };
const REC = "/banking/reconciliation";
const rowsOf = (r) => (Array.isArray(r.body) ? r.body : r.body?.rows || r.body?.lines || r.body?.entries || []);

(async () => {
  const S = loadState();
  const I = S.ids;
  const bankDef = D.BANK_ACCOUNTS.find((b) => b.bank === KEY);
  if (!bankDef) throw new Error("unknown bank " + KEY);
  const accountId = I.acct[bankDef.name];
  S.recon ||= {};
  const prev = S.recon[KEY];
  const from = prev ? iso(addDays(parse(prev.asOf), 1)) : "2025-01-02";

  const led = (await api("GET", `/accounting/accounts/${accountId}/ledger?from=${from}&to=${ASOF}`)).body;
  if (!led?.rows) throw new Error("could not read the account ledger");
  let ledgerRows = led.rows;
  const openingStatement = prev ? prev.statementBalance : led.opening;

  // card receipts are not on the statement one by one: the acquirer pays them in batches, keeping its commission (1.9%) and the VAT on it
  let cardIds = new Set(), groups = [], unsettled = [];
  if (CARD) {
    const un = await api("GET", `${REC}/card/unsettled?accountId=${accountId}&to=${ASOF}`);
    unsettled = un.body?.receipts || [];
    log(`card receipts waiting for settlement: ${unsettled.length}`);
    cardIds = new Set(unsettled.map((u) => String(u.ledgerEntryId)));
    const byMonth = {};
    for (const u of unsettled) (byMonth[u.day.slice(0, 7)] ||= []).push(u);
    for (const m of Object.keys(byMonth).sort()) {
      const rs = byMonth[m];
      const gross = r2(rs.reduce((t, u) => t + u.gross, 0));
      const feeBooked = r2(rs.reduce((t, u) => t + (u.feeBooked || 0), 0));
      const commission = r2(gross * 0.019);
      const vat = r2(commission * 0.05);
      const last = rs.map((u) => u.day).sort().pop();
      const day = [iso(addDays(parse(last), 2)), ASOF].sort()[0];     // paid two days after the last sale, never after the statement date
      groups.push({ month: m, day, ids: rs.map((u) => u.ledgerEntryId), count: rs.length, gross, commission, vat, extra: r2(commission - feeBooked), paid: r2(gross - commission - vat), text: `POS SETTLEMENT RAK-T-0457 ${day}` });
    }
    for (const g of groups) log(`  ${g.month}: ${g.count} sales, gross ${g.gross}, paid ${g.paid} on ${g.day} (commission ${g.commission} + VAT ${g.vat})`);
  }
  ledgerRows = ledgerRows.filter((r) => !cardIds.has(String(r._id)));

  // statement lines
  const lines = ledgerRows.map((r) => ({
    day: String(r.date).slice(0, 10),
    text: `${(r.voucherType || "").toUpperCase()} ${r.voucherNo || ""} ${r.narration || ""}`.replace(/\s+/g, " ").trim().slice(0, 70),
    debit: r2(r.credit || 0), credit: r2(r.debit || 0),
  }));
  for (const g of groups) lines.push({ day: g.day, text: g.text, debit: 0, credit: g.paid });
  // what only the bank knows
  const mid = iso(addDays(parse(from), 20));
  lines.push({ day: mid, text: "CHEQUE BOOK ISSUE AND SMS ALERT CHARGES", debit: 52.5, credit: 0, kind: "fee" });
  lines.push({ day: ASOF, text: "CREDIT INTEREST ON AVERAGE BALANCE", debit: 0, credit: 142.35, kind: "interest" });
  lines.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (b.credit > 0) - (a.credit > 0))); // within a day the bank posts money in first

  let bal = openingStatement;
  const grid = [["Date", "Description", "Debit", "Credit", "Balance"]];
  for (const l of lines) {
    bal = r2(bal - l.debit + l.credit);
    grid.push([dmy(l.day), l.text, l.debit ? l.debit.toFixed(2) : "", l.credit ? l.credit.toFixed(2) : "", bal.toFixed(2)]);
  }
  const statementBalance = bal;
  log(`${KEY} ${from} -> ${ASOF}: ${lines.length} statement lines, opening ${openingStatement}, closing ${statementBalance}`);
  if (DRY) { console.log(grid.slice(0, 6).map((r) => r.join(" | ")).join("\n")); return; }

  if (!prev) {
    const setup = await api("PUT", `${REC}/setup`, { accountId, startDay: from, statementOpening: openingStatement });
    if (!setup.ok) throw new Error("setup: " + setup.message);
  }
  const imp = await api("POST", `${REC}/import`, { accountId, rows: grid, fileName: `${KEY}-${ASOF}.csv` });
  if (!imp.ok) throw new Error("import: " + imp.status + " " + imp.code + " " + imp.message);
  log("statement imported:", JSON.stringify(imp.body).slice(0, 160));

  for (const g of groups) {
    const all = rowsOf(await api("GET", `${REC}/lines?accountId=${accountId}&tab=todo`));
    const line = all.find((l) => String(l.description || l.text || "").includes(g.text) && Math.abs(Number(l.amount) - g.paid) < 0.005);
    if (!line) { log("  settlement line not found for", g.month); continue; }
    const st = await api("POST", `${REC}/card/settle`, {
      accountId, lineId: line._id, receiptEntryIds: g.ids,
      extraCommission: g.extra, vat: g.vat, settlementRef: `RAK-SET-${g.day}`, note: "Acquirer settlement net of commission and VAT",
    });
    if (st.ok) log(`card settlement recorded: ${g.count} sales (${g.month}), received ${g.paid}, commission ${g.commission}, VAT ${g.vat}`);
    else log("  card settlement refused:", g.month, st.status, st.code, st.message);
  }

  const acc = await api("POST", `${REC}/matches/accept`, { accountId });
  log("matches accepted:", acc.status, JSON.stringify(acc.body).slice(0, 140));

  const todo = rowsOf(await api("GET", `${REC}/lines?accountId=${accountId}&tab=todo`));
  for (const l of todo) {
    const text = String(l.description || l.text || "");
    const kind = /INTEREST/.test(text) ? "interest" : /CHARGES|FEE/.test(text) ? "fee" : null;
    if (!kind) { log("  left to review:", text.slice(0, 60), l.amount); continue; }
    const c = await api("POST", `${REC}/lines/${l._id}/create`, { accountId, kind });
    log(`  ${kind} line posted:`, c.status, c.ok ? "" : c.code + " " + c.message);
  }

  const proof = await api("GET", `${REC}/proof?accountId=${accountId}&asOf=${ASOF}&statementBalance=${statementBalance}`);
  log("proof:", JSON.stringify(proof.body).slice(0, 360));
  const fin = await api("POST", `${REC}/reconciliations`, { accountId, asOf: ASOF, statementBalance, note: `Reconciled to ${ASOF}` });
  if (!fin.ok) { log("  NOT finished:", fin.status, fin.code, fin.message); process.exit(2); }
  log(`RECONCILED ${KEY} to ${ASOF}: statement ${statementBalance}`);
  S.recon[KEY] = { asOf: ASOF, statementBalance };
  saveState(S);
})().catch((e) => { log("RECON FAILED:", e.message); process.exit(1); });
