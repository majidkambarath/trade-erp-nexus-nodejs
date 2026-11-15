// Phase "bank": Emirates NBD is reconciled to the end of last month, then this month's statement is
// imported and left for the person giving the demo: four lines the engine can match by itself, one
// bank charge that nobody entered, and one line nobody knows. The statement is built from the
// account's own ledger the way a bank would show it (money in = credit, money out = debit), as
// scripts/demo/abc-recon.cjs does; the only things a bank knows that the books do not are the charge
// and the unknown line.
const D = require("../abc-data.cjs");
const { r2, iso, parse, addDays, listOf, must } = require("./lib.cjs");

const REC = "/banking/reconciliation";
const dmy = (d) => { const [y, m, dd] = String(d).slice(0, 10).split("-"); return `${dd}/${m}/${y}`; };
const rowsOf = (r) => (Array.isArray(r.body) ? r.body : r.body?.rows || r.body?.lines || r.body?.entries || []);
const textOf = (r) => `${(r.voucherType || "").toUpperCase()} ${r.voucherNo || ""} ${r.narration || ""}`.replace(/\s+/g, " ").trim().slice(0, 70);

function grid(opening, lines) {
  let bal = opening;
  const out = [["Date", "Description", "Debit", "Credit", "Balance"]];
  for (const l of lines) {
    bal = r2(bal - l.debit + l.credit);
    out.push([dmy(l.day), l.text, l.debit ? l.debit.toFixed(2) : "", l.credit ? l.credit.toFixed(2) : "", bal.toFixed(2)]);
  }
  return { rows: out, closing: bal };
}

async function bank(ctx) {
  const { api, log, TODAY, START } = ctx;
  const accountId = ctx.ids.BANK.enbd;
  const today = parse(TODAY);
  const asOf = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))); // last day of last month
  const from = iso(addDays(parse(START), 1));

  // ---- period one: everything up to the end of last month, matched and finished
  const led = (await api("GET", `/accounting/accounts/${accountId}/ledger?from=${from}&to=${asOf}`)).body;
  if (!led?.rows) throw new Error("could not read the Emirates NBD ledger");
  const lines = led.rows.map((r) => ({ day: String(r.date).slice(0, 10), text: textOf(r), debit: r2(r.credit || 0), credit: r2(r.debit || 0) }));
  lines.push({ day: asOf, text: "CREDIT INTEREST ON AVERAGE BALANCE", debit: 0, credit: 142.35, kind: "interest" });
  lines.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (b.credit > 0) - (a.credit > 0)));
  const first = grid(led.opening, lines);
  log(`bank: ${lines.length} statement lines to ${asOf}, opening ${led.opening}, closing ${first.closing}`);

  must(await api("PUT", `${REC}/setup`, { accountId, startDay: from, statementOpening: led.opening }), "reconciliation set-up");
  must(await api("POST", `${REC}/import`, { accountId, rows: first.rows, fileName: `enbd-${asOf}.csv` }), "statement import");
  const acc = await api("POST", `${REC}/matches/accept`, { accountId });
  log("bank: matches accepted:", acc.status, JSON.stringify(acc.body).slice(0, 120));
  for (const l of rowsOf(await api("GET", `${REC}/lines?accountId=${accountId}&tab=todo`))) {
    const text = String(l.description || l.text || "");
    if (/INTEREST/.test(text)) await api("POST", `${REC}/lines/${l._id}/create`, { accountId, kind: "interest" });
  }
  const fin = await api("POST", `${REC}/reconciliations`, { accountId, asOf, statementBalance: first.closing, note: `Reconciled to ${asOf}` });
  if (!fin.ok) {
    const proof = await api("GET", `${REC}/proof?accountId=${accountId}&asOf=${asOf}&statementBalance=${first.closing}`);
    throw new Error(`reconciliation not finished: ${fin.status} ${fin.code} ${fin.message} ${JSON.stringify(proof.body).slice(0, 300)}`);
  }
  log(`bank: Emirates NBD reconciled to ${asOf}`);

  // ---- period two: this month, left open for the demo
  const from2 = iso(addDays(parse(asOf), 1));
  const yesterday = iso(addDays(today, -1));
  const cur = (await api("GET", `/accounting/accounts/${accountId}/ledger?from=${from2}&to=${yesterday}`)).body;
  const own = (cur?.rows || []).filter((r) => (r.voucherType || "") !== "expense").slice(0, 4);
  const second = own.map((r) => ({ day: String(r.date).slice(0, 10), text: textOf(r), debit: r2(r.credit || 0), credit: r2(r.debit || 0) }));
  second.push({ day: yesterday, text: "SMS ALERT AND ACCOUNT MAINTENANCE CHARGES", debit: 52.5, credit: 0 });
  second.push({ day: yesterday, text: "INWARD REMITTANCE REF 7740291 UNKNOWN SENDER", debit: 0, credit: 3275, });
  second.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (b.credit > 0) - (a.credit > 0)));
  const next = grid(first.closing, second);
  must(await api("POST", `${REC}/import`, { accountId, rows: next.rows, fileName: `enbd-${yesterday}.csv` }), "second statement import");
  log(`bank: ${second.length} lines imported for ${from2}..${yesterday}, left open (statement balance ${next.closing})`);
}

module.exports = { bank };
