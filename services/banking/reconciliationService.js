const crypto = require("crypto");
const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const { Cheque, BankMaster } = require("../../models/modules/banking/bankingModels");
const R = require("../../models/modules/banking/reconciliationModels");
const { groupFamily } = require("./cardService");
const BankMasterService = require("./bankMasterService");
const FinancialService = require("../financial/financialService");
const NumberSeriesService = require("../core/numberSeriesService");
const Core = require("./reconciliationCore");
const S = require("../../utils/bankStatement");
const M = require("../../utils/bankMatching");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { round2 } = require("../../utils/accounting");
const { dubaiDay, todayInDubai, addDays } = require("../../utils/documentExpiry");

// Bank reconciliation: bring a bank account's statement and its ledger into agreement, line by
// line, and prove it as of a date. A statement line is matched to entries the books already have,
// or an entry is posted for it (reconciliationPosting.js); a match always adds up exactly, so the
// proof stays a plain sum. Nothing here edits a posted entry.

const { cents, fromCents, toId } = Core;
const MAX_ROWS = 20000;
const OPEN_LIMIT = 3000;

// A transaction around a unit of work. Retries on a transient conflict, like the cheque service does.
async function tx(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession();
  }
}

const lineForMatching = (l) => ({ id: String(l._id), day: l.day, amount: l.amount, description: l.description, reference: l.reference, chequeNo: l.chequeNo });
const lineOut = (l) => ({
  _id: l._id, importId: l.importId, lineNo: l.lineNo, day: l.day, valueDay: l.valueDay, description: l.description, reference: l.reference,
  chequeNo: l.chequeNo, amount: l.amount, balance: l.balance, state: l.state, matchId: l.matchId, reconciliationId: l.reconciliationId,
  ignoredReason: l.ignoredReason,
});
const entryOut = (e) => ({
  id: e.id, type: e.type, ledgerEntryId: e.ledgerEntryId, chequeId: e.chequeId || null, voucherId: e.voucherId, voucherNo: e.voucherNo, voucherType: e.voucherType,
  day: e.day, amount: e.amount, narration: e.narration, party: e.party, reference: e.reference, chequeNo: e.chequeNo, card: e.card || null, pending: Boolean(e.pending),
});

class ReconciliationService {
  // ------------------------------------------------------------------ the list of bank accounts
  static async accounts(req) {
    const { companyId } = getTenant(req);
    const { ids } = await groupFamily("bank-account-group", req);
    const accounts = await LedgerAccount.find({ groupId: { $in: ids }, isActive: true }).select("accountName accountCode bank").sort({ accountCode: 1 }).lean();
    const accIds = accounts.map((a) => a._id);
    const [counts, setups, recs, balances, banks] = await Promise.all([
      R.BankStatementLine.aggregate([
        { $match: { companyId, accountId: { $in: accIds } } },
        { $group: { _id: { a: "$accountId", s: "$state" }, n: { $sum: 1 }, last: { $max: "$day" } } },
      ]),
      R.BankReconSetup.find({ companyId, accountId: { $in: accIds } }).lean(),
      R.BankReconciliation.aggregate([
        { $match: { companyId, accountId: { $in: accIds }, status: "completed" } },
        { $sort: { asOf: -1, createdAt: -1 } },
        { $group: { _id: "$accountId", number: { $first: "$number" }, asOf: { $first: "$asOf" }, statementBalance: { $first: "$statementBalance" } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { accountId: { $in: accIds }, isReversed: { $ne: true } } },
        { $group: { _id: "$accountId", d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
      ]),
      BankMaster.find({ companyId }).select("bankName").lean(),
    ]);
    const banksById = new Map(banks.map((b) => [String(b._id), b]));
    return accounts.map((a) => {
      const id = String(a._id);
      const c = { open: 0, matched: 0, reconciled: 0, ignored: 0 };
      let lastLineDay = null;
      for (const row of counts) {
        if (String(row._id.a) !== id) continue;
        c[row._id.s] = row.n;
        if (!lastLineDay || row.last > lastLineDay) lastLineDay = row.last;
      }
      const bal = balances.find((b) => String(b._id) === id);
      const rec = recs.find((r) => String(r._id) === id);
      return {
        _id: a._id, accountName: a.accountName, accountCode: a.accountCode, bank: BankMasterService.describeAccountBank(a.bank, banksById),
        bookBalance: round2((bal?.d || 0) - (bal?.c || 0)), setUp: setups.some((s) => String(s.accountId) === id), counts: c, lastLineDay,
        lastReconciled: rec ? { number: rec.number, asOf: rec.asOf, statementBalance: rec.statementBalance } : null,
      };
    });
  }

  // ------------------------------------------------------------------------------- the start
  // Where reconciliation of this account starts. The books before the start day are taken as
  // reconciled already, except the entries listed as still outstanding then; the bank's balance the
  // day before is what the statement says it was.
  static async setupPreview(accountId, { startDay }, req) {
    const account = await Core.bankAccount(accountId, { req });
    if (!Core.isDay(startDay)) throw new AppError("Enter the day the statement starts", 400, "INVALID_DATE");
    const before = addDays(startDay, -1);
    const [bookBalanceBefore, existing, docs] = await Promise.all([
      Core.balanceAt(accountId, before),
      Core.getSetup(accountId, { req }),
      LedgerEntry.find({ accountId: toId(accountId), isReversed: { $ne: true }, date: { $lte: Core.dayEnd(before) } })
        .select("voucherId voucherNo voucherType date debitAmount creditAmount narration referenceType referenceNo").sort({ date: -1, _id: -1 }).limit(150).lean(),
    ]);
    return { account: { _id: account._id, accountName: account.accountName }, startDay, bookBalanceBefore, existing, candidates: docs.map((d) => entryOut(Core.entryRow(d, null))) };
  }

  static async setupStatus(accountId, req) {
    const setup = await Core.getSetup(accountId, { req });
    if (!setup) return null;
    const before = addDays(setup.startDay, -1);
    const bookBalanceBefore = await Core.balanceAt(accountId, before);
    const out = await LedgerEntry.find({ _id: { $in: setup.outstandingEntryIds || [] }, isReversed: { $ne: true } }).select("debitAmount creditAmount").lean();
    const outstandingTotal = round2(out.reduce((t, e) => t + (e.debitAmount || 0) - (e.creditAmount || 0), 0));
    return {
      startDay: setup.startDay, statementOpening: setup.statementOpening, outstandingCount: out.length, outstandingTotal, bookBalanceBefore,
      difference: round2(bookBalanceBefore - outstandingTotal - setup.statementOpening),
    };
  }

  static async saveSetup(accountId, { startDay, statementOpening, outstandingEntryIds = [] }, req, by) {
    await Core.bankAccount(accountId, { req });
    const { companyId, branchId } = getTenant(req);
    if (!Core.isDay(startDay)) throw new AppError("Enter the day the statement starts", 400, "INVALID_DATE");
    if (startDay > todayInDubai()) throw new AppError("The start day cannot be in the future", 400, "INVALID_DATE");
    const opening = Number(statementOpening);
    if (!Number.isFinite(opening)) throw new AppError("Enter the bank's balance on the day before the statement starts", 400, "OPENING_REQUIRED");
    const ids = [...new Set((outstandingEntryIds || []).map(String))];
    if (ids.some((i) => !mongoose.isValidObjectId(i))) throw new AppError("Choose valid outstanding entries", 400, "INVALID_ENTRY");
    const found = ids.length
      ? await LedgerEntry.countDocuments({ _id: { $in: ids }, accountId: toId(accountId), isReversed: { $ne: true }, date: { $lt: Core.dayStart(startDay) } })
      : 0;
    if (found !== ids.length) throw new AppError("Outstanding entries must be entries of this account dated before the start day", 400, "INVALID_ENTRY");

    const existing = await Core.getSetup(accountId, { req });
    if (existing) {
      const done = await R.BankReconciliation.exists({ companyId, accountId, status: "completed" });
      if (done) throw new AppError("This account has a completed reconciliation, so where it starts cannot change. Reopen it first.", 409, "SETUP_LOCKED");
      const early = await R.BankStatementLine.exists({ companyId, accountId, day: { $lt: startDay } });
      if (early) throw new AppError("Statement lines are already imported from before that day. Void those imports first.", 409, "SETUP_LOCKED");
    }
    await R.BankReconSetup.findOneAndUpdate(
      { companyId, accountId },
      { $set: { branchId, startDay, statementOpening: round2(opening), outstandingEntryIds: ids.map(toId), createdBy: by ? String(by) : null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return this.setupStatus(accountId, req);
  }

  // -------------------------------------------------------------------------------- the import
  static parsePayload({ rows, mt940, mapping }) {
    if (mt940) {
      const statements = S.parseMt940(String(mt940).slice(0, 4000000));
      if (!statements.length) throw new AppError("No statement was found in this MT940 text", 400, "MT940_EMPTY");
      const parts = statements.map(S.mt940Lines);
      let n = 0;
      const lines = parts.flatMap((p) => p.lines).map((l) => ({ ...l, lineNo: (n += 1) }));
      const issues = parts.flatMap((p) => p.issues);
      const continuity = { ok: parts.every((p) => p.continuity.ok), checked: parts.some((p) => p.continuity.checked), breaks: parts.flatMap((p) => p.continuity.breaks) };
      return {
        format: "mt940", mapping: null, guess: null, hash: crypto.createHash("sha256").update(String(mt940)).digest("hex"),
        result: { lines, issues, skipped: 0, order: "ascending", opening: parts[0].opening, closing: parts[parts.length - 1].closing, continuity },
      };
    }
    if (!Array.isArray(rows) || rows.length < 2) throw new AppError("The file has no rows to read", 400, "EMPTY_FILE");
    if (rows.length > MAX_ROWS) throw new AppError(`A file can have up to ${MAX_ROWS} rows; split it by month`, 400, "FILE_TOO_LARGE");
    const guess = S.guessMapping(rows);
    const used = mapping && mapping.columns ? mapping : guess.mapping;
    return {
      format: "grid", mapping: used, guess: { headerRow: guess.headerRow, headers: guess.headers, complete: guess.complete },
      hash: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"), result: S.normaliseStatement(rows, used),
    };
  }

  // What importing this file would do, without doing it.
  static async preview(accountId, payload, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const parsed = this.parsePayload(payload);
    const { result } = parsed;
    const lines = S.withFingerprints(result.lines);
    const existing = lines.length
      ? await R.BankStatementLine.find({ companyId, accountId, fingerprint: { $in: [...new Set(lines.map((l) => l.fingerprint))] } }).select("fingerprint occurrence").lean()
      : [];
    const known = new Set(existing.map((e) => `${e.fingerprint}:${e.occurrence}`));
    const marked = lines.map((l) => ({ lineNo: l.lineNo, day: l.day, description: l.description, reference: l.reference, chequeNo: l.chequeNo, amount: l.amount, balance: l.balance, duplicate: known.has(`${l.fingerprint}:${l.occurrence}`) }));
    const duplicates = marked.filter((l) => l.duplicate).length;

    const setup = await Core.getSetup(accountId, { req });
    const firstDay = lines.length ? lines[0].day : null;
    const previous = await R.BankStatementLine.findOne({ companyId, accountId, balance: { $ne: null } }).sort({ day: -1, createdAt: -1, lineNo: -1 }).select("day balance").lean();
    let gap = null;
    if (previous && result.opening !== null && result.opening !== undefined && firstDay && firstDay >= previous.day && Math.abs(round2(previous.balance) - result.opening) > 0.005) {
      gap = { expected: previous.balance, found: result.opening, difference: round2(result.opening - previous.balance) };
    }
    const fileDuplicate = Boolean(await R.BankStatementImport.exists({ companyId, accountId, fileHash: parsed.hash, status: "active" }));
    return {
      format: parsed.format, mapping: parsed.mapping, guess: parsed.guess,
      sampleRows: Array.isArray(payload.rows) ? payload.rows.slice(0, 14) : [],
      lines: marked.slice(0, 400), counts: { total: lines.length, new: lines.length - duplicates, duplicates },
      issues: result.issues.slice(0, 50), issueCount: result.issues.length, skipped: result.skipped, order: result.order,
      opening: result.opening, closing: result.closing, continuity: { ...result.continuity, breaks: result.continuity.breaks.slice(0, 10) },
      periodFrom: firstDay, periodTo: lines.length ? lines[lines.length - 1].day : null, gap, fileDuplicate,
      setup: setup ? { exists: true, startDay: setup.startDay, beforeStart: lines.filter((l) => l.day < setup.startDay).length } : { exists: false, suggestedStart: firstDay, suggestedOpening: result.opening },
    };
  }

  static async importStatement(accountId, payload, req, by) {
    await Core.bankAccount(accountId, { req });
    const { companyId, branchId } = getTenant(req);
    const parsed = this.parsePayload(payload);
    const { result } = parsed;
    if (!result.lines.length) throw new AppError("There are no lines to import", 400, "NO_LINES");
    if (result.issues.length && !payload.skipBadRows) {
      throw new AppError(`${result.issues.length} row${result.issues.length === 1 ? "" : "s"} could not be read. Fix the column choices, or import the rest.`, 422, "BAD_ROWS", { issues: result.issues.slice(0, 20) });
    }
    let setup = await Core.getSetup(accountId, { req });
    if (!setup) {
      if (!payload.setup) throw new AppError("Say where this statement starts first", 409, "SETUP_REQUIRED");
      await this.saveSetup(accountId, payload.setup, req, by);
      setup = await Core.getSetup(accountId, { req });
    }
    const lines = S.withFingerprints(result.lines);
    const early = lines.filter((l) => l.day < setup.startDay);
    if (early.length) {
      throw new AppError(`${early.length} line${early.length === 1 ? " is" : "s are"} dated before the start day ${setup.startDay}. Remove them from the file, or move the start day earlier.`, 422, "BEFORE_START", { firstLineNo: early[0].lineNo });
    }
    const existing = await R.BankStatementLine.find({ companyId, accountId, fingerprint: { $in: [...new Set(lines.map((l) => l.fingerprint))] } }).select("fingerprint occurrence").lean();
    const known = new Set(existing.map((e) => `${e.fingerprint}:${e.occurrence}`));
    const fresh = lines.filter((l) => !known.has(`${l.fingerprint}:${l.occurrence}`));
    const duplicates = lines.length - fresh.length;
    if (!fresh.length) throw new AppError("Every line in this file has been imported already", 409, "ALL_DUPLICATES");

    const out = await tx(async (session) => {
      const [imp] = await R.BankStatementImport.create([{
        companyId, branchId, accountId, fileName: String(payload.fileName || "").slice(0, 200), fileHash: parsed.hash, format: parsed.format, mapping: parsed.mapping,
        periodFrom: lines[0].day, periodTo: lines[lines.length - 1].day, openingBalance: result.opening ?? null, closingBalance: result.closing ?? null,
        lineCount: fresh.length, duplicateCount: duplicates, createdBy: by ? String(by) : null,
      }], { session });
      await R.BankStatementLine.insertMany(
        fresh.map((l) => ({ companyId, branchId, accountId, importId: imp._id, lineNo: l.lineNo, day: l.day, valueDay: l.valueDay, description: l.description, reference: l.reference, chequeNo: l.chequeNo || "", amount: l.amount, balance: l.balance, fingerprint: l.fingerprint, occurrence: l.occurrence })),
        { session }
      );
      return imp.toObject();
    });
    if (parsed.mapping) {
      await R.BankStatementProfile.findOneAndUpdate({ companyId, accountId }, { $set: { branchId, mapping: parsed.mapping, updatedBy: by ? String(by) : null } }, { upsert: true, setDefaultsOnInsert: true });
    }
    return { import: out, imported: fresh.length, duplicates, skippedRows: result.issues.length };
  }

  static async imports(accountId, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const rows = await R.BankStatementImport.find({ companyId, accountId }).sort({ createdAt: -1 }).limit(100).lean();
    const used = await R.BankStatementLine.aggregate([
      { $match: { companyId, accountId: toId(accountId), state: { $ne: "open" } } },
      { $group: { _id: "$importId", n: { $sum: 1 } } },
    ]);
    const usedBy = new Map(used.map((u) => [String(u._id), u.n]));
    return rows.map((i) => ({ ...i, workedOn: usedBy.get(String(i._id)) || 0 }));
  }

  // An import that was a mistake can be taken back while none of its lines has been worked on.
  static async voidImport(importId, req, by) {
    const { companyId } = getTenant(req);
    return tx(async (session) => {
      const imp = await R.BankStatementImport.findOne({ _id: importId, companyId, status: "active" }).session(session);
      if (!imp) throw new AppError("Import not found", 404, "IMPORT_NOT_FOUND");
      const worked = await R.BankStatementLine.countDocuments({ importId: imp._id, state: { $ne: "open" } }).session(session);
      if (worked) throw new AppError(`${worked} line${worked === 1 ? " has" : "s have"} been matched or ignored. Unmatch them first.`, 409, "IMPORT_IN_USE");
      const removed = await R.BankStatementLine.deleteMany({ importId: imp._id }, { session });
      imp.status = "voided";
      imp.voidedAt = new Date();
      imp.voidedBy = by ? String(by) : null;
      await imp.save({ session });
      return { removed: removed.deletedCount, import: imp.toObject() };
    });
  }

  static async profile(accountId, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const p = await R.BankStatementProfile.findOne({ companyId, accountId }).lean();
    return p ? p.mapping : null;
  }

  // ------------------------------------------------------------------------------ the worklist
  // Everything the matching code needs about the books: the entries nobody has matched yet, and the
  // cheques waiting to clear.
  static async pool(accountId, setup, req) {
    const [{ entries }, cheques] = await Promise.all([Core.loadBook(accountId, setup, { req }), Core.loadPendingCheques(accountId, { req })]);
    return [...entries.filter((e) => !e.groupId), ...cheques];
  }

  static asMatchEntry(e) {
    return { id: e.id, day: e.day, amount: e.amount, voucherNo: e.voucherNo, chequeNo: e.chequeNo, reference: e.reference, party: e.party, narration: e.narration };
  }

  static async suggestions(accountId, setup, req, { lines } = {}) {
    const { companyId } = getTenant(req);
    const open = lines || await R.BankStatementLine.find({ companyId, accountId, state: "open" }).sort({ day: 1, lineNo: 1 }).limit(OPEN_LIMIT).lean();
    const pool = await this.pool(accountId, setup, req);
    const byId = new Map(pool.map((e) => [e.id, e]));
    const raw = M.suggest(open.map(lineForMatching), pool.map(this.asMatchEntry));
    const out = new Map();
    for (const [lineId, s] of raw) {
      out.set(lineId, { confidence: s.confidence, score: s.score, reasons: s.reasons, kind: s.kind, entries: s.entryIds.map((id) => entryOut(byId.get(String(id)))) });
    }
    return { open, suggestions: out };
  }

  // tab: todo (open, no suggestion) | suggested | matched | ignored | all
  static async lines(accountId, { tab = "todo", search = "", from, to, page = 1, limit = 50 } = {}, req) {
    const account = await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const setup = await Core.getSetup(accountId, { req });
    const empty = { account: { _id: account._id, accountName: account.accountName }, needsSetup: !setup, rows: [], total: 0, page: 1, pages: 1, counts: { todo: 0, suggested: 0, matched: 0, reconciled: 0, ignored: 0, all: 0 } };
    if (!setup) return empty;

    const stateCounts = await R.BankStatementLine.aggregate([{ $match: { companyId, accountId: toId(accountId) } }, { $group: { _id: "$state", n: { $sum: 1 } } }]);
    const count = (s) => stateCounts.find((c) => c._id === s)?.n || 0;
    const { open, suggestions } = await this.suggestions(accountId, setup, req);
    const counts = {
      todo: open.filter((l) => !suggestions.has(String(l._id))).length, suggested: open.filter((l) => suggestions.has(String(l._id))).length,
      matched: count("matched") + count("reconciled"), reconciled: count("reconciled"), ignored: count("ignored"), all: open.length + count("matched") + count("reconciled") + count("ignored"),
    };

    const needle = String(search || "").trim().toLowerCase();
    const textOk = (l) => !needle || `${l.description} ${l.reference} ${l.chequeNo} ${Math.abs(l.amount).toFixed(2)} ${l.day}`.toLowerCase().includes(needle);
    const dateOk = (l) => (!from || l.day >= from) && (!to || l.day <= to);
    const per = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const pageNo = Math.max(Number(page) || 1, 1);

    let rows;
    let total;
    if (tab === "todo" || tab === "suggested") {
      const wanted = open.filter((l) => (tab === "suggested") === suggestions.has(String(l._id))).filter(textOk).filter(dateOk);
      total = wanted.length;
      rows = wanted.slice((pageNo - 1) * per, pageNo * per);
    } else {
      const states = tab === "matched" ? ["matched", "reconciled"] : tab === "ignored" ? ["ignored"] : ["open", "matched", "reconciled", "ignored"];
      const q = { companyId, accountId: toId(accountId), state: { $in: states } };
      if (from || to) q.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      if (needle) q.$or = [{ description: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { reference: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { chequeNo: needle }];
      total = await R.BankStatementLine.countDocuments(q);
      rows = await R.BankStatementLine.find(q).sort({ day: -1, lineNo: -1 }).skip((pageNo - 1) * per).limit(per).lean();
    }

    const matchIds = [...new Set(rows.map((l) => l.matchId).filter(Boolean).map(String))];
    const matches = matchIds.length ? await R.BankMatch.find({ _id: { $in: matchIds } }).lean() : [];
    const matchById = new Map(matches.map((m) => [String(m._id), m]));
    const out = rows.map((l) => {
      const m = l.matchId ? matchById.get(String(l.matchId)) : null;
      return {
        ...lineOut(l),
        suggestion: l.state === "open" ? suggestions.get(String(l._id)) || null : null,
        match: m ? { _id: m._id, kind: m.kind, method: m.method, reconciliationId: m.reconciliationId, lineCount: m.lineIds.length, entries: m.entries.map((e) => ({ voucherNo: e.voucherNo, voucherType: e.voucherType, day: e.day, amount: e.amount, narration: e.narration })), createdVouchers: m.createdVouchers || [] } : null,
      };
    });
    return { ...empty, needsSetup: false, rows: out, total, page: pageNo, pages: Math.max(Math.ceil(total / per), 1), counts, truncated: open.length >= OPEN_LIMIT };
  }

  // Book entries (and cheques waiting to clear) a person can pick for a line: the same direction,
  // closest to the line's date first.
  static async searchEntries(accountId, { lineId, q = "", limit = 60 } = {}, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const setup = await Core.getSetup(accountId, { req });
    if (!setup) throw new AppError("Set up this account first", 409, "SETUP_REQUIRED");
    let line = null;
    if (lineId) line = await R.BankStatementLine.findOne({ _id: lineId, companyId, accountId }).lean();
    const pool = await this.pool(accountId, setup, req);
    const needle = String(q || "").trim().toLowerCase();
    let list = pool.filter((e) => !line || Math.sign(e.amount) === Math.sign(line.amount));
    if (needle) list = list.filter((e) => `${e.voucherNo} ${e.narration} ${e.party} ${e.reference} ${e.chequeNo} ${Math.abs(e.amount).toFixed(2)}`.toLowerCase().includes(needle));
    if (line) list.sort((a, b) => M.businessDays(line.day, a.day) - M.businessDays(line.day, b.day) || String(a.id).localeCompare(String(b.id)));
    else list.sort((a, b) => (a.day < b.day ? 1 : -1));
    return { rows: list.slice(0, Math.min(Number(limit) || 60, 200)).map(entryOut), total: list.length };
  }

  // ------------------------------------------------------------------------------------ matching
  static async match(accountId, { lineIds, entries: refs = [], note = "" }, req, by, { method = "manual" } = {}) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    const ids = [...new Set((lineIds || []).map(String))];
    if (!ids.length || ids.some((i) => !mongoose.isValidObjectId(i))) throw new AppError("Choose the statement lines", 400, "LINES_REQUIRED");
    return tx(async (session) => {
      const lines = await R.BankStatementLine.find({ _id: { $in: ids }, companyId, accountId, state: "open" }).session(session).lean();
      if (lines.length !== ids.length) throw new AppError("A statement line is no longer open. Reload and try again.", 409, "LINE_NOT_OPEN");
      const clearOn = lines.map((l) => l.day).sort().pop();
      const entries = await Core.resolveEntryRefs(refs, { accountId, clearOn, session, req, adminId: by });
      const m = await Core.createMatch({ accountId, lines, entries, method, note, by: by ? String(by) : null, session, req });
      return m.toObject();
    });
  }

  // Accepts the suggestions the engine is sure of (or the ones for the lines given). Each one is its
  // own transaction, so one that no longer fits does not stop the rest.
  static async acceptSuggestions(accountId, { lineIds, confidence = "high" } = {}, req, by) {
    await Core.bankAccount(accountId, { req });
    const setup = await Core.getSetup(accountId, { req });
    if (!setup) throw new AppError("Set up this account first", 409, "SETUP_REQUIRED");
    const { suggestions } = await this.suggestions(accountId, setup, req);
    const wanted = lineIds && lineIds.length ? new Set(lineIds.map(String)) : null;
    const accepted = [];
    const skipped = [];
    for (const [lineId, s] of suggestions) {
      if (wanted && !wanted.has(lineId)) continue;
      if (!wanted && confidence === "high" && s.confidence !== "high") continue;
      try {
        const m = await this.match(accountId, { lineIds: [lineId], entries: s.entries.map((e) => (e.type === "cheque" ? { type: "cheque", chequeId: e.chequeId } : { type: "ledger", ledgerEntryId: e.ledgerEntryId })) }, req, by, { method: "auto" });
        accepted.push({ lineId, matchId: m._id });
      } catch (err) {
        skipped.push({ lineId, reason: err.message, code: err.code });
      }
    }
    return { accepted: accepted.length, skipped, matchIds: accepted.map((a) => a.matchId) };
  }

  static async unmatch(matchId, { deleteVouchers = false } = {}, req, by) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(matchId)) throw new AppError("Match not found", 404, "MATCH_NOT_FOUND");
    const undone = await tx(async (session) => {
      const m = await R.BankMatch.findOne({ _id: matchId, companyId, status: "active" }).session(session);
      if (!m) throw new AppError("Match not found", 404, "MATCH_NOT_FOUND");
      if (m.reconciliationId) throw new AppError("This match is part of a completed reconciliation. Reopen the reconciliation first.", 409, "BANK_RECONCILED");
      m.status = "undone";
      m.undoneBy = by ? String(by) : null;
      m.undoneAt = new Date();
      await m.save({ session });
      await R.BankStatementLine.updateMany({ matchId: m._id }, { $set: { state: "open", matchId: null } }, { session });
      await R.CardSettlement.updateMany({ matchId: m._id }, { $set: { status: "undone", undoneAt: new Date() } }, { session });
      return m.toObject();
    });
    // the entries posted for the match (a fee, interest, a commission) are deleted only when asked
    const warnings = [];
    if (deleteVouchers) {
      for (const v of undone.createdVouchers || []) {
        try { await FinancialService.deleteVoucher(v.voucherId, by); } catch (err) { warnings.push(`${v.voucherNo}: ${err.message}`); }
      }
    }
    return { match: undone, warnings };
  }

  static async ignore(lineId, reason, req, by) {
    const { companyId } = getTenant(req);
    const why = String(reason || "").trim();
    if (why.length < 3) throw new AppError("Say why this line is ignored", 400, "REASON_REQUIRED");
    const line = await R.BankStatementLine.findOneAndUpdate(
      { _id: lineId, companyId, state: "open" },
      { $set: { state: "ignored", ignoredReason: why.slice(0, 250), ignoredBy: by ? String(by) : null, ignoredAt: new Date() } },
      { new: true }
    ).lean();
    if (!line) throw new AppError("That line is no longer open", 409, "LINE_NOT_OPEN");
    return lineOut(line);
  }

  static async unignore(lineId, req) {
    const { companyId } = getTenant(req);
    const line = await R.BankStatementLine.findOneAndUpdate(
      { _id: lineId, companyId, state: "ignored", reconciliationId: null },
      { $set: { state: "open", ignoredReason: "", ignoredBy: null, ignoredAt: null } },
      { new: true }
    ).lean();
    if (!line) throw new AppError("That line cannot be put back: it is not ignored, or it is in a completed reconciliation", 409, "LINE_NOT_IGNORED");
    return lineOut(line);
  }

  // ------------------------------------------------------------------------------------ the proof
  static async proofIn(accountId, { asOf, statementBalance }, req, session) {
    const { companyId } = getTenant(req);
    if (!Core.isDay(asOf)) throw new AppError("Enter the statement date", 400, "INVALID_DATE");
    const sb = Number(statementBalance);
    if (statementBalance === undefined || statementBalance === null || statementBalance === "" || !Number.isFinite(sb)) throw new AppError("Enter the balance on the statement", 400, "BALANCE_REQUIRED");
    const setup = await Core.getSetup(accountId, { req, session });
    if (!setup) throw new AppError("Set up this account first", 409, "SETUP_REQUIRED");

    const [{ entries }, lines, bookBalance, last, cheques] = await Promise.all([
      Core.loadBook(accountId, setup, { req, session, upTo: asOf }),
      Core.inSession(R.BankStatementLine.find({ companyId, accountId: toId(accountId), day: { $lte: asOf } }).select("day amount state matchId description reference lineNo").lean(), session),
      Core.balanceAt(accountId, asOf, { session }),
      Core.inSession(R.BankReconciliation.findOne({ companyId, accountId: toId(accountId), status: "completed" }).sort({ asOf: -1, createdAt: -1 }).select("number asOf statementBalance").lean(), session),
      Core.loadPendingCheques(accountId, { req, session }),
    ]);
    const proof = M.buildProof({
      statementBalance: sb, bookBalance,
      entries: entries.map((e) => ({ ...entryOut(e), groupId: e.groupId })),
      lines: lines.map((l) => ({ id: String(l._id), day: l.day, amount: l.amount, state: l.state === "reconciled" ? "matched" : l.state, groupId: l.matchId ? String(l.matchId) : null, description: l.description, reference: l.reference, lineNo: l.lineNo })),
    });
    const blockers = [];
    if (asOf > todayInDubai()) blockers.push({ code: "FUTURE_DATE", message: "The statement date cannot be in the future" });
    if (last && asOf <= last.asOf) blockers.push({ code: "NOT_AFTER_LAST", message: `${last.number} already covers up to ${last.asOf}. Choose a later date, or reopen it.` });
    const inPeriod = lines.filter((l) => !last || l.day > last.asOf).length;
    if (!inPeriod) blockers.push({ code: "NO_LINES", message: "There are no statement lines in this period" });
    if (proof.openLines) blockers.push({ code: "OPEN_LINES", message: `${proof.openLines} statement line${proof.openLines === 1 ? " is" : "s are"} not matched or ignored yet` });
    if (Math.abs(cents(proof.difference)) > 0) blockers.push({ code: "DIFFERENCE", message: `The two sides differ by ${Math.abs(proof.difference).toFixed(2)}` });
    const uncleared = cheques.filter((c) => c.day <= asOf);
    return {
      ...proof, asOf, account: String(accountId), lastReconciled: last || null, blockers, canFinish: blockers.length === 0,
      unclearedCheques: { items: uncleared, count: uncleared.length, total: round2(uncleared.reduce((t, c) => t + c.amount, 0)) },
    };
  }

  static async proof(accountId, input, req) {
    await Core.bankAccount(accountId, { req });
    const out = await this.proofIn(accountId, input, req, null);
    out.openingDifference = (await this.setupStatus(accountId, req))?.difference ?? 0;
    return out;
  }

  static async finish(accountId, { asOf, statementBalance, note = "" }, req, by) {
    const account = await Core.bankAccount(accountId, { req });
    const { companyId, branchId } = getTenant(req);
    return tx(async (session) => {
      const proof = await this.proofIn(accountId, { asOf, statementBalance }, req, session);
      if (!proof.canFinish) throw new AppError(proof.blockers[0].message, 409, "RECONCILIATION_NOT_READY", { blockers: proof.blockers });
      const number = await NumberSeriesService.allocate("BRC", new Date(`${asOf}T00:00:00.000Z`), { session, req });
      const lines = await R.BankStatementLine.find({ companyId, accountId: toId(accountId), day: { $lte: asOf }, state: { $in: ["matched", "ignored"] } }).session(session).lean();
      const matchIds = [...new Set(lines.filter((l) => l.state === "matched").map((l) => String(l.matchId)))];
      // a match with a line after the date is not finished with yet
      const later = matchIds.length ? await R.BankStatementLine.find({ matchId: { $in: matchIds }, day: { $gt: asOf } }).select("matchId").session(session).lean() : [];
      const stay = new Set(later.map((l) => String(l.matchId)));
      const lockIds = matchIds.filter((i) => !stay.has(i));
      const snapshot = { ...proof, depositsInTransit: cap(proof.depositsInTransit), outstandingPayments: cap(proof.outstandingPayments), bankItemsNotInBooks: cap(proof.bankItemsNotInBooks), ignored: cap(proof.ignored), unclearedCheques: cap(proof.unclearedCheques), blockers: [], canFinish: true };
      const [rec] = await R.BankReconciliation.create([{
        companyId, branchId, accountId, number, asOf, statementBalance: round2(Number(statementBalance)), bookBalance: proof.bookBalance, proof: snapshot,
        lineCount: lines.length, matchIds: lockIds.map(toId), note: String(note || "").slice(0, 250), completedBy: by ? String(by) : null,
      }], { session });
      await R.BankMatch.updateMany({ _id: { $in: lockIds } }, { $set: { reconciliationId: rec._id } }, { session });
      await R.BankStatementLine.updateMany({ matchId: { $in: lockIds }, state: "matched" }, { $set: { state: "reconciled", reconciliationId: rec._id } }, { session });
      await R.BankStatementLine.updateMany({ companyId, accountId: toId(accountId), day: { $lte: asOf }, state: "ignored", reconciliationId: null }, { $set: { reconciliationId: rec._id } }, { session });
      return { ...rec.toObject(), accountName: account.accountName };
    });
  }

  static async reconciliations(accountId, req) {
    await Core.bankAccount(accountId, { req });
    const { companyId } = getTenant(req);
    return R.BankReconciliation.find({ companyId, accountId }).select("-proof").sort({ asOf: -1, createdAt: -1 }).limit(100).lean();
  }

  static async reconciliation(id, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("Reconciliation not found", 404, "NOT_FOUND");
    const rec = await R.BankReconciliation.findOne({ _id: id, companyId }).lean();
    if (!rec) throw new AppError("Reconciliation not found", 404, "NOT_FOUND");
    const account = await LedgerAccount.findById(rec.accountId).select("accountName accountCode bank").lean();
    return { ...rec, account: account ? { _id: account._id, accountName: account.accountName, accountCode: account.accountCode } : null };
  }

  // Only the latest one can be reopened, so the balances each completed one rests on never move.
  static async reopen(id, { reason = "" } = {}, req, by) {
    const { companyId } = getTenant(req);
    return tx(async (session) => {
      const rec = await R.BankReconciliation.findOne({ _id: id, companyId, status: "completed" }).session(session);
      if (!rec) throw new AppError("Reconciliation not found, or it is already reopened", 404, "NOT_FOUND");
      const newer = await R.BankReconciliation.exists({ companyId, accountId: rec.accountId, status: "completed", $or: [{ asOf: { $gt: rec.asOf } }, { asOf: rec.asOf, createdAt: { $gt: rec.createdAt } }] }).session(session);
      if (newer) throw new AppError("Only the latest reconciliation of an account can be reopened. Reopen the newer one first.", 409, "REOPEN_LATEST_ONLY");
      rec.status = "reopened";
      rec.reopenedBy = by ? String(by) : null;
      rec.reopenedAt = new Date();
      rec.reopenReason = String(reason || "").slice(0, 250);
      await rec.save({ session });
      await R.BankMatch.updateMany({ reconciliationId: rec._id }, { $set: { reconciliationId: null } }, { session });
      await R.BankStatementLine.updateMany({ reconciliationId: rec._id, state: "reconciled" }, { $set: { state: "matched", reconciliationId: null } }, { session });
      await R.BankStatementLine.updateMany({ reconciliationId: rec._id }, { $set: { reconciliationId: null } }, { session });
      return rec.toObject();
    });
  }
}

// a long proof is stored with at most this many items per list (the totals stay exact)
function cap(section) {
  return section && Array.isArray(section.items) ? { ...section, items: section.items.slice(0, 300), truncated: section.items.length > 300 } : section;
}

module.exports = ReconciliationService;
