const { addDays } = require("./documentExpiry");

// Matching bank statement lines to the books, and proving the reconciliation. Pure: no Mongoose, so
// the rules are tested on their own and the service only fetches and saves.
//
// Everything is signed from the BANK ACCOUNT's side: money in positive, money out negative. A book
// entry on a bank account is a debit (in) or a credit (out), so a statement line and the book entry
// it belongs to carry the same sign and the same amount.
//
//   line  = { id, day, amount, description, reference, chequeNo }
//   entry = { id, day, amount, voucherNo, chequeNo, reference, party, narration, type }
//
// A suggestion is never applied by this module; it ranks and says why. A person (or "accept all
// high") applies it.

const cents = (n) => Math.round((Number(n) || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;

const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
const isWorkingDay = (day) => { const w = weekday(day); return w !== 0 && w !== 6; }; // the UAE week is Monday to Friday

// Working days between two days (the order does not matter): same day 0, Friday to Monday 1.
function businessDays(a, b) {
  if (a === b) return 0;
  const [from, to] = a < b ? [a, b] : [b, a];
  let n = 0;
  let d = from;
  for (let i = 0; i < 400 && d < to; i += 1) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) n += 1;
  }
  return n;
}

const stripZeros = (s) => String(s || "").replace(/\D/g, "").replace(/^0+/, "");

// How well one book entry fits one statement line, or null when it cannot (a different amount or
// the other direction). Exact amounts only: a difference is explained by posting an entry, not by a
// loose match.
function scorePair(line, entry) {
  if (cents(line.amount) !== cents(entry.amount) || cents(line.amount) === 0) return null;
  const reasons = ["same amount"];
  let score = 40;

  const days = businessDays(line.day, entry.day);
  let bonus = days === 0 ? 30 : days <= 1 ? 25 : days <= 3 ? 20 : days <= 7 ? 10 : days <= 14 ? 4 : 0;
  if (entry.day > line.day && days > 0) bonus = Math.max(0, bonus - 5); // the books usually come first
  score += bonus;
  if (days === 0) reasons.push("same day");
  else if (days <= 7) reasons.push(`${days} working day${days === 1 ? "" : "s"} apart`);
  else reasons.push(`${days} working days apart`);

  const text = compact(`${line.description} ${line.reference}`);

  // A cheque number is evidence when it is at least four digits as printed ("000777" is), judged
  // before leading zeros are dropped; the comparison ignores them, because banks pad and we do not.
  const chqRaw = String(entry.chequeNo || "").replace(/\D/g, "");
  const chq = stripZeros(chqRaw);
  if (chqRaw.length >= 4 && chq) {
    if (stripZeros(line.chequeNo) === chq) { score += 45; reasons.push(`cheque ${entry.chequeNo} is on the line`); }
    else if ((chqRaw.length >= 5 && text.includes(chqRaw)) || (chq.length >= 5 && text.includes(chq))) { score += 35; reasons.push(`cheque ${entry.chequeNo} is in the text`); }
  }
  const voucher = compact(entry.voucherNo);
  if (voucher.length >= 6 && text.includes(voucher)) { score += 40; reasons.push(`${entry.voucherNo} is in the text`); }
  const ref = compact(entry.reference);
  if (ref.length >= 5 && text.includes(ref)) { score += 30; reasons.push(`reference ${entry.reference} is in the text`); }
  const names = String(entry.party || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !["trading", "general", "company", "limited", "group"].includes(t));
  const named = names.filter((t) => text.includes(t));
  if (named.length) { score += Math.min(15, named.length * 5); reasons.push(`name ${entry.party} is in the text`); }

  return { score, reasons, days };
}

// Candidates for one line, best first.
function rank(line, entries) {
  const out = [];
  for (const entry of entries) {
    const s = scorePair(line, entry);
    if (s) out.push({ entry, ...s });
  }
  return out.sort((a, b) => b.score - a.score || a.days - b.days || String(a.entry.id).localeCompare(String(b.entry.id)));
}

const HIGH = 85;
const MEDIUM = 60;
const UNIQUE_GAP = 15;

// Combinations of 2..max entries that add up to the line's amount exactly. Used for a deposit that
// is several receipts, or a payment run. Returns the combination only when there is exactly one:
// two different ways to make the same total is a guess, and a guess is not a suggestion.
function findGroup(line, entries, { maxItems = 5, windowDays = 10, budget = 60000, maxPool = 30 } = {}) {
  const target = cents(line.amount);
  if (target === 0) return null;
  const sign = target > 0 ? 1 : -1;
  const want = Math.abs(target);
  const pool = entries
    .filter((e) => cents(e.amount) * sign > 0 && Math.abs(cents(e.amount)) < want)
    .filter((e) => businessDays(line.day, e.day) <= windowDays && !(e.day > line.day && businessDays(line.day, e.day) > 1))
    .sort((a, b) => businessDays(line.day, a.day) - businessDays(line.day, b.day))
    .slice(0, maxPool)
    .map((e) => ({ e, c: Math.abs(cents(e.amount)) }))
    .sort((a, b) => b.c - a.c);
  if (pool.length < 2) return null;
  const suffix = new Array(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + pool[i].c;

  const found = [];
  let nodes = 0;
  const walk = (i, left, picked) => {
    if (found.length > 1 || nodes > budget) return;
    nodes += 1;
    if (left === 0) { if (picked.length >= 2) found.push(picked.map((p) => p.e)); return; }
    if (i >= pool.length || picked.length >= maxItems || suffix[i] < left) return;
    if (pool[i].c <= left) walk(i + 1, left - pool[i].c, [...picked, pool[i]]);
    walk(i + 1, left, picked);
  };
  walk(0, want, []);
  return found.length === 1 ? found[0] : null;
}

// One suggestion per open line, where there is a good one. Each book entry is offered to one line.
//   { confidence: "high" | "medium", score, reasons[], entryIds[], kind: "one" | "group" }
function suggest(lines, entries) {
  const ranked = lines.map((line) => ({ line, cands: rank(line, entries) })).filter((r) => r.cands.length);
  // Judge each line, then give the strongest lines first pick of an entry.
  const judged = ranked.map(({ line, cands }) => {
    const [best, second] = cands;
    const unique = !second || best.score - second.score >= UNIQUE_GAP;
    return { line, cands, score: best.score + (unique ? UNIQUE_GAP : 0), unique };
  }).sort((a, b) => b.score - a.score || a.line.day.localeCompare(b.line.day));

  const taken = new Set();
  const out = new Map();
  for (const j of judged) {
    const free = j.cands.filter((c) => !taken.has(String(c.entry.id)));
    if (!free.length) continue;
    const best = free[0];
    const second = free[1];
    const unique = !second || best.score - second.score >= UNIQUE_GAP;
    // an entry two lines are equally good candidates for is not clear-cut
    const rivals = judged.filter((o) => o !== j && o.cands.some((c) => String(c.entry.id) === String(best.entry.id) && Math.abs(c.score - best.score) < UNIQUE_GAP)).length;
    const total = best.score + (unique && !rivals ? UNIQUE_GAP : 0);
    const reasons = [...best.reasons];
    if (unique && !rivals) reasons.push("no other candidate fits as well");
    const confidence = total >= HIGH && unique && !rivals ? "high" : total >= MEDIUM ? "medium" : null;
    if (!confidence) continue;
    taken.add(String(best.entry.id));
    out.set(String(j.line.id), { confidence, score: total, reasons, entryIds: [best.entry.id], kind: "one" });
  }

  // Lines with nothing good one-to-one: perhaps a deposit made of several entries.
  for (const line of lines) {
    if (out.has(String(line.id))) continue;
    const free = entries.filter((e) => !taken.has(String(e.id)));
    const group = findGroup(line, free);
    if (!group) continue;
    for (const e of group) taken.add(String(e.id));
    out.set(String(line.id), { confidence: "medium", score: MEDIUM, reasons: [`${group.length} entries add up to exactly this amount`], entryIds: group.map((e) => e.id), kind: "group" });
  }
  return out;
}

// ----------------------------------------------------------------------------------- the proof
// Is the statement balance the books balance, once what has not reached the other side is allowed
// for? All signed from the bank's side.
//
//   Balance per statement                    S
//   + book items the statement has not seen  (deposits in transit, outstanding payments)
//   = adjusted bank balance
//   Balance per books                        B
//   + bank items the books have not seen     (a fee not yet posted, interest)
//   = adjusted book balance
//
// The two adjusted balances must be equal. "Seen" is judged AS OF the date: a receipt booked on the
// 30th and credited by the bank on the 2nd is in transit on the 30th, and a matched pair is only
// settled once both halves are on or before the date.
//
//   entries: the books' bank entries dated on or before asOf   { id, day, amount, groupId|null, ... }
//   lines:   the statement lines dated on or before asOf        { id, day, amount, state, groupId|null, ... }
//   groups:  matched groups; a group is entries + lines of one match. Entries or lines of a group
//            that fall AFTER asOf are simply not passed in, which is what makes a split pair show up.
function buildProof({ statementBalance, bookBalance, entries, lines }) {
  const byGroup = new Map();
  const slot = (id) => { if (!byGroup.has(id)) byGroup.set(id, { entries: 0, lines: 0, entryItems: [] }); return byGroup.get(id); };
  const bookOnly = []; // book items the statement has not seen
  const bankOnly = []; // statement lines the books have not seen
  const ignored = [];

  for (const e of entries) {
    if (e.groupId) { const g = slot(String(e.groupId)); g.entries += cents(e.amount); g.entryItems.push(e); } else bookOnly.push({ ...e, kind: "entry" });
  }
  for (const l of lines) {
    if (l.groupId) slot(String(l.groupId)).lines += cents(l.amount);
    else if (l.state === "ignored") ignored.push({ ...l, kind: "line" });
    else bankOnly.push({ ...l, kind: "line" });
  }
  // a matched group balances itself in the end; as of a date, what is left over is in transit one way or the other
  const residuals = [];
  for (const [groupId, g] of byGroup) {
    const r = g.entries - g.lines;
    if (r !== 0) residuals.push({ groupId, amount: fromCents(r), kind: "group" });
  }
  const bookResidual = residuals.filter((r) => r.amount > 0);
  const bankResidual = residuals.filter((r) => r.amount < 0).map((r) => ({ ...r, amount: -r.amount }));

  const sum = (list) => list.reduce((t, x) => t + cents(x.amount), 0);
  // ignored lines are bank items the books will never see; they stay in the proof so it still adds up
  const netBook = sum(bookOnly) + sum(bookResidual);
  const netBank = sum(bankOnly) + sum(ignored) + sum(bankResidual);
  const adjustedBank = cents(statementBalance) + netBook;
  const adjustedBook = cents(bookBalance) + netBank;
  const receipts = [...bookOnly.filter((e) => cents(e.amount) > 0), ...bookResidual];
  const payments = [...bookOnly.filter((e) => cents(e.amount) < 0)];
  return {
    statementBalance: fromCents(cents(statementBalance)),
    bookBalance: fromCents(cents(bookBalance)),
    depositsInTransit: { items: receipts, total: fromCents(sum(receipts)) },
    outstandingPayments: { items: payments, total: fromCents(sum(payments)) },
    bankItemsNotInBooks: { items: [...bankOnly, ...bankResidual], total: fromCents(sum(bankOnly) + sum(bankResidual)) },
    ignored: { items: ignored, total: fromCents(sum(ignored)) },
    adjustedBank: fromCents(adjustedBank),
    adjustedBook: fromCents(adjustedBook),
    difference: fromCents(adjustedBank - adjustedBook),
    openLines: bankOnly.length,
  };
}

module.exports = { businessDays, isWorkingDay, scorePair, rank, findGroup, suggest, buildProof, HIGH, MEDIUM, cents, fromCents };
