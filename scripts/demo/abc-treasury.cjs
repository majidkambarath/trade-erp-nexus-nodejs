// Treasury for 2026: the engine's monthly sweep only ever moved money OUT of the collection account, so the operating account
// (ENBD) ran up to -1.0M while Mashreq held 800k. A real finance person moves money between the company's own accounts and, when
// the working capital needs it, the owner puts capital in. This plans exactly that from the ledger as it stands and posts it
// as ordinary contra / journal vouchers (dated in the open year, so nothing locked or reconciled is touched).
//   E=... P=... DRY=1 node abc-treasury.cjs     (prints the plan, posts nothing)
//   E=... P=...        node abc-treasury.cjs     (posts it)
const { api, r2, loadState, saveState, log } = require("./abc-lib.cjs");
const D = require("./abc-data.cjs");

const FROM = "2026-01-01", TO = "2026-10-09";
const DRY = !!process.env.DRY;
// The collection account (RAK) only gives: the terminal and walk-in collections land there and are swept out. The two operating
// accounts (ENBD, Mashreq) top each other up. A transfer is sized to carry the account for a while, not for a day.
const FLOOR = { enbd: 10000, mashreq: 10000 };                   // an operating account is topped up when it falls below this
const KEEP = { rak: 25000, enbd: 60000, mashreq: 60000 };        // what a donor keeps after giving
const BUFFER = 70000;                                            // top an account up past its floor so it is not topped up daily
const CAPITAL_ON = "2026-01-02";
const NAMES = { enbd: "Emirates NBD", mashreq: "Mashreq", rak: "RAKBANK" };
const up10k = (n) => Math.ceil(n / 10000) * 10000;

(async () => {
  const S = loadState();
  const acct = {};
  const open = {}, daily = {};
  for (const k of ["enbd", "mashreq", "rak"]) {
    const def = D.BANK_ACCOUNTS.find((b) => b.bank === k);
    acct[k] = S.ids.acct[def.name];
    const r = await api("GET", `/accounting/accounts/${acct[k]}/ledger?from=${FROM}&to=${TO}`);
    if (!r.body?.rows) throw new Error("ledger unreadable for " + k);
    open[k] = r2(r.body.opening || 0);
    daily[k] = {};
    for (const x of r.body.rows) {
      const d = String(x.date).slice(0, 10);
      daily[k][d] = r2((daily[k][d] || 0) + (x.debit || 0) - (x.credit || 0));
    }
  }
  const days = [...new Set([...Object.keys(daily.enbd), ...Object.keys(daily.mashreq), ...Object.keys(daily.rak), CAPITAL_ON])].sort();

  // how much capital the working capital needs: the smallest 50k step that keeps the two operating accounts together >= 40k, every day
  const simulate = (capital) => {
    const bal = { ...open };
    let min = Infinity;
    for (const d of days) {
      for (const k of Object.keys(bal)) bal[k] = r2(bal[k] + (daily[k][d] || 0));
      if (d === CAPITAL_ON) bal.enbd = r2(bal.enbd + capital);
      min = Math.min(min, r2(bal.enbd + bal.mashreq));
    }
    return min;
  };
  let capital = 0;
  while (simulate(capital) < 40000 && capital < 3000000) capital += 50000;
  log(`working capital: operating accounts' combined low without capital ${simulate(0)}; owner capital needed ${capital}`);

  // day by day: apply the day's movements, top up whatever fell below its floor from the richest other account
  const bal = { ...open };
  const plan = [];
  const lowest = { enbd: Infinity, mashreq: Infinity, rak: Infinity };
  for (const d of days) {
    for (const k of Object.keys(bal)) bal[k] = r2(bal[k] + (daily[k][d] || 0));
    if (d === CAPITAL_ON && capital > 0) { bal.enbd = r2(bal.enbd + capital); plan.push({ kind: "capital", date: d, amount: capital }); }
    for (const k of ["enbd", "mashreq"]) {
      if (bal[k] >= FLOOR[k]) continue;
      let need = up10k(FLOOR[k] - bal[k] + BUFFER);
      const other = k === "enbd" ? "mashreq" : "enbd";
      for (const o of [other]) {                                 // RAK is left alone: its own monthly sweeps are already in the ledger
        if (need < 10000) break;
        const spare = Math.floor(r2(bal[o] - KEEP[o]) / 10000) * 10000;
        const give = Math.min(need, spare);
        if (give < 10000) continue;
        plan.push({ kind: "contra", date: d, from: o, to: k, amount: give });
        bal[o] = r2(bal[o] - give);
        bal[k] = r2(bal[k] + give);
        need -= give;
      }
    }
    for (const k of Object.keys(bal)) lowest[k] = Math.min(lowest[k], bal[k]);
  }
  const contras = plan.filter((p) => p.kind === "contra");
  log(`plan: ${plan.filter((p) => p.kind === "capital").length} capital injection, ${contras.length} transfers between own accounts, ${r2(contras.reduce((t, c) => t + c.amount, 0))} moved in all`);
  log("lowest day-end balance after the plan:", JSON.stringify(lowest), "| closing:", JSON.stringify(bal));
  for (const p of plan) console.log("  ", p.date, p.kind === "capital" ? `CAPITAL ${p.amount} -> Emirates NBD` : `${NAMES[p.from]} -> ${NAMES[p.to]}  ${p.amount}`);
  if (DRY) return;

  S.treasury ||= { posted: [] };
  const done = new Set(S.treasury.posted);
  let ok = 0, bad = 0;
  for (const p of plan) {
    const key = `${p.date}|${p.kind}|${p.from || ""}|${p.to || ""}|${p.amount}`;
    if (done.has(key)) continue;
    let r;
    if (p.kind === "capital") {
      const owner = S.ids.acct["Owner's Capital"];
      r = await api("POST", "/vouchers/vouchers", { voucherType: "journal", date: p.date, narration: "Capital introduced by the owner to fund working capital for the 2026 trading year", lines: [{ accountId: acct.enbd, debit: p.amount }, { accountId: owner, credit: p.amount }] });
    } else {
      const text = p.from === "mashreq" ? "Funds moved from Mashreq to Emirates NBD operating account"
        : p.from === "rak" ? `Collections moved from RAKBANK to ${NAMES[p.to]} operating account`
          : `Funds moved from Emirates NBD to ${NAMES[p.to]} operating account`;
      r = await api("POST", "/vouchers/vouchers", { voucherType: "contra", ledgerBased: true, fromAccountId: acct[p.from], toAccountId: acct[p.to], totalAmount: p.amount, narration: text, date: p.date });
    }
    if (r.ok) { ok += 1; done.add(key); S.treasury.posted = [...done]; saveState(S); } else { bad += 1; log("  REFUSED", key, r.status, r.code, r.message); }
  }
  log(`treasury posted: ${ok} vouchers, ${bad} refused`);
})().catch((e) => { log("TREASURY FAILED:", e.message); process.exit(1); });
