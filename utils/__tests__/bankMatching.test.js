const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../bankMatching");

const line = (id, day, amount, description = "", extra = {}) => ({ id, day, amount, description, reference: "", chequeNo: "", ...extra });
const entry = (id, day, amount, extra = {}) => ({ id, day, amount, voucherNo: "", chequeNo: "", reference: "", party: "", narration: "", type: "ledger", ...extra });

test("working days: the UAE week is Monday to Friday", () => {
  // 2026-10-05 is a Monday
  assert.equal(M.businessDays("2026-10-05", "2026-10-05"), 0);
  assert.equal(M.businessDays("2026-10-05", "2026-10-06"), 1);
  assert.equal(M.businessDays("2026-10-09", "2026-10-12"), 1, "Friday to Monday is one working day");
  assert.equal(M.businessDays("2026-10-08", "2026-10-12"), 2);
  assert.equal(M.businessDays("2026-10-12", "2026-10-08"), 2, "the order does not matter");
  assert.equal(M.isWorkingDay("2026-10-10"), false);
  assert.equal(M.isWorkingDay("2026-10-11"), false);
});

test("a pair needs the same amount in the same direction; fils matter", () => {
  assert.equal(M.scorePair(line("l", "2026-10-05", 105), entry("e", "2026-10-05", 105.01)), null);
  assert.equal(M.scorePair(line("l", "2026-10-05", 105), entry("e", "2026-10-05", -105)), null);
  assert.equal(M.scorePair(line("l", "2026-10-05", 0), entry("e", "2026-10-05", 0)), null);
  assert.ok(M.scorePair(line("l", "2026-10-05", 105.1), entry("e", "2026-10-05", 105.1)));
});

test("closer dates score higher, and an entry booked AFTER the bank line is a little less likely", () => {
  const l = line("l", "2026-10-07", 100);
  const same = M.scorePair(l, entry("a", "2026-10-07", 100)).score;
  const before = M.scorePair(l, entry("b", "2026-10-05", 100)).score;
  const farBefore = M.scorePair(l, entry("c", "2026-09-20", 100)).score;
  const after = M.scorePair(l, entry("d", "2026-10-09", 100)).score;
  const sameDistanceBefore = M.scorePair(l, entry("e", "2026-10-05", 100)).score;
  assert.ok(same > before && before > farBefore);
  assert.ok(after < sameDistanceBefore, "same distance, but after the line, scores lower");
});

test("text evidence: a cheque number, a voucher number, a reference or the customer's name lift a match", () => {
  const plain = M.scorePair(line("l", "2026-10-07", 100, "DEPOSIT"), entry("e", "2026-10-07", 100)).score;
  const shortCheque = M.scorePair(line("l", "2026-10-07", 100, "CHQ DEP 000777", { chequeNo: "000777" }), entry("e", "2026-10-07", 100, { chequeNo: "777" }));
  assert.equal(shortCheque.score, plain, "a cheque number under four digits is not evidence");
  // zero-padded short numbers are common on statements: "000777" is six digits as printed
  const padded = M.scorePair(line("l", "2026-10-07", 100, "CHQ DEP 000777", { chequeNo: "000777" }), entry("e", "2026-10-07", 100, { chequeNo: "000777" }));
  assert.ok(padded.score >= plain + 45 && padded.reasons.some((r) => /cheque 000777/.test(r)), "a padded cheque number is evidence");
  const unpadded = M.scorePair(line("l", "2026-10-07", 100, "CHQ DEP 000777", { chequeNo: "000777" }), entry("e", "2026-10-07", 100, { chequeNo: "0777" }));
  assert.ok(unpadded.score >= plain + 45, "and so is the same number written with fewer zeros");
  const otherCheque = M.scorePair(line("l", "2026-10-07", 100, "CHQ DEP 000123", { chequeNo: "000123" }), entry("e", "2026-10-07", 100, { chequeNo: "456789" }));
  assert.equal(otherCheque.score, plain, "a different cheque number is no evidence either");

  const byCheque = M.scorePair(line("l", "2026-10-07", 100, "CHQ DEP 456789", { chequeNo: "456789" }), entry("e", "2026-10-07", 100, { chequeNo: "0456789" }));
  assert.ok(byCheque.score >= plain + 45 && byCheque.reasons.some((r) => /cheque/.test(r)), "leading zeros do not matter");
  const inText = M.scorePair(line("l", "2026-10-07", 100, "INWARD CLEARING 456789 AL NOOR"), entry("e", "2026-10-07", 100, { chequeNo: "456789" }));
  assert.ok(inText.score >= plain + 35);
  const byVoucher = M.scorePair(line("l", "2026-10-07", 100, "TRF REF RV20260014"), entry("e", "2026-10-07", 100, { voucherNo: "RV-2026-0014" }));
  assert.ok(byVoucher.score >= plain + 40 && byVoucher.reasons.some((r) => /RV-2026-0014/.test(r)), "dashes in the voucher number do not matter");
  const byRef = M.scorePair(line("l", "2026-10-07", 100, "IPP FT26280ABCDE"), entry("e", "2026-10-07", 100, { reference: "FT26280ABCDE" }));
  assert.ok(byRef.score >= plain + 30);
  const byName = M.scorePair(line("l", "2026-10-07", 100, "FROM AL NOOR GROCERY"), entry("e", "2026-10-07", 100, { party: "Al Noor Grocery" }));
  assert.ok(byName.score > plain && byName.reasons.some((r) => /name/.test(r)));
  assert.equal(M.scorePair(line("l", "2026-10-07", 100, "FROM TRADING COMPANY"), entry("e", "2026-10-07", 100, { party: "Trading Company" })).score, plain, "filler words are not a name");
});

test("suggest: one clear candidate is HIGH, a few days apart is MEDIUM, ties are not suggested as clear", () => {
  const entries = [entry("e1", "2026-10-07", 105, { voucherNo: "RV-2026-0001" })];
  const sameDay = M.suggest([line("l1", "2026-10-07", 105, "TRANSFER")], entries).get("l1");
  assert.equal(sameDay.confidence, "high");
  assert.deepEqual(sameDay.entryIds, ["e1"]);
  assert.equal(sameDay.kind, "one");
  assert.ok(sameDay.reasons.includes("same amount") && sameDay.reasons.includes("same day"));

  const twoDays = M.suggest([line("l1", "2026-10-09", 105, "TRANSFER")], entries).get("l1");
  assert.equal(twoDays.confidence, "medium");

  const farAway = M.suggest([line("l1", "2026-12-20", 105, "TRANSFER")], entries);
  assert.equal(farAway.has("l1"), false, "two months apart is not a suggestion");

  const twins = [entry("a", "2026-10-07", 105), entry("b", "2026-10-07", 105)];
  const tie = M.suggest([line("l1", "2026-10-07", 105)], twins).get("l1");
  assert.ok(tie && tie.confidence === "medium", "identical candidates: a person has to choose, so never high");
});

test("suggest: a cheque number or voucher number breaks a tie between equal amounts", () => {
  const twins = [entry("a", "2026-10-07", 105, { voucherNo: "RV-2026-0001" }), entry("b", "2026-10-07", 105, { voucherNo: "RV-2026-0002" })];
  const s = M.suggest([line("l1", "2026-10-07", 105, "TRF FOR RV-2026-0002")], twins).get("l1");
  assert.equal(s.confidence, "high");
  assert.deepEqual(s.entryIds, ["b"]);
});

test("suggest: an entry is offered to one line only, the better fit", () => {
  const entries = [entry("e1", "2026-10-07", 50)];
  const lines = [line("far", "2026-10-14", 50, "X"), line("near", "2026-10-07", 50, "X")];
  const s = M.suggest(lines, entries);
  assert.equal(s.get("near").entryIds[0], "e1");
  assert.equal(s.has("far"), false);
});

test("suggest: a deposit that is several receipts is found, but only when there is one way to make it", () => {
  const entries = [entry("r1", "2026-10-05", 100), entry("r2", "2026-10-05", 250), entry("r3", "2026-10-06", 75), entry("noise", "2026-10-06", 999)];
  const s = M.suggest([line("dep", "2026-10-07", 425, "CASH DEPOSIT")], entries).get("dep");
  assert.equal(s.kind, "group");
  assert.equal(s.confidence, "medium");
  assert.deepEqual([...s.entryIds].sort(), ["r1", "r2", "r3"]);

  // two ways to make 350 (100 + 250, and 275 + 75): do not guess
  const ambiguous = [entry("a", "2026-10-05", 100), entry("b", "2026-10-05", 250), entry("c", "2026-10-05", 275), entry("d", "2026-10-05", 75)];
  assert.equal(M.suggest([line("dep", "2026-10-07", 350)], ambiguous).has("dep"), false);

  // payments: the same for money out
  const out = [entry("p1", "2026-10-05", -40), entry("p2", "2026-10-06", -60)];
  assert.deepEqual([...M.suggest([line("pay", "2026-10-07", -100)], out).get("pay").entryIds].sort(), ["p1", "p2"]);
  // entries of the wrong direction are never used
  assert.equal(M.suggest([line("dep", "2026-10-07", 100)], [entry("x", "2026-10-06", 40), entry("y", "2026-10-06", -60)]).has("dep"), false);
});

test("a group search stays inside its budget on a crowded day", () => {
  const entries = Array.from({ length: 60 }, (_, i) => entry(`e${i}`, "2026-10-05", 100 + i * 7));
  const started = Date.now();
  M.suggest([line("l", "2026-10-07", 123456.78)], entries);
  assert.ok(Date.now() - started < 2000, "gave up rather than searching for ever");
});

// ------------------------------------------------------------------------------- the proof
const book = (id, day, amount, groupId = null) => ({ id, day, amount, groupId });
const bank = (id, day, amount, state = "open", groupId = null) => ({ id, day, amount, state, groupId });

test("proof: everything matched and the balances agree", () => {
  const p = M.buildProof({
    statementBalance: 10529, bookBalance: 10529,
    entries: [book("e1", "2026-10-02", 1050, "g1"), book("e2", "2026-10-05", -500, "g2")],
    lines: [bank("l1", "2026-10-02", 1050, "matched", "g1"), bank("l2", "2026-10-05", -500, "matched", "g2")],
  });
  assert.equal(p.difference, 0);
  assert.equal(p.adjustedBank, 10529);
  assert.equal(p.openLines, 0);
});

test("proof: a deposit in transit and an outstanding cheque are the usual reconciling items", () => {
  const p = M.buildProof({
    statementBalance: 10000, bookBalance: 10000 + 300 - 120,
    entries: [book("dep", "2026-10-30", 300), book("chq", "2026-10-29", -120)],
    lines: [],
  });
  assert.equal(p.depositsInTransit.total, 300);
  assert.equal(p.outstandingPayments.total, -120);
  assert.equal(p.adjustedBank, 10180);
  assert.equal(p.adjustedBook, 10180);
  assert.equal(p.difference, 0);
});

test("proof: a bank fee the books have not posted is a bank item; ignoring it keeps it in the proof", () => {
  const open = M.buildProof({ statementBalance: 979, bookBalance: 1000, entries: [], lines: [bank("fee", "2026-10-05", -21)] });
  assert.equal(open.bankItemsNotInBooks.total, -21);
  assert.equal(open.adjustedBook, 979);
  assert.equal(open.difference, 0);
  assert.equal(open.openLines, 1, "but it still has to be matched or ignored before the reconciliation can be finished");

  const ignored = M.buildProof({ statementBalance: 979, bookBalance: 1000, entries: [], lines: [bank("fee", "2026-10-05", -21, "ignored")] });
  assert.equal(ignored.openLines, 0);
  assert.equal(ignored.ignored.total, -21);
  assert.equal(ignored.difference, 0);
});

test("proof: a pair split by the date (booked on the 30th, credited on the 2nd) is in transit on the 30th", () => {
  // as of the 30th only the book side is in view
  const p = M.buildProof({ statementBalance: 1000, bookBalance: 1250, entries: [book("e", "2026-09-30", 250, "g")], lines: [] });
  assert.equal(p.depositsInTransit.total, 250);
  assert.equal(p.difference, 0);
  // and the other way round: credited by the bank on the 30th, booked on the 2nd
  const q = M.buildProof({ statementBalance: 1250, bookBalance: 1000, entries: [], lines: [bank("l", "2026-09-30", 250, "matched", "g")] });
  assert.equal(q.bankItemsNotInBooks.total, 250);
  assert.equal(q.difference, 0);
});

test("proof: a wrong statement balance shows up as exactly the error", () => {
  const p = M.buildProof({ statementBalance: 10010, bookBalance: 10000, entries: [], lines: [] });
  assert.equal(p.difference, 10);
});

test("proof: whatever is matched, unmatched, ignored or split by the date, the difference is exactly the error in the balance", () => {
  // a seeded generator, so a failure is reproducible
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (n) => Math.floor(rnd() * n);
  const day = () => `2026-10-${String(1 + pick(28)).padStart(2, "0")}`;
  for (let trial = 0; trial < 400; trial += 1) {
    const asOf = "2026-10-20";
    const opening = pick(100000) / 100;
    const entries = [];
    const lines = [];
    // matched groups: some entries and some lines with the same total
    const groups = pick(5);
    for (let g = 0; g < groups; g += 1) {
      const amounts = Array.from({ length: 1 + pick(3) }, () => (pick(2) ? 1 : -1) * (1 + pick(50000)) / 100);
      const total = Math.round(amounts.reduce((t, a) => t + a * 100, 0));
      const parts = 1 + pick(3);
      const split = [];
      let left = total;
      for (let i = 0; i < parts - 1; i += 1) { const x = pick(2) ? Math.trunc(left / 2) : Math.trunc(left / 3); split.push(x); left -= x; }
      split.push(left);
      amounts.forEach((a, i) => entries.push({ id: `g${g}e${i}`, day: day(), amount: a, groupId: `g${g}` }));
      split.forEach((c, i) => lines.push({ id: `g${g}l${i}`, day: day(), amount: c / 100, state: "matched", groupId: `g${g}` }));
    }
    for (let i = 0; i < pick(6); i += 1) entries.push({ id: `u${i}`, day: day(), amount: (pick(2) ? 1 : -1) * (1 + pick(50000)) / 100, groupId: null });
    for (let i = 0; i < pick(6); i += 1) lines.push({ id: `b${i}`, day: day(), amount: (pick(2) ? 1 : -1) * (1 + pick(50000)) / 100, state: pick(3) ? "open" : "ignored", groupId: null });

    const within = (x) => x.day <= asOf;
    const bookBalance = opening + entries.filter(within).reduce((t, e) => t + e.amount, 0);
    const trueStatement = opening + lines.filter(within).reduce((t, l) => t + l.amount, 0);
    const error = pick(2) ? 0 : (1 + pick(1000)) / 100;
    const p = M.buildProof({ statementBalance: trueStatement + error, bookBalance, entries: entries.filter(within), lines: lines.filter(within) });
    assert.equal(Math.round(p.difference * 100), Math.round(error * 100), `trial ${trial}`);
  }
});
