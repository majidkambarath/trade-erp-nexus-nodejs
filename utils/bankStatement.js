const crypto = require("crypto");

// Reading a bank statement into clean lines. Pure: no Mongoose, no clock, so the rules are tested
// on their own. A statement arrives as a grid of cells (a CSV or Excel sheet read in the browser,
// as strings, numbers and "YYYY-MM-DD" dates) or as MT940 text, and leaves as lines in the shape
// the reconciliation stores:
//
//   { lineNo, day: "YYYY-MM-DD", valueDay, description, reference, chequeNo, amount, balance }
//
// `amount` is signed from the BANK ACCOUNT's side: money in is positive, money out is negative.
// A statement says debit and credit from the bank's side, which is the opposite of the books, so a
// column called "Debit" is money OUT of the account and is stored negative. Bank layouts are not
// hard-coded (they change, and nobody could verify them); the mapping says which column is what.

const cents = (n) => Math.round((Number(n) || 0) * 100);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n, w = 2) => String(n).padStart(w, "0");

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthOf = (word) => MONTHS[String(word).slice(0, 4).toLowerCase()] || MONTHS[String(word).slice(0, 3).toLowerCase()] || null;

const validDay = (y, m, d) => {
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const ymd = (y, m, d) => (validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);
const fullYear = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

// "DMY" (the UAE habit), "MDY" or "YMD" -> which part comes first in a numeric date like 03/04/2026.
function detectOrder(values) {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = /^\s*(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\b/.exec(String(v ?? ""));
    if (!m) continue;
    if (Number(m[1]) > 12) dmy += 1;
    else if (Number(m[2]) > 12) mdy += 1;
  }
  return mdy > dmy ? "MDY" : "DMY";
}

// One cell to a calendar day, or null. `order` says how a numeric 03/04/2026 reads.
function parseDay(value, order = "DMY") {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : ymd(value.getFullYear(), value.getMonth() + 1, value.getDate());
  if (typeof value === "number") {
    // an Excel serial number (days since 1899-12-30)
    if (value > 20000 && value < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = String(value).trim();
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/. ]+([A-Za-z]{3,9})\.?[-/. ,]+(\d{2,4})(?:\s.*)?$/.exec(s))) {
    const mo = monthOf(m[2]);
    return mo ? ymd(fullYear(+m[3]), mo, +m[1]) : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?[ -]+(\d{1,2}),?[ -]+(\d{2,4})(?:\s.*)?$/.exec(s))) {
    const mo = monthOf(m[1]);
    return mo ? ymd(fullYear(+m[3]), mo, +m[2]) : null;
  }
  if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})(?:[T ].*)?$/.exec(s))) {
    const [a, b, y] = [+m[1], +m[2], fullYear(+m[3])];
    return order === "MDY" ? ymd(y, a, b) : ymd(y, b, a);
  }
  return null;
}

// "1,234.50", "(1,234.50)", "-1234.5", "1234.50 CR", "AED 1,234.50", "1,234.50-" to a number, or null
// for a blank. A trailing/leading CR or DR is returned as `side` so a mapping can use it.
function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s) return null;
  let side = null;
  const tag = /(?:^|\s|(?<=\d))(CR|DR|C|D)\.?$/i.exec(s) || /^(CR|DR)\s/i.exec(s);
  if (tag) {
    side = /^c/i.test(tag[1]) ? "CR" : "DR";
    s = s.replace(tag[0], "").trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/^(AED|USD|EUR|SAR)\s*/i, "").replace(/\s*(AED|USD|EUR|SAR)$/i, "");
  if (/^[-+]/.test(s)) { if (s[0] === "-") negative = !negative; s = s.slice(1); }
  s = s.replace(/[,\s]/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const out = negative ? -n : n;
  return side ? { value: out, side } : out;
}
const amountOf = (v) => {
  const r = parseAmount(v);
  return r && typeof r === "object" ? r.value : r;
};

// A cheque number written inside a narration: "CHQ 000123", "Cheque No: 456789", "CHEQUE DEPOSIT 123456".
function extractChequeNo(text) {
  const m = /(?:\bCHQ|\bCHEQUE|\bCHECK|\bCHK)\b[^0-9]{0,12}(\d{4,12})/i.exec(String(text || ""));
  return m ? m[1] : "";
}

const normText = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- guessing the mapping
const HEADER_WORDS = {
  date: ["transaction date", "txn date", "trans date", "posting date", "booking date", "date"],
  valueDate: ["value date", "val date", "value dt"],
  description: ["description", "narration", "narrative", "particulars", "details", "transaction details", "remarks"],
  reference: ["reference", "ref no", "ref", "transaction reference", "customer reference", "bank reference"],
  cheque: ["cheque no", "cheque number", "chq no", "chq", "cheque", "check no"],
  debit: ["debit", "withdrawal", "withdrawals", "debits", "money out", "paid out", "dr"],
  credit: ["credit", "deposit", "deposits", "credits", "money in", "paid in", "cr"],
  amount: ["amount", "transaction amount", "amt"],
  flag: ["dr/cr", "cr/dr", "debit/credit", "type", "sign"],
  balance: ["balance", "running balance", "closing balance", "available balance", "bal"],
};
const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z/ ]+/g, " ").replace(/\s+/g, " ").trim();

function scoreHeaderRow(row) {
  const cells = (row || []).map(norm).filter(Boolean);
  if (cells.length < 3) return 0;
  let hits = 0;
  for (const c of cells) for (const words of Object.values(HEADER_WORDS)) if (words.includes(c)) { hits += 1; break; }
  return hits;
}

// The first row that reads like a header (some banks put account details above it).
function findHeaderRow(rows) {
  let best = { index: -1, hits: 0 };
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const hits = scoreHeaderRow(rows[i]);
    if (hits > best.hits) best = { index: i, hits };
  }
  return best.hits >= 2 ? best.index : -1;
}

function guessMapping(rows) {
  const headerRow = findHeaderRow(rows);
  const headers = headerRow >= 0 ? rows[headerRow].map((h) => String(h ?? "").trim()) : [];
  const idx = {};
  const claim = (key, exactOnly = false) => {
    for (const word of HEADER_WORDS[key]) {
      const i = headers.findIndex((h, n) => norm(h) === word && !Object.values(idx).includes(n));
      if (i >= 0) { idx[key] = i; return; }
    }
    if (exactOnly) return;
    for (const word of HEADER_WORDS[key]) {
      if (word.length < 5) continue;
      const i = headers.findIndex((h, n) => norm(h).includes(word) && !Object.values(idx).includes(n));
      if (i >= 0) { idx[key] = i; return; }
    }
  };
  for (const key of ["valueDate", "date", "balance", "debit", "credit", "cheque", "reference", "description"]) claim(key);
  // two columns, or only one of them (a statement that lists deposits only), but then no Amount column
  const hasSplit = idx.debit !== undefined || idx.credit !== undefined;
  if (!hasSplit) { claim("amount"); claim("flag", true); }
  const columns = {};
  for (const k of ["date", "valueDate", "description", "reference", "cheque", "balance"]) if (idx[k] !== undefined) columns[k] = idx[k];
  const amount = hasSplit
    ? { mode: "split", debit: idx.debit, credit: idx.credit }
    : idx.amount !== undefined
      ? { mode: idx.flag !== undefined ? "drcr" : "signed", column: idx.amount, ...(idx.flag !== undefined ? { flag: idx.flag } : {}), invert: false }
      : { mode: "signed", invert: false };
  const dateSamples = headerRow >= 0 && columns.date !== undefined ? rows.slice(headerRow + 1, headerRow + 60).map((r) => r[columns.date]) : [];
  return { headerRow, headers, mapping: { headerRow, dateFormat: detectOrder(dateSamples), columns, amount }, complete: columns.date !== undefined && (amount.mode === "split" || amount.column !== undefined) };
}

// ---------------------------------------------------------------- normalising
const cell = (row, i) => (i === undefined || i === null || i < 0 ? undefined : row[i]);
const text = (row, spec) => {
  const list = Array.isArray(spec) ? spec : spec === undefined || spec === null ? [] : [spec];
  return list.map((i) => String(cell(row, i) ?? "").trim()).filter(Boolean).join(" ");
};
const isBlankRow = (row) => !row || row.every((c) => c === null || c === undefined || String(c).trim() === "");

// Signed amount (money in positive) for one row under the mapping, or { error }.
function rowAmount(row, amount = {}) {
  const sign = amount.invert ? -1 : 1;
  if (amount.mode === "split") {
    const debit = amountOf(cell(row, amount.debit));
    const credit = amountOf(cell(row, amount.credit));
    const d = debit ? Math.abs(debit) : 0;
    const c = credit ? Math.abs(credit) : 0;
    if (!d && !c) return { blank: true };
    if (d && c) return { error: "Both a debit and a credit are filled in" };
    return { value: round2((c ? c : -d) * sign) };
  }
  const parsed = parseAmount(cell(row, amount.column));
  if (parsed === null) return { blank: true };
  let value = typeof parsed === "object" ? parsed.value : parsed;
  if (!Number.isFinite(value)) return { error: "The amount is not a number" };
  if (amount.mode === "drcr") {
    const flagText = String(cell(row, amount.flag) ?? (typeof parsed === "object" ? parsed.side : "")).trim().toUpperCase();
    if (!flagText) return { error: "No Dr/Cr marker on this line" };
    const credit = /^(CR|C|CREDIT)\b/.test(flagText);
    const debit = /^(DR|D|DEBIT)\b/.test(flagText);
    if (!credit && !debit) return { error: `Do not understand the marker "${flagText}"` };
    value = (credit ? 1 : -1) * Math.abs(value);
  } else if (typeof parsed === "object") {
    // "1,234.50 CR" in a single signed column
    value = (parsed.side === "CR" ? 1 : -1) * Math.abs(value);
  }
  return { value: round2(value * sign) };
}

// rows: the grid of cells. mapping: see guessMapping. Returns the lines in date order, what was
// wrong, and the balances the file implies.
function normaliseStatement(rows, mapping = {}) {
  const columns = mapping.columns || {};
  const start = (Number.isInteger(mapping.headerRow) ? mapping.headerRow : -1) + 1;
  const dateCol = columns.date;
  const issues = [];
  const out = [];
  let skipped = 0;
  if (dateCol === undefined) return { lines: [], issues: [{ lineNo: 0, message: "Choose the date column" }], skipped: 0, order: "ascending", opening: null, closing: null, continuity: { ok: true, breaks: [] } };
  if (!mapping.amount || (mapping.amount.mode === "split" ? mapping.amount.debit === undefined && mapping.amount.credit === undefined : mapping.amount.column === undefined)) {
    return { lines: [], issues: [{ lineNo: 0, message: "Choose the amount column(s)" }], skipped: 0, order: "ascending", opening: null, closing: null, continuity: { ok: true, breaks: [] } };
  }
  const order = mapping.dateFormat === "MDY" || mapping.dateFormat === "DMY" ? mapping.dateFormat : detectOrder(rows.slice(start).map((r) => cell(r, dateCol)));

  for (let i = start; i < rows.length; i += 1) {
    const row = rows[i];
    const lineNo = i + 1; // the row number as the person sees it in their file
    if (isBlankRow(row)) continue;
    const day = parseDay(cell(row, dateCol), order);
    const amt = rowAmount(row, mapping.amount);
    if (!day && (amt.blank || amt.error)) { skipped += 1; continue; } // a heading, total or note
    if (!day) { issues.push({ lineNo, message: `The date "${String(cell(row, dateCol)).trim()}" could not be read` }); continue; }
    if (amt.blank) { skipped += 1; continue; } // a dated line with nothing to post, e.g. an opening balance row
    if (amt.error) { issues.push({ lineNo, message: amt.error }); continue; }
    if (amt.value === 0) { skipped += 1; continue; }
    const valueDay = columns.valueDate !== undefined ? parseDay(cell(row, columns.valueDate), order) : null;
    const description = text(row, columns.description);
    const balanceRaw = columns.balance !== undefined ? amountOf(cell(row, columns.balance)) : null;
    const reference = text(row, columns.reference);
    const chequeCell = text(row, columns.cheque);
    out.push({
      lineNo, day, valueDay: valueDay || null, description, reference,
      chequeNo: chequeCell || extractChequeNo(`${description} ${reference}`),
      amount: amt.value, balance: balanceRaw === null || balanceRaw === undefined ? null : round2(balanceRaw),
    });
  }

  // Newest-first exports are put in date order. A stable sort keeps same-day lines in the order
  // the file gave them (reversed for a newest-first file, which lists the day's last line first).
  let direction = "ascending";
  if (out.length > 1 && out[0].day > out[out.length - 1].day) {
    direction = "descending";
    out.reverse();
  }
  const lines = out.map((l, n) => ({ ...l, seq: n }));
  const sorted = [...lines].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.seq - b.seq)).map(({ seq, ...l }) => l);

  const withBalance = sorted.length > 0 && sorted.every((l) => l.balance !== null);
  const opening = withBalance ? round2(sorted[0].balance - sorted[0].amount) : null;
  const closing = withBalance ? sorted[sorted.length - 1].balance : null;
  return { lines: sorted, issues, skipped, order: direction, opening, closing, continuity: checkContinuity(sorted) };
}

// Each running balance must be the one before plus this line's amount.
function checkContinuity(lines) {
  const breaks = [];
  if (!lines.length || !lines.every((l) => l.balance !== null && l.balance !== undefined)) return { ok: true, checked: false, breaks };
  for (let i = 1; i < lines.length; i += 1) {
    const expected = round2(lines[i - 1].balance + lines[i].amount);
    if (Math.abs(expected - lines[i].balance) > 0.005) breaks.push({ lineNo: lines[i].lineNo, expected, found: lines[i].balance });
  }
  return { ok: breaks.length === 0, checked: true, breaks };
}

// A stable identity for a line, so the same line imported twice is recognised. `occurrence` tells
// two genuinely identical lines on one day apart (two AED 25.00 fees), so neither is lost.
function fingerprint(line) {
  const key = [line.day, line.valueDay || "", cents(line.amount), normText(line.description), normText(line.reference), line.balance === null || line.balance === undefined ? "" : cents(line.balance)].join("|");
  return crypto.createHash("sha1").update(key).digest("hex");
}
function withFingerprints(lines) {
  const seen = new Map();
  return lines.map((l) => {
    const fp = fingerprint(l);
    const occurrence = (seen.get(fp) || 0) + 1;
    seen.set(fp, occurrence);
    return { ...l, fingerprint: fp, occurrence };
  });
}

// ---------------------------------------------------------------- MT940
// Statement text from a corporate bank: :60F: opening balance, then :61: lines each followed by
// :86: narrative, then :62F: closing balance. Amounts use a comma for the decimal point.
function mt940Day(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  return ymd(fullYear(+yymmdd.slice(0, 2)), +yymmdd.slice(2, 4), +yymmdd.slice(4, 6));
}
function mt940Balance(rest) {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/.exec(rest.trim());
  if (!m) return null;
  const amount = Number(m[4].replace(",", "."));
  return { day: mt940Day(m[2]), currency: m[3], amount: round2(m[1] === "C" ? amount : -amount) };
}

function parseMt940(textInput) {
  const raw = String(textInput || "").replace(/\r/g, "").split("\n");
  // continuation lines (no leading tag) belong to the field above them
  const fields = [];
  for (const line of raw) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1], value: m[2] });
    else if (fields.length && line.trim() && !/^[-{}]/.test(line)) fields[fields.length - 1].value += `\n${line}`;
  }
  const statements = [];
  let cur = null;
  let lastLine = null;
  for (const f of fields) {
    if (f.tag === "20") {
      cur = { reference: f.value.trim(), account: "", statementNo: "", opening: null, closing: null, currency: "", lines: [] };
      statements.push(cur);
      lastLine = null;
    } else if (!cur) {
      continue;
    } else if (f.tag === "25") cur.account = f.value.trim();
    else if (f.tag === "28C" || f.tag === "28") cur.statementNo = f.value.trim();
    else if (f.tag === "60F" || f.tag === "60M") { cur.opening = mt940Balance(f.value); cur.currency = cur.opening?.currency || cur.currency; }
    else if (f.tag === "62F" || f.tag === "62M") cur.closing = mt940Balance(f.value);
    else if (f.tag === "61") {
      const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)([A-Z][A-Z0-9]{3})([^\n]*?)(?:\/\/([^\n]*))?(?:\n(.*))?$/s.exec(f.value.trim());
      if (!m) { lastLine = null; cur.lines.push({ error: `Cannot read :61: ${f.value.slice(0, 60)}` }); continue; }
      const valueDay = mt940Day(m[1]);
      let entryDay = valueDay;
      if (m[2] && valueDay) {
        const year = Number(valueDay.slice(0, 4));
        const cand = [year - 1, year, year + 1].map((y) => ymd(y, +m[2].slice(0, 2), +m[2].slice(2))).filter(Boolean);
        entryDay = cand.sort((a, b) => Math.abs(new Date(a) - new Date(valueDay)) - Math.abs(new Date(b) - new Date(valueDay)))[0] || valueDay;
      }
      const amount = Number(m[5].replace(",", "."));
      const credit = m[3] === "C" || m[3] === "RD";
      lastLine = {
        day: entryDay, valueDay, amount: round2(credit ? amount : -amount),
        reference: (m[7] || "").trim().replace(/^NONREF$/, ""), bankReference: (m[8] || "").trim(), description: "",
      };
      cur.lines.push(lastLine);
    } else if (f.tag === "86" && lastLine) {
      lastLine.description = f.value.replace(/\n/g, " ").replace(/\?\d{2}/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return statements;
}

// An MT940 statement as the same lines a grid produces (running balances worked out from the opening).
function mt940Lines(statement) {
  const issues = [];
  const lines = [];
  let running = statement.opening ? statement.opening.amount : null;
  statement.lines.forEach((l, i) => {
    if (l.error) { issues.push({ lineNo: i + 1, message: l.error }); return; }
    if (!l.day) { issues.push({ lineNo: i + 1, message: "The date could not be read" }); return; }
    if (running !== null) running = round2(running + l.amount);
    lines.push({
      lineNo: i + 1, day: l.day, valueDay: l.valueDay, description: l.description, reference: l.reference || l.bankReference,
      chequeNo: extractChequeNo(`${l.description} ${l.reference}`), amount: l.amount, balance: running,
    });
  });
  const closing = statement.closing ? statement.closing.amount : lines.length ? lines[lines.length - 1].balance : null;
  const opening = statement.opening ? statement.opening.amount : null;
  const continuity = statement.closing && lines.length && Math.abs((lines[lines.length - 1].balance ?? NaN) - statement.closing.amount) > 0.005
    ? { ok: false, checked: true, breaks: [{ lineNo: lines[lines.length - 1].lineNo, expected: lines[lines.length - 1].balance, found: statement.closing.amount }] }
    : { ok: true, checked: running !== null, breaks: [] };
  return { lines, issues, skipped: 0, order: "ascending", opening, closing, continuity };
}

// Splits a gross amount that includes VAT into net + VAT so net + VAT is EXACTLY the gross.
// A statement fixes the gross; VAT is rounded from the net, so some grosses have no net that adds
// back exactly (1 in ~21 at 5%). Then VAT is taken as gross - net (one fils away from the rate).
function splitGross(gross, ratePercent) {
  const g = cents(gross);
  const rate = Number(ratePercent) || 0;
  if (!rate) return { net: round2(gross), vat: 0, exact: true };
  const guess = Math.round(g / (1 + rate / 100));
  for (const n of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (n + Math.round((n * rate) / 100) === g) return { net: n / 100, vat: (g - n) / 100, exact: true };
  }
  return { net: guess / 100, vat: (g - guess) / 100, exact: false };
}

module.exports = {
  parseDay, parseAmount, detectOrder, extractChequeNo, findHeaderRow, guessMapping, normaliseStatement,
  checkContinuity, fingerprint, withFingerprints, parseMt940, mt940Lines, splitGross, cents, round2,
};
