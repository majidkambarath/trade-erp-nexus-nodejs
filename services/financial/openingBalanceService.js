const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const OpeningBalanceVoucher = require("../../models/modules/financial/openingBalanceModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const Transaction = require("../../models/modules/transactionModel");
const Stock = require("../../models/modules/stockModel");
require("../../models/modules/uomModel"); // registers "UOM" for the unit populate
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const CreditLog = require("../../models/modules/CreditLog");
const DebitLog = require("../../models/modules/DebitLog");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const AccountConfigService = require("./accountConfigService");
const ChartOfAccountsService = require("./chartOfAccountsService");
const FinancialService = require("./financialService");
const { writeEntries } = require("./ledgerBalances");
const BatchService = require("../stock/batchService");
const { ensurePartyAccount, KINDS } = require("./partyAccounts");
const costing = require("../../utils/inventoryCosting");
const kinds = require("../../utils/itemKinds");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

// Opening balances: the go-live set-up. A company moving from another system chooses a go-live date
// and enters, as at that date,
//   1. account balances (a trial balance),
//   2. customer and vendor open invoices (so ageing, statements and receipts / payments work),
//   3. stock quantity and unit cost per item (with batch and expiry),
// and everything is posted against Opening Balance Equity (posting key opening-balance-equity), so
// the opening trial balance balances by construction and the user sees the difference that lands
// in equity.
//
// What is stored, and how it is kept out of the way of normal documents:
//   - accounts and stock: one OpeningBalanceVoucher per submission, whose id is the voucherId of its
//     ledger entries (voucherType "opening" / "opening_stock"), so reversing it is one call.
//   - customer / vendor invoices: real Transaction documents (sales_order / purchase_order) with
//     isOpening: true, status APPROVED, no lines. They age, show on the statement, take receipts and
//     payments and count in credit control like any invoice. Everything that must ignore them (VAT,
//     e-invoice, returns, stock, catch-up posting, analysis) checks isOpening.
// All opening ledger entries are dated the go-live day. Posting must be switched on: there is no
// "only stored" mode here, because an opening balance that never reaches the ledger is not one.

const EPS = 0.005;
const MAX_ROWS = 1000;
const PARTY_ACCOUNT = /^(Customer|Vendor|Customer Advance|Advance to Vendor) - /;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdmin = (v) => (mongoose.isValidObjectId(v) ? v : SYSTEM_USER);
// movements that still count: not reversed, and not the reversal row itself
const LIVE_MOVEMENT = { isReversed: { $ne: true }, referenceNumber: { $not: /^REV-/ } };

// "1,200.50" typed into a grid is as good as 1200.5
const money = (v) => round2(Number(typeof v === "string" ? v.replace(/,/g, "") : v) || 0);
const text = (v) => String(v ?? "").trim();
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const sessionOf = (q, session) => (session ? q.session(session) : q);

// "2026-01-01" (or an ISO timestamp) -> that calendar day at 00:00 UTC, which is 04:00 in Dubai: the
// same day in every report. Anything else is refused.
function parseDay(value, label = "Date") {
  const t = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : text(value).slice(0, 10);
  const d = YMD.test(t) ? new Date(`${t}T00:00:00.000Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) {
    throw new AppError(`${label} must be a valid date (YYYY-MM-DD)`, 400, "INVALID_DATE");
  }
  return d;
}

async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// ------------------------------------------------------------------ pure row rules (tested directly)

// lines: [{ accountId, debit, credit }]. A blank spare row is not an error. Returns the clean lines.
function normaliseAccountLines(lines) {
  const raw = Array.isArray(lines) ? lines : [];
  const out = [];
  const seen = new Set();
  raw.forEach((l, i) => {
    const debit = money(l?.debit);
    const credit = money(l?.credit);
    const accountId = text(l?.accountId);
    if (!accountId && !debit && !credit) return;
    const n = i + 1;
    if (!accountId) throw new AppError(`Row ${n}: choose an account`, 400, "ACCOUNT_REQUIRED");
    if (!mongoose.isValidObjectId(accountId)) throw new AppError(`Row ${n}: choose a valid account`, 400, "INVALID_ACCOUNT");
    if (debit < 0 || credit < 0) throw new AppError(`Row ${n}: amounts cannot be negative`, 400, "NEGATIVE_AMOUNT");
    if (debit > 0 && credit > 0) throw new AppError(`Row ${n}: enter a debit or a credit, not both`, 400, "BOTH_SIDES");
    if (!(debit > 0) && !(credit > 0)) throw new AppError(`Row ${n}: enter an amount`, 400, "AMOUNT_REQUIRED");
    if (seen.has(accountId)) throw new AppError(`Row ${n}: this account is already on another row`, 400, "DUPLICATE_ACCOUNT");
    seen.add(accountId);
    out.push({ accountId, debit, credit });
  });
  if (out.length > MAX_ROWS) throw new AppError(`At most ${MAX_ROWS} rows at a time`, 400, "TOO_MANY_ROWS");
  return out;
}

// The balancing line to Opening Balance Equity: it takes whichever side is short.
function equityDifference(lines) {
  const debit = round2(lines.reduce((t, l) => t + l.debit, 0));
  const credit = round2(lines.reduce((t, l) => t + l.credit, 0));
  const diff = round2(debit - credit);
  return { debit, credit, amount: Math.abs(diff) < EPS ? 0 : Math.abs(diff), side: diff > EPS ? "credit" : diff < -EPS ? "debit" : null };
}

// rows: [{ partyId, reference, date, dueDate, amount }]. Returns clean rows; `day` is the go-live day.
function normalisePartyRows(rows, day) {
  const raw = Array.isArray(rows) ? rows : [];
  const out = [];
  raw.forEach((r, i) => {
    const partyId = text(r?.partyId);
    const reference = text(r?.reference);
    const amount = money(r?.amount);
    if (!partyId && !reference && !amount) return;
    const n = i + 1;
    if (!partyId || !mongoose.isValidObjectId(partyId)) throw new AppError(`Row ${n}: choose the customer or vendor`, 400, "PARTY_REQUIRED");
    if (!(amount > 0)) throw new AppError(`Row ${n}: enter an amount greater than zero`, 400, "AMOUNT_REQUIRED");
    if (amount > 1e12) throw new AppError(`Row ${n}: the amount is too large`, 400, "AMOUNT_TOO_LARGE");
    if (reference.length > 60) throw new AppError(`Row ${n}: the invoice reference is longer than 60 characters`, 400, "REFERENCE_TOO_LONG");
    const date = r?.date ? parseDay(r.date, `Row ${n}: invoice date`) : new Date(day);
    if (date > day) throw new AppError(`Row ${n}: an invoice dated after the go-live day (${dayKey(day)}) is not an opening balance`, 400, "DATE_AFTER_GO_LIVE");
    const dueDate = r?.dueDate ? parseDay(r.dueDate, `Row ${n}: due date`) : null;
    if (dueDate && dueDate < date) throw new AppError(`Row ${n}: the due date is before the invoice date`, 400, "INVALID_DUE_DATE");
    out.push({ n, partyId, reference, date, dueDate, amount });
  });
  if (out.length > MAX_ROWS) throw new AppError(`At most ${MAX_ROWS} rows at a time`, 400, "TOO_MANY_ROWS");
  return out;
}

// rows: [{ itemId, qty, unitCost, batchNo, expiryDate, locationId }].
function normaliseStockRows(rows) {
  const raw = Array.isArray(rows) ? rows : [];
  const out = [];
  raw.forEach((r, i) => {
    const item = text(r?.itemId);
    const qtyText = text(r?.qty);
    const costText = text(r?.unitCost);
    const batchNo = text(r?.batchNo);
    if (!item && !qtyText && !costText && !batchNo) return;
    const n = i + 1;
    if (!item) throw new AppError(`Row ${n}: choose the item`, 400, "ITEM_REQUIRED");
    const qty = Number(r?.qty);
    if (!Number.isFinite(qty) || !(qty > 0)) throw new AppError(`Row ${n}: the quantity must be greater than zero`, 400, "INVALID_QTY");
    if (qty > 1e9) throw new AppError(`Row ${n}: the quantity is too large`, 400, "INVALID_QTY");
    const unitCost = costText === "" ? NaN : Number(r?.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) throw new AppError(`Row ${n}: enter the unit cost (0 or more)`, 400, "INVALID_COST");
    if (batchNo.length > 60) throw new AppError(`Row ${n}: the batch number is longer than 60 characters`, 400, "BATCH_TOO_LONG");
    const expiryDate = r?.expiryDate ? parseDay(r.expiryDate, `Row ${n}: expiry date`) : null;
    out.push({ n, item, qty, unitCost, batchNo, expiryDate, location: text(r?.locationId) || "MAIN" });
  });
  if (out.length > MAX_ROWS) throw new AppError(`At most ${MAX_ROWS} rows at a time`, 400, "TOO_MANY_ROWS");
  return out;
}

// ------------------------------------------------------------------------------------ the service

class OpeningBalanceService {
  static parseDay = parseDay;
  static normaliseAccountLines = normaliseAccountLines;
  static equityDifference = equityDifference;
  static normalisePartyRows = normalisePartyRows;
  static normaliseStockRows = normaliseStockRows;

  // ------------------------------------------------------------------ set-up

  static async goLive({ session } = {}) {
    const { companyId } = getTenant();
    const s = await sessionOf(CompanySettings.findOne({ companyId }).select("openingBalanceDate openingBalancesPostedAt").lean(), session);
    return { date: s?.openingBalanceDate || null, postedAt: s?.openingBalancesPostedAt || null };
  }

  static async assertReady(session) {
    if (!(await AccountConfigService.isPostingEnabled({ session }))) {
      throw new AppError("Switch on ledger posting (Accounting setup) before entering opening balances", 422, "POSTING_DISABLED");
    }
  }

  // Opening Balance Equity: the account every opening entry is balanced against.
  static async equity(session) {
    const id = await AccountConfigService.resolveAccount("opening-balance-equity", { session });
    const acc = await sessionOf(LedgerAccount.findById(id).select("accountName accountCode").lean(), session);
    if (!acc) throw new AppError("The Opening Balance Equity account no longer exists", 422, "ACCOUNT_NOT_CONFIGURED");
    return { id, accountName: acc.accountName, accountCode: acc.accountCode };
  }

  // The day an opening entry is dated. Once the go-live date is set it cannot be contradicted; if it
  // is not set yet, the first submission sets it.
  static async resolveDate(requested, session) {
    const { companyId } = getTenant();
    const { date: stored } = await this.goLive({ session });
    if (stored) {
      if (requested && dayKey(parseDay(requested)) !== dayKey(stored)) {
        throw new AppError(`Opening balances are dated the go-live day, ${dayKey(stored)}. Change the go-live date first.`, 409, "GO_LIVE_DATE_MISMATCH");
      }
      return new Date(stored);
    }
    if (!requested) throw new AppError("Set the go-live date first", 400, "GO_LIVE_DATE_REQUIRED");
    const day = parseDay(requested);
    await CompanySettings.updateOne({ companyId }, { $set: { openingBalanceDate: day } }, { session });
    return day;
  }

  // Stamps the settings document. Every posting and reversal does this FIRST: two submissions at once
  // (a double click) then write the same document, one of them conflicts and is retried against the
  // other's entries, so it is refused as a duplicate instead of entering everything twice.
  static async markPosted(session) {
    const { companyId } = getTenant();
    await CompanySettings.updateOne({ companyId }, { $set: { openingBalancesPostedAt: new Date() } }, { session });
  }

  // True once any opening entry made here is live: from then on the go-live date is fixed.
  static async hasLiveEntries({ session } = {}) {
    const [voucher, doc] = await Promise.all([
      sessionOf(OpeningBalanceVoucher.exists({ status: "posted" }), session),
      sessionOf(Transaction.exists({ isOpening: true }), session),
    ]);
    return Boolean(voucher || doc);
  }

  static async setGoLiveDate(requested) {
    const day = parseDay(requested, "The go-live date");
    const { companyId } = getTenant();
    await AccountConfigService.ensureSettings(companyId);
    const current = await this.goLive();
    if (current.date && dayKey(current.date) !== dayKey(day) && (await this.hasLiveEntries())) {
      throw new AppError(
        `Opening entries already exist, dated ${dayKey(current.date)}. Reverse them before moving the go-live date.`,
        409,
        "GO_LIVE_DATE_LOCKED"
      );
    }
    await FiscalYearService.assertPostingAllowed(day); // a closed or missing period is found now, not at posting
    await CompanySettings.updateOne({ companyId }, { $set: { openingBalanceDate: day } });
    return { date: day, warnings: await this.warnings(day) };
  }

  // Things worth knowing about the chosen date. Never blocks.
  static async warnings(day) {
    const out = [];
    if (!day) return out;
    const [docs, vouchers, posting] = await Promise.all([
      Transaction.countDocuments({ isOpening: { $ne: true }, status: "APPROVED", date: { $lt: day } }),
      Voucher.countDocuments({ status: "approved", date: { $lt: day } }),
      AccountConfigService.isPostingEnabled(),
    ]);
    if (docs || vouchers) {
      out.push({
        code: "TRANSACTIONS_BEFORE_GO_LIVE",
        message: `${docs} approved document${docs === 1 ? "" : "s"} and ${vouchers} voucher${vouchers === 1 ? "" : "s"} are dated before the go-live date. Opening balances replace the history before that day, so check nothing is entered twice.`,
        documents: docs, vouchers,
      });
    }
    if (!posting) {
      out.push({ code: "POSTING_DISABLED", message: "Ledger posting is switched off. Switch it on in Accounting setup before posting opening balances." });
    }
    try {
      await FiscalYearService.assertPostingAllowed(day);
    } catch (err) {
      if (!err.isOperational) throw err;
      out.push({ code: err.code || "PERIOD_LOCKED", message: err.message });
    }
    for (const key of ["opening-balance-equity", "inventory-asset"]) {
      try {
        await AccountConfigService.resolveAccount(key);
      } catch (err) {
        if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
        out.push({ code: "ACCOUNT_NOT_CONFIGURED", key, message: err.message });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 1. account balances

  // The opening entries now standing on each account (not reversed): the accounts that are already
  // entered. Includes balances set when an account was created. Opening Balance Equity itself is left out.
  static async enteredAccounts({ session } = {}) {
    let equityId = null;
    try { equityId = String(await AccountConfigService.resolveAccount("opening-balance-equity", { session })); } catch (err) { if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err; }
    const rows = await sessionOf(
      LedgerEntry.aggregate([
        { $match: { voucherType: "opening", referenceType: "opening", isReversed: { $ne: true } } },
        { $group: { _id: "$accountId", debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" }, voucherId: { $first: "$voucherId" }, voucherNo: { $first: "$voucherNo" }, date: { $first: "$date" } } },
      ]),
      session
    );
    const wanted = rows.filter((r) => String(r._id) !== equityId);
    const [accounts, vouchers] = await Promise.all([
      sessionOf(LedgerAccount.find({ _id: { $in: wanted.map((r) => r._id) } }).select("accountCode accountName accountType").lean(), session),
      sessionOf(OpeningBalanceVoucher.find({ _id: { $in: wanted.map((r) => r.voucherId) } }).select("_id").lean(), session),
    ]);
    const byId = new Map(accounts.map((a) => [String(a._id), a]));
    const ours = new Set(vouchers.map((v) => String(v._id)));
    return wanted
      .map((r) => {
        const a = byId.get(String(r._id));
        return {
          accountId: r._id, accountCode: a?.accountCode || "", accountName: a?.accountName || "(deleted account)",
          category: (a?.accountType || "asset").toUpperCase(), party: PARTY_ACCOUNT.test(a?.accountName || ""),
          debit: round2(r.debit), credit: round2(r.credit), date: r.date, voucherNo: r.voucherNo,
          voucherId: ours.has(String(r.voucherId)) ? r.voucherId : null,
          source: ours.has(String(r.voucherId)) ? "opening-balances" : "account-created",
        };
      })
      .sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
  }

  static async listAccounts(req) {
    const [goLive, entered, postable, vouchers] = await Promise.all([
      this.goLive(),
      this.enteredAccounts(),
      ChartOfAccountsService.listPostable(req),
      OpeningBalanceVoucher.find({ section: "accounts" }).sort({ createdAt: -1 }).lean(),
    ]);
    let equity = null;
    let inventoryId = null;
    try { equity = await this.equity(); } catch (err) { if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err; }
    try { inventoryId = String(await AccountConfigService.resolveAccount("inventory-asset")); } catch (err) { if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err; }
    const taken = new Set(entered.map((e) => String(e.accountId)));
    const available = postable.filter(
      (a) => !PARTY_ACCOUNT.test(a.accountName) && String(a._id) !== inventoryId && String(a._id) !== String(equity?.id) && !taken.has(String(a._id))
    );
    return {
      goLive: goLive.date, equity, entered, available,
      vouchers: vouchers.map((v) => ({
        _id: v._id, voucherNo: v.voucherNo, date: v.date, status: v.status, narration: v.narration || "",
        totalDebit: v.totalDebit, totalCredit: v.totalCredit,
        difference: { amount: v.differenceAmount, side: v.differenceSide },
        lines: v.lines, createdAt: v.createdAt, reversedAt: v.reversedAt,
      })),
    };
  }

  // lines: [{ accountId, debit, credit }]. One balanced voucher; the difference goes to Opening
  // Balance Equity. Accounts that already have an opening entry, party accounts, the Inventory
  // account and Opening Balance Equity itself are refused (they come from elsewhere).
  static async postAccounts({ date, lines, narration } = {}, { adminId } = {}) {
    const clean = normaliseAccountLines(lines);
    if (!clean.length) throw new AppError("Enter at least one account balance", 400, "NO_LINES");

    return inTransaction(async (session) => {
      await this.assertReady(session);
      await this.markPosted(session);
      const day = await this.resolveDate(date, session);
      await FiscalYearService.assertPostingAllowed(day, { session });
      const equity = await this.equity(session);

      const accounts = await LedgerAccount.find({ _id: { $in: clean.map((l) => l.accountId) } }).session(session).lean();
      const byId = new Map(accounts.map((a) => [String(a._id), a]));
      let inventoryId = null;
      try { inventoryId = String(await AccountConfigService.resolveAccount("inventory-asset", { session })); } catch (err) { if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err; }

      for (const l of clean) {
        const a = byId.get(l.accountId);
        if (!a) throw new AppError("An account in the list no longer exists", 404, "ACCOUNT_NOT_FOUND");
        if (a.isActive === false) throw new AppError(`${a.accountName} is inactive`, 400, "ACCOUNT_INACTIVE");
        if (a.allowDirectPosting === false) throw new AppError(`Direct posting is not allowed to ${a.accountName}`, 400, "DIRECT_POSTING_NOT_ALLOWED");
        if (String(a._id) === String(equity.id)) throw new AppError(`${a.accountName} takes the difference automatically; leave it out`, 400, "EQUITY_ACCOUNT_RESERVED");
        if (PARTY_ACCOUNT.test(a.accountName)) {
          throw new AppError(`${a.accountName} is a customer or vendor account. Enter what they owe as opening invoices on the Customers and Vendors steps.`, 400, "PARTY_ACCOUNT_RESERVED");
        }
        if (String(a._id) === inventoryId) {
          throw new AppError(`${a.accountName} takes its balance from the opening stock. Enter the stock on the Stock step.`, 400, "INVENTORY_ACCOUNT_RESERVED");
        }
      }
      const already = await sessionOf(
        LedgerEntry.distinct("accountId", { accountId: { $in: clean.map((l) => l.accountId) }, voucherType: "opening", referenceType: "opening", isReversed: { $ne: true } }),
        session
      );
      if (already.length) {
        const names = already.map((id) => byId.get(String(id))?.accountName).filter(Boolean);
        throw new AppError(
          `${names.join(", ")} already ${names.length === 1 ? "has" : "have"} an opening balance. Reverse the opening voucher that holds it, then post again.`,
          409,
          "ALREADY_HAS_OPENING"
        );
      }

      const diff = equityDifference(clean);
      const voucherNo = await NumberSeriesService.allocate("OBV", day, { session });
      const [voucher] = await OpeningBalanceVoucher.create(
        [{
          ...getTenant(), section: "accounts", voucherNo, date: day, narration: text(narration) || "Opening balances",
          lines: clean.map((l) => ({
            accountId: l.accountId, accountCode: byId.get(l.accountId).accountCode, accountName: byId.get(l.accountId).accountName,
            debit: l.debit, credit: l.credit,
          })),
          totalDebit: diff.debit, totalCredit: diff.credit, differenceAmount: diff.amount, differenceSide: diff.side,
          status: "posted", createdBy: String(adminId || "system"),
        }],
        { session }
      );

      const base = {
        voucherId: voucher._id, voucherNo, voucherType: "opening", date: day, referenceType: "opening",
        referenceId: voucher._id, referenceNo: voucherNo, createdBy: asAdmin(adminId),
      };
      const entries = clean.map((l) => {
        const a = byId.get(l.accountId);
        return { ...base, accountId: a._id, accountName: a.accountName, accountCode: a.accountCode, debitAmount: l.debit, creditAmount: l.credit, narration: `Opening balance - ${a.accountName}` };
      });
      if (diff.amount > 0) {
        entries.push({
          ...base, accountId: equity.id, accountName: equity.accountName, accountCode: equity.accountCode,
          debitAmount: diff.side === "debit" ? diff.amount : 0, creditAmount: diff.side === "credit" ? diff.amount : 0,
          narration: "Opening balances - balancing figure to Opening Balance Equity",
        });
      }
      await writeEntries(entries, session);
      return {
        _id: voucher._id, voucherNo, date: day, lines: clean.length, totalDebit: diff.debit, totalCredit: diff.credit,
        difference: { amount: diff.amount, side: diff.side, account: equity.accountName },
      };
    });
  }

  // Undo a whole accounts voucher (its entries and the balancing line). Only while its period is open.
  static async reverseAccounts(id, { adminId } = {}) {
    return this.reverseVoucher(id, "accounts", { adminId });
  }

  static async reverseVoucher(id, section, { adminId } = {}) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid opening voucher", 400, "INVALID_ID");
    return inTransaction(async (session) => {
      await this.markPosted(session);
      const voucher = await OpeningBalanceVoucher.findOne({ _id: id, section }).session(session);
      if (!voucher) throw new AppError("Opening voucher not found", 404, "NOT_FOUND");
      if (voucher.status !== "posted") throw new AppError(`${voucher.voucherNo} has already been reversed`, 409, "ALREADY_REVERSED");
      await FiscalYearService.assertPostingAllowed(voucher.date, { session });

      if (section === "stock") await this.reverseStockMovements(voucher, { adminId, session });
      await FinancialService.reverseLedgerEntries(voucher._id, session);

      voucher.status = "reversed";
      voucher.reversedAt = new Date();
      voucher.reversedBy = String(adminId || "system");
      await voucher.save({ session });
      return { _id: voucher._id, voucherNo: voucher.voucherNo, status: voucher.status };
    });
  }

  // ------------------------------------------------------------------ 2. customer / vendor invoices

  static partyKind(type) {
    const kind = text(type).toLowerCase();
    if (!["customer", "vendor"].includes(kind)) throw new AppError("type must be customer or vendor", 400, "INVALID_TYPE");
    return kind;
  }

  // The opening invoices standing for customers or vendors, with the totals.
  static async openingInvoices(type) {
    const kind = this.partyKind(type);
    const isCustomer = kind === "customer";
    const Party = isCustomer ? Customer : Vendor;
    const nameField = isCustomer ? "customerName" : "vendorName";
    const docs = await Transaction.find({ isOpening: true, type: isCustomer ? "sales_order" : "purchase_order" }).sort({ date: 1, transactionNo: 1 }).lean();
    const parties = await Party.find({ _id: { $in: [...new Set(docs.map((d) => String(d.partyId)))] } }).select(nameField).lean();
    const names = new Map(parties.map((p) => [String(p._id), p[nameField]]));
    const rows = docs.map((d) => ({
      _id: d._id, transactionNo: d.transactionNo, partyId: d.partyId, partyName: names.get(String(d.partyId)) || "(deleted)",
      reference: d.docno || "", lump: !d.docno, date: d.date, dueDate: d.dueDate || null,
      amount: round2(d.totalAmount), paid: round2(d.paidAmount), outstanding: round2(d.outstandingAmount),
      canReverse: round2(d.paidAmount) === 0 && round2(d.outstandingAmount) === round2(d.totalAmount),
    }));
    const sum = (k) => round2(rows.reduce((t, r) => t + r[k], 0));
    return {
      type: kind, rows,
      totals: { count: rows.length, parties: new Set(rows.map((r) => String(r.partyId))).size, amount: sum("amount"), paid: sum("paid"), outstanding: sum("outstanding") },
    };
  }

  static async listParties(type) {
    const kind = this.partyKind(type);
    const isCustomer = kind === "customer";
    const Party = isCustomer ? Customer : Vendor;
    const nameField = isCustomer ? "customerName" : "vendorName";
    const codeField = isCustomer ? "customerId" : "vendorId";
    const [goLive, invoices, parties] = await Promise.all([
      this.goLive(),
      this.openingInvoices(kind),
      Party.find({}).select(`${nameField} ${codeField} paymentTerms`).sort({ [nameField]: 1 }).lean(),
    ]);
    return {
      ...invoices, goLive: goLive.date,
      available: parties.map((p) => ({ _id: p._id, code: p[codeField], name: p[nameField], paymentTerms: p.paymentTerms || "" })),
    };
  }

  // rows: [{ partyId, reference?, date?, dueDate?, amount }]. A row with no reference is the party's
  // lump-sum opening balance (one document "Opening balance"). Customers: Dr party / Cr Opening
  // Balance Equity; vendors: Dr Opening Balance Equity / Cr party. No stock, VAT, cost of sales,
  // e-invoice or VAT report row is created.
  static async postParties({ type, date, rows } = {}, { adminId } = {}) {
    const kind = this.partyKind(type);
    const isCustomer = kind === "customer";
    if (!Array.isArray(rows)) throw new AppError("rows must be a list", 400, "ROWS_REQUIRED");

    return inTransaction(async (session) => {
      await this.assertReady(session);
      await this.markPosted(session);
      const day = await this.resolveDate(date, session);
      const clean = normalisePartyRows(rows, day);
      if (!clean.length) throw new AppError("Enter at least one invoice", 400, "NO_ROWS");
      await FiscalYearService.assertPostingAllowed(day, { session });
      const equity = await this.equity(session);

      const Party = isCustomer ? Customer : Vendor;
      const nameField = isCustomer ? "customerName" : "vendorName";
      const ids = [...new Set(clean.map((r) => r.partyId))];
      const parties = await Party.find({ _id: { $in: ids } }).select(`${nameField} cashBalance`).session(session).lean();
      const party = new Map(parties.map((p) => [String(p._id), p]));
      for (const r of clean) if (!party.has(r.partyId)) throw new AppError(`Row ${r.n}: that ${kind} no longer exists`, 404, "PARTY_NOT_FOUND");

      // The same invoice twice, in this submission or from an earlier one, is refused; so is a second lump sum.
      const docType = isCustomer ? "sales_order" : "purchase_order";
      const existing = await Transaction.find({ isOpening: true, type: docType, partyId: { $in: ids } }).select("partyId docno").session(session).lean();
      const taken = new Set(existing.map((d) => `${d.partyId}|${d.docno || ""}`));
      for (const r of clean) {
        const key = `${r.partyId}|${r.reference}`;
        if (taken.has(key)) {
          const who = party.get(r.partyId)[nameField];
          throw new AppError(
            r.reference
              ? `Row ${r.n}: ${who} already has an opening invoice ${r.reference}`
              : `Row ${r.n}: ${who} already has an opening balance without an invoice number. Reverse it to enter another.`,
            409,
            r.reference ? "DUPLICATE_REFERENCE" : "DUPLICATE_LUMP_SUM"
          );
        }
        taken.add(key);
      }

      const numbers = await NumberSeriesService.allocateMany(isCustomer ? "OSI" : "OPI", clean.length, day, { session });
      // the party accounts: found in one query, the few that are missing are made
      const k = KINDS[kind];
      const found = await LedgerAccount.find({ accountName: { $in: ids.map((id) => `${k.prefix}${party.get(id)[nameField]}`) }, accountType: k.type }).session(session).lean();
      const foundByName = new Map(found.map((a) => [a.accountName, a]));
      const accountOf = new Map();
      for (const id of ids) {
        const name = party.get(id)[nameField];
        accountOf.set(id, foundByName.get(`${k.prefix}${name}`) || (await ensurePartyAccount(kind, id, name, { session })));
      }
      // A balance already set on the party's own account (when the account was created) is this same
      // money: entering the invoices as well would count it twice.
      const heldOnAccount = await LedgerEntry.distinct("accountId", {
        accountId: { $in: [...accountOf.values()].map((a) => a._id) }, voucherType: "opening", referenceType: "opening", isReversed: { $ne: true },
      }).session(session);
      if (heldOnAccount.length) {
        const names = [...accountOf.entries()].filter(([, a]) => heldOnAccount.some((h) => String(h) === String(a._id))).map(([id]) => party.get(id)[nameField]);
        throw new AppError(
          `${names.join(", ")} already ${names.length === 1 ? "has" : "have"} an opening balance on the account itself. Open invoices would count it twice.`,
          409,
          "PARTY_HAS_ACCOUNT_OPENING"
        );
      }

      const createdBy = String(adminId || "system");
      const running = new Map(parties.map((p) => [String(p._id), Number(p.cashBalance) || 0]));
      const docs = [];
      const entries = [];
      const logs = [];
      clean.forEach((r, i) => {
        const _id = new mongoose.Types.ObjectId();
        const transactionNo = numbers[i];
        const name = party.get(r.partyId)[nameField];
        const what = r.reference ? `invoice ${r.reference}` : "balance";
        docs.push({
          _id, transactionNo, type: docType, partyId: r.partyId, partyType: isCustomer ? "Customer" : "Vendor", partyTypeRef: isCustomer ? "Customer" : "Vendor",
          docno: r.reference || null, vendorReference: r.reference || null, date: r.date, dueDate: r.dueDate, status: "APPROVED", isOpening: true,
          totalAmount: r.amount, paidAmount: 0, outstandingAmount: r.amount, items: [], charges: [],
          notes: r.reference ? `Opening invoice ${r.reference}` : "Opening balance", createdBy, priority: "Medium",
        });
        const acc = accountOf.get(r.partyId);
        const base = {
          voucherId: _id, voucherNo: transactionNo, voucherType: "opening", date: day, referenceType: "opening_invoice", referenceId: _id,
          referenceNo: transactionNo, partyId: r.partyId, partyType: isCustomer ? "Customer" : "Vendor", createdBy: asAdmin(adminId),
          narration: `Opening ${what} - ${name}`,
        };
        const partyLeg = { accountId: acc._id, accountName: acc.accountName, accountCode: acc.accountCode };
        const equityLeg = { accountId: equity.id, accountName: equity.accountName, accountCode: equity.accountCode };
        entries.push(
          { ...base, ...partyLeg, debitAmount: isCustomer ? r.amount : 0, creditAmount: isCustomer ? 0 : r.amount },
          { ...base, ...equityLeg, debitAmount: isCustomer ? 0 : r.amount, creditAmount: isCustomer ? r.amount : 0 }
        );
        // the party's running balance and statement log, exactly as an approved invoice leaves them
        // (TransactionService.updatePartyBalanceAndLog: a customer's balance goes below zero as they owe us)
        const effect = isCustomer ? -r.amount : r.amount;
        const balance = round2((running.get(r.partyId) || 0) + effect);
        running.set(r.partyId, balance);
        logs.push({
          [isCustomer ? "customerId" : "vendorId"]: r.partyId, type: docType, date: r.date, invNo: transactionNo,
          amount: effect, paid: 0, balance, ref: String(_id), status: "UNPAID", createdBy,
        });
      });

      await Transaction.insertMany(docs, { session });
      await writeEntries(entries, session);
      await (isCustomer ? CreditLog : DebitLog).insertMany(logs, { session });
      await Party.bulkWrite(
        ids.map((id) => ({ updateOne: { filter: { _id: id }, update: { $set: { cashBalance: running.get(id) } } } })),
        { session }
      );

      const total = round2(clean.reduce((t, r) => t + r.amount, 0));
      return {
        type: kind, count: docs.length, total,
        equityOffset: { account: equity.accountName, side: isCustomer ? "credit" : "debit", amount: total },
        created: docs.map((d, i) => ({
          _id: d._id, transactionNo: d.transactionNo, partyId: d.partyId, partyName: party.get(String(d.partyId))[nameField],
          reference: d.docno || "", date: d.date, dueDate: d.dueDate, amount: d.totalAmount, row: clean[i].n,
        })),
      };
    });
  }

  // Remove one opening invoice: only while nothing has been received or paid against it.
  static async reverseParty(id, { adminId } = {}) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid document", 400, "INVALID_ID");
    const TransactionService = require("../orderPurchase/transactionService");
    const PostingService = require("./postingService");
    return inTransaction(async (session) => {
      await this.markPosted(session);
      const tx = await Transaction.findById(id).session(session);
      if (!tx || !tx.isOpening) throw new AppError("Opening invoice not found", 404, "NOT_FOUND");
      if (round2(tx.paidAmount) > 0 || round2(tx.outstandingAmount) !== round2(tx.totalAmount)) {
        throw new AppError(
          `${tx.transactionNo} has receipts, payments or notes set against it. Reverse those first.`,
          409,
          "OPENING_INVOICE_SETTLED"
        );
      }
      const { date: goLive } = await this.goLive({ session });
      await FiscalYearService.assertPostingAllowed(goLive || tx.date, { session });
      await PostingService.reverseTransaction(tx, { session });
      await TransactionService.reversePartyBalanceAndLog(tx, String(adminId || "system"), session);
      await Transaction.deleteOne({ _id: tx._id }, { session });
      return { _id: tx._id, transactionNo: tx.transactionNo, removed: true };
    });
  }

  // ------------------------------------------------------------------ 3. stock

  static isBatchTracked(stock) {
    // There is no per-item "track batches" setting yet: an item whose master record carries a batch
    // number or an expiry date is the one treated as batch-tracked.
    return Boolean(stock.batchNumber || stock.expiryDate);
  }

  // Items that already have live movements, with the reason they cannot take an opening entry.
  static async itemsWithHistory(codes, { excludeVoucherId, session } = {}) {
    if (!codes.length) return new Set();
    const match = { stockId: { $in: codes }, ...LIVE_MOVEMENT };
    if (excludeVoucherId) match.referenceId = { $ne: excludeVoucherId };
    return new Set(await sessionOf(InventoryMovement.distinct("stockId", match), session));
  }

  static async listStock() {
    const [goLive, vouchers, stocks, history] = await Promise.all([
      this.goLive(),
      OpeningBalanceVoucher.find({ section: "stock" }).sort({ createdAt: -1 }).lean(),
      Stock.find({ ...kinds.STOCKED_ONLY }) // a service has no opening stock
        .select("itemId sku itemName currentStock unitOfMeasure batchNumber expiryDate status").populate("unitOfMeasure", "shortCode").sort({ itemName: 1 }).lean(),
      InventoryMovement.aggregate([
        { $match: LIVE_MOVEMENT },
        { $group: { _id: "$stockId", movements: { $sum: 1 }, ours: { $sum: { $cond: [{ $eq: ["$eventType", "OPENING_STOCK"] }, 1, 0] } } } },
      ]),
    ]);
    const moves = new Map(history.map((h) => [h._id, h]));
    const posted = vouchers.filter((v) => v.status === "posted");
    const enteredCodes = new Set(posted.flatMap((v) => v.rows.map((r) => r.itemCode)));

    // a voucher can be reversed while its items have no movement of any other kind
    const postedIds = posted.map((v) => v._id);
    const blocking = await InventoryMovement.aggregate([
      { $match: { stockId: { $in: [...enteredCodes] }, ...LIVE_MOVEMENT, referenceId: { $nin: postedIds } } },
      { $group: { _id: "$stockId" } },
    ]);
    const blocked = new Set(blocking.map((b) => b._id));

    return {
      goLive: goLive.date,
      vouchers: vouchers.map((v) => {
        const stuck = v.status === "posted" ? v.rows.filter((r) => blocked.has(r.itemCode)).map((r) => r.itemName) : [];
        return {
          _id: v._id, voucherNo: v.voucherNo, date: v.date, status: v.status, totalValue: v.totalValue, rows: v.rows,
          createdAt: v.createdAt, reversedAt: v.reversedAt,
          canReverse: v.status === "posted" && !stuck.length,
          blockedBy: [...new Set(stuck)],
        };
      }),
      items: stocks.map((s) => {
        const m = moves.get(s.itemId);
        const entered = enteredCodes.has(s.itemId);
        const canEnter = !(m?.movements > 0) && !(Number(s.currentStock) !== 0);
        return {
          _id: s._id, itemId: s.itemId, sku: s.sku, itemName: s.itemName, unit: s.unitOfMeasure?.shortCode || "",
          currentStock: s.currentStock, status: s.status, batchTracked: this.isBatchTracked(s),
          entered, canEnter,
          reason: entered ? "Opening stock already entered" : canEnter ? "" : m?.movements > 0 ? "Has stock movements: use a stock adjustment" : "Has stock on hand: use a stock adjustment",
        };
      }),
    };
  }

  // rows: [{ itemId, qty, unitCost, batchNo?, expiryDate?, locationId? }]. The same costing, movement
  // and batch path as a purchase receipt, dated the go-live day, plus ONE ledger voucher:
  // Dr Inventory / Cr Opening Balance Equity for the total value.
  static async postStock({ date, rows } = {}, { adminId } = {}) {
    const clean = normaliseStockRows(rows);
    if (!clean.length) throw new AppError("Enter at least one item", 400, "NO_ROWS");

    return inTransaction(async (session) => {
      await this.assertReady(session);
      await this.markPosted(session);
      const day = await this.resolveDate(date, session);
      await FiscalYearService.assertPostingAllowed(day, { session });
      const equity = await this.equity(session);
      const inventoryId = await AccountConfigService.resolveAccount("inventory-asset", { session });
      const inventory = await LedgerAccount.findById(inventoryId).select("accountName accountCode").session(session).lean();

      // items: by id, else by item code
      const refs = [...new Set(clean.map((r) => r.item))];
      const found = await Stock.find({ $or: [{ _id: { $in: refs.filter((r) => mongoose.isValidObjectId(r)) } }, { itemId: { $in: refs } }] }).session(session);
      const lookup = new Map();
      for (const s of found) { lookup.set(String(s._id), s); lookup.set(s.itemId, s); }
      for (const r of clean) {
        r.stock = lookup.get(r.item);
        if (!r.stock) throw new AppError(`Row ${r.n}: that item no longer exists`, 404, "ITEM_NOT_FOUND");
        if (kinds.isService(r.stock)) throw new AppError(`Row ${r.n}: ${r.stock.itemName} is a service item and has no stock to open with`, 409, "SERVICE_HAS_NO_STOCK");
      }

      // Opening stock only for an item with no history: otherwise the quantity and cost already mean something.
      const items = [...new Map(clean.map((r) => [String(r.stock._id), r.stock])).values()];
      const withHistory = await this.itemsWithHistory(items.map((s) => s.itemId), { session });
      const refused = items.filter((s) => withHistory.has(s.itemId) || Number(s.currentStock) !== 0);
      if (refused.length) {
        throw new AppError(
          `${refused.map((s) => s.itemName).join(", ")} ${refused.length === 1 ? "has" : "have"} stock movements or stock on hand already. Opening stock can only be entered for an item with no movements; use a stock adjustment instead.`,
          409,
          "ITEM_HAS_MOVEMENTS",
          { items: refused.map((s) => ({ itemId: s.itemId, itemName: s.itemName })) }
        );
      }

      const warnings = [];
      for (const r of clean) {
        if (this.isBatchTracked(r.stock) && (!r.batchNo || !r.expiryDate)) {
          throw new AppError(`Row ${r.n}: ${r.stock.itemName} is batch-tracked; enter its batch number and expiry date`, 400, "BATCH_REQUIRED");
        }
        if (r.expiryDate && r.expiryDate <= day) {
          warnings.push({ row: r.n, code: "EXPIRED_AT_GO_LIVE", message: `Row ${r.n}: batch ${r.batchNo || "(unnumbered)"} of ${r.stock.itemName} expires ${dayKey(r.expiryDate)}, on or before the go-live day.` });
        }
      }

      const voucherNo = await NumberSeriesService.allocate("OST", day, { session });
      const voucherId = new mongoose.Types.ObjectId();
      const createdBy = String(adminId || "system");
      const pools = new Map(); // item id -> cost pool, carried across the rows of one item
      const movements = [];
      const batchLines = [];
      const voucherRows = [];
      let total = 0;

      clean.forEach((r, i) => {
        const key = String(r.stock._id);
        const pool = pools.get(key) || {
          quantity: Number(r.stock.currentStock) || 0,
          costValue: costing.roundValue((Number(r.stock.currentStock) || 0) * (r.stock.purchasePrice || 0)),
          avgRate: costing.roundRate(r.stock.purchasePrice || 0),
        };
        const res = costing.applyPurchase(pool, { qty: r.qty, cost: r.qty * r.unitCost });
        pools.set(key, res.pool);
        total = round2(total + res.cost);

        movements.push({
          stockId: r.stock.itemId, quantity: r.qty, previousStock: pool.quantity, newStock: res.pool.quantity,
          eventType: "OPENING_STOCK", referenceType: "Adjustment", referenceId: voucherId, referenceNumber: voucherNo,
          date: day, unitCost: res.rate, totalValue: res.cost, costBasis: "opening",
          rateBefore: pool.avgRate, rateAfter: res.pool.avgRate, costPoolAfter: res.pool.costValue, poolQtyAfter: res.pool.quantity,
          notes: `Opening stock - ${r.stock.itemName}`, createdBy, location: r.location,
          batchNumber: r.batchNo || `${voucherNo}-${i + 1}`, expiryDate: r.expiryDate || undefined, ...getTenant(),
        });
        batchLines.push({
          item: { itemId: r.stock._id, itemCode: r.stock.itemId, batchNumber: r.batchNo, expiryDate: r.expiryDate },
          qty: r.qty, unitCost: res.rate, index: i,
        });
        voucherRows.push({
          stockId: r.stock._id, itemCode: r.stock.itemId, sku: r.stock.sku, itemName: r.stock.itemName, qty: r.qty,
          unitCost: r.unitCost, value: res.cost, batchNumber: r.batchNo || `${voucherNo}-${i + 1}`, expiryDate: r.expiryDate, location: r.location,
        });
      });

      await InventoryMovement.insertMany(movements, { session, ordered: true });
      await BatchService.receiveMany({ _id: voucherId, transactionNo: voucherNo, date: day }, batchLines, { session });
      await Stock.bulkWrite(
        items.map((s) => {
          const p = pools.get(String(s._id));
          return { updateOne: { filter: { _id: s._id }, update: { $set: { currentStock: p.quantity, purchasePrice: p.avgRate, costValue: p.costValue, updatedAt: new Date() } } } };
        }),
        { session }
      );

      await OpeningBalanceVoucher.create(
        [{
          _id: voucherId, ...getTenant(), section: "stock", voucherNo, date: day, narration: "Opening stock",
          rows: voucherRows, totalValue: total, status: "posted", createdBy,
        }],
        { session }
      );
      if (total > 0) {
        const base = { voucherId, voucherNo, voucherType: "opening_stock", date: day, referenceType: "opening_stock", referenceId: voucherId, referenceNo: voucherNo, createdBy: asAdmin(adminId), narration: "Opening stock" };
        await writeEntries(
          [
            { ...base, accountId: inventoryId, accountName: inventory.accountName, accountCode: inventory.accountCode, debitAmount: total, creditAmount: 0 },
            { ...base, accountId: equity.id, accountName: equity.accountName, accountCode: equity.accountCode, debitAmount: 0, creditAmount: total },
          ],
          session
        );
      }

      return {
        _id: voucherId, voucherNo, date: day, rows: clean.length, totalValue: total, warnings,
        equityOffset: { account: equity.accountName, side: "credit", amount: total },
        items: items.map((s) => {
          const p = pools.get(String(s._id));
          return { itemId: s.itemId, itemName: s.itemName, qty: p.quantity, avgCost: p.avgRate, value: p.costValue };
        }),
      };
    });
  }

  // Take an opening stock voucher back out: only if no other movement exists for its items. Each
  // movement gets its paired reversal (as reverseTransactionStock does), the batches are removed
  // and the pool returns to where it was before the entry.
  static async reverseStock(id, { adminId } = {}) {
    return this.reverseVoucher(id, "stock", { adminId });
  }

  static async reverseStockMovements(voucher, { adminId, session }) {
    const codes = [...new Set(voucher.rows.map((r) => r.itemCode))];
    const later = await this.itemsWithHistory(codes, { excludeVoucherId: voucher._id, session });
    if (later.size) {
      const names = [...new Set(voucher.rows.filter((r) => later.has(r.itemCode)).map((r) => r.itemName))];
      throw new AppError(
        `${names.join(", ")} ${names.length === 1 ? "has" : "have"} stock movements after the opening entry, so it cannot be reversed. Use a stock adjustment instead.`,
        409,
        "STOCK_HAS_MOVEMENTS",
        { items: names }
      );
    }
    const movements = await InventoryMovement.find({
      referenceId: voucher._id, referenceType: "Adjustment", eventType: "OPENING_STOCK", ...LIVE_MOVEMENT,
    }).sort({ _id: -1 }).session(session);

    await BatchService.removeReceipt(voucher._id, { session }); // 409 if a batch was partly used

    const stocks = new Map((await Stock.find({ itemId: { $in: codes } }).session(session)).map((s) => [s.itemId, s]));
    const state = new Map();
    const reversals = [];
    for (const m of movements) { // newest first, so each step undoes the one on top
      const stock = stocks.get(m.stockId);
      if (!stock) throw new AppError(`Stock item ${m.stockId} not found`, 404, "ITEM_NOT_FOUND");
      const now = state.get(m.stockId) || {
        quantity: Number(stock.currentStock) || 0,
        costValue: stock.costValue ?? costing.roundValue((Number(stock.currentStock) || 0) * (stock.purchasePrice || 0)),
        avgRate: costing.roundRate(stock.purchasePrice || 0),
      };
      const next = {
        quantity: costing.roundTo(now.quantity - m.quantity, 6),
        costValue: costing.roundValue(now.costValue - (m.totalValue || 0)),
        avgRate: costing.roundRate(m.rateBefore ?? 0),
      };
      state.set(m.stockId, next);
      reversals.push({
        stockId: m.stockId, quantity: -m.quantity, previousStock: now.quantity, newStock: next.quantity,
        eventType: m.eventType, referenceType: "Adjustment", referenceId: voucher._id, referenceNumber: `REV-${voucher.voucherNo}`,
        date: m.date, unitCost: m.unitCost, totalValue: m.totalValue, costBasis: m.costBasis,
        rateBefore: now.avgRate, rateAfter: next.avgRate, costPoolAfter: next.costValue, poolQtyAfter: next.quantity,
        notes: `Reversal of ${m.notes}`, createdBy: String(adminId || "system"), location: m.location,
        batchNumber: m.batchNumber, expiryDate: m.expiryDate, companyId: m.companyId, branchId: m.branchId,
      });
    }
    const saved = await InventoryMovement.insertMany(reversals, { session, ordered: true });
    await InventoryMovement.bulkWrite(
      movements.map((m, i) => ({ updateOne: { filter: { _id: m._id }, update: { $set: { isReversed: true, reversalReference: saved[i]._id } } } })),
      { session }
    );
    await Stock.bulkWrite(
      [...state.entries()].map(([code, s]) => ({
        updateOne: { filter: { _id: stocks.get(code)._id }, update: { $set: { currentStock: s.quantity, costValue: s.costValue, purchasePrice: s.avgRate, updatedAt: new Date() } } },
      })),
      { session }
    );
  }

  // ------------------------------------------------------------------ summary

  static async summary(req) {
    const goLive = await this.goLive();
    const day = goLive.date;
    const [entered, equity, voucherDocs, custList, vendList, stockVouchers] = await Promise.all([
      this.enteredAccounts(),
      this.equity().catch((err) => { if (err.code === "ACCOUNT_NOT_CONFIGURED") return null; throw err; }),
      OpeningBalanceVoucher.find({ section: "accounts", status: "posted" }).lean(),
      this.openingInvoices("customer"),
      this.openingInvoices("vendor"),
      OpeningBalanceVoucher.find({ section: "stock", status: "posted" }).lean(),
    ]);

    // The opening trial balance: every live opening entry, whichever section made it.
    const [tb] = await LedgerEntry.aggregate([
      { $match: { voucherType: { $in: ["opening", "opening_stock"] }, isReversed: { $ne: true } } },
      { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" }, entries: { $sum: 1 } } },
    ]);
    const debit = round2(tb?.debit || 0);
    const credit = round2(tb?.credit || 0);
    let equityOpening = 0;
    let equityBalance = 0;
    if (equity) {
      const [o] = await LedgerEntry.aggregate([
        { $match: { accountId: new mongoose.Types.ObjectId(String(equity.id)), voucherType: { $in: ["opening", "opening_stock"] }, isReversed: { $ne: true } } },
        { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
      ]);
      const [all] = await LedgerEntry.aggregate([
        { $match: { accountId: new mongoose.Types.ObjectId(String(equity.id)), isReversed: { $ne: true } } },
        { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
      ]);
      equityOpening = round2((o?.credit || 0) - (o?.debit || 0));
      equityBalance = round2((all?.credit || 0) - (all?.debit || 0));
    }

    const sum = (list, k) => round2(list.reduce((t, x) => t + (x[k] || 0), 0));
    const accounts = {
      rows: entered.length, vouchers: voucherDocs.length,
      debit: sum(entered, "debit"), credit: sum(entered, "credit"),
      // what the vouchers pushed into Opening Balance Equity: credit positive
      difference: round2(voucherDocs.reduce((t, v) => t + (v.differenceSide === "credit" ? v.differenceAmount : v.differenceSide === "debit" ? -v.differenceAmount : 0), 0)),
    };
    const stock = {
      rows: stockVouchers.reduce((t, v) => t + v.rows.length, 0),
      items: new Set(stockVouchers.flatMap((v) => v.rows.map((r) => r.itemCode))).size,
      vouchers: stockVouchers.length, value: sum(stockVouchers, "totalValue"),
    };

    // stock value against the Inventory account at the go-live day
    let reconciliation = { available: false, reason: day ? "Inventory account is not mapped" : "Set the go-live date first" };
    if (day) {
      try {
        const StockReportsService = require("../reports/stockReportsService");
        const v = await StockReportsService.valuation({ asOn: dayKey(day) });
        reconciliation = { ...v.reconciliation, items: v.totals.items };
      } catch (err) {
        if (!err.isOperational) throw err;
        reconciliation = { available: false, reason: err.message };
      }
    }

    const balanced = Math.abs(debit - credit) < EPS;
    const missing = [];
    if (!day) missing.push({ key: "go-live", message: "Choose the go-live date." });
    if (!accounts.rows) missing.push({ key: "accounts", message: "No account balances entered yet." });
    if (!custList.totals.count) missing.push({ key: "customers", message: "No customer opening invoices entered yet." });
    if (!vendList.totals.count) missing.push({ key: "vendors", message: "No vendor opening invoices entered yet." });
    if (!stock.rows) missing.push({ key: "stock", message: "No opening stock entered yet." });
    if (!balanced) missing.push({ key: "trial-balance", message: `The opening entries do not balance (debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)}).` });
    if (reconciliation.available && !reconciliation.reconciles) {
      missing.push({ key: "stock-reconciliation", message: `Stock value differs from the Inventory account by ${Math.abs(reconciliation.difference).toFixed(2)}.` });
    }

    return {
      goLive: day, postedAt: goLive.postedAt, equity,
      sections: {
        accounts,
        customers: { rows: custList.totals.count, parties: custList.totals.parties, total: custList.totals.amount, outstanding: custList.totals.outstanding },
        vendors: { rows: vendList.totals.count, parties: vendList.totals.parties, total: vendList.totals.amount, outstanding: vendList.totals.outstanding },
        stock,
      },
      trialBalance: {
        debit, credit, entries: tb?.entries || 0, balanced,
        equity: equity ? { accountName: equity.accountName, accountId: equity.id, openingBalance: equityOpening, balance: equityBalance } : null,
      },
      stockReconciliation: reconciliation,
      warnings: await this.warnings(day),
      missing,
    };
  }
}

module.exports = OpeningBalanceService;
