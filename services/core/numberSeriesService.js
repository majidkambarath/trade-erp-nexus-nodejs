const NumberSeries = require("../../models/modules/financial/numberSeriesModel");
const FiscalYearService = require("./fiscalYearService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

// Default definition of every series the app issues. A series row is created on first use.
const SERIES = {
  PO: { prefix: "PO", numberLength: 4, label: "Purchase order" },
  SO: { prefix: "SO", numberLength: 4, label: "Sales order" },
  PR: { prefix: "PR", numberLength: 4, label: "Purchase return" },
  SR: { prefix: "SR", numberLength: 4, label: "Sales return" },
  // Documents that post nothing: an offer, and the paper that travels with the goods. DLN rather than
  // DN, which is the debit note.
  QT: { prefix: "QT", numberLength: 4, label: "Quotation" },
  DLN: { prefix: "DLN", numberLength: 4, label: "Delivery note" },
  RV: { prefix: "RV", numberLength: 4, label: "Receipt voucher" },
  PV: { prefix: "PV", numberLength: 4, label: "Payment voucher" },
  JV: { prefix: "JV", numberLength: 4, label: "Journal voucher" },
  CV: { prefix: "CV", numberLength: 4, label: "Contra voucher" },
  EV: { prefix: "EV", numberLength: 4, label: "Expense voucher" },
  DN: { prefix: "DN", numberLength: 4, label: "Debit note" },
  CN: { prefix: "CN", numberLength: 4, label: "Credit note" },
  WO: { prefix: "WO", numberLength: 4, label: "Stock write-off" },
  SA: { prefix: "SA", numberLength: 4, label: "Stock adjustment" },
  // Opening balances (go-live): account balances, customer / vendor invoices carried over, stock.
  OBV: { prefix: "OBV", numberLength: 4, label: "Opening balance voucher" },
  OSI: { prefix: "OSI", numberLength: 4, label: "Opening sales invoice" },
  OPI: { prefix: "OPI", numberLength: 4, label: "Opening purchase invoice" },
  OST: { prefix: "OST", numberLength: 4, label: "Opening stock voucher" },
  // A completed bank reconciliation (a bank account proven against its statement as of a date).
  BRC: { prefix: "BRC", numberLength: 4, label: "Bank reconciliation" },
};

const SERIES_BY_TRANSACTION_TYPE = {
  purchase_order: "PO",
  sales_order: "SO",
  purchase_return: "PR",
  sales_return: "SR",
};

const SERIES_BY_VOUCHER_TYPE = {
  receipt: "RV",
  payment: "PV",
  journal: "JV",
  contra: "CV",
  expense: "EV",
  debit_note: "DN",
  credit_note: "CN",
};

const HEAD_OFFICE = "main";

// A document number is unique across the organisation, not per branch (a tax invoice number must be unique for the
// taxpayer), so every branch but the head office carries its code in front: SO-2026-0001 at head office, SHJ-SO-2026-0001
// in Sharjah. The prefix is fixed when a branch first uses a series.
const prefixFor = (def, branchId) => (!branchId || branchId === HEAD_OFFICE ? def.prefix : `${String(branchId).toUpperCase()}-${def.prefix}`);

class NumberSeriesService {
  // Allocates the next number with ONE atomic findOneAndUpdate($inc). Concurrent callers get
  // distinct numbers; a rolled-back transaction leaves a gap but never a duplicate. Numbers
  // are never reused (a recycled invoice number would refer to two documents over time).
  //
  // Call inside the posting transaction and pass its session.
  static async allocate(series, date = new Date(), { session, req } = {}) {
    const def = SERIES[series];
    if (!def) throw new AppError(`Unknown number series: ${series}`, 500, "UNKNOWN_SERIES");

    const { companyId, branchId } = getTenant(req);
    const fiscalYear = await FiscalYearService.keyForDate(date, { session, companyId });

    const doc = await NumberSeries.findOneAndUpdate(
      { companyId, branchId, series, fiscalYear },
      {
        $inc: { next: 1 },
        $setOnInsert: { prefix: prefixFor(def, branchId), numberLength: def.numberLength },
      },
      { upsert: true, new: true, session }
    );

    return `${doc.prefix}-${fiscalYear}-${String(doc.next).padStart(doc.numberLength, "0")}`;
  }

  // `count` consecutive numbers from ONE atomic $inc: a bulk document such as a batch of opening
  // invoices, which would otherwise pay one round trip per number inside the transaction.
  static async allocateMany(series, count, date = new Date(), { session, req } = {}) {
    const def = SERIES[series];
    if (!def) throw new AppError(`Unknown number series: ${series}`, 500, "UNKNOWN_SERIES");
    if (!(count >= 1)) return [];

    const { companyId, branchId } = getTenant(req);
    const fiscalYear = await FiscalYearService.keyForDate(date, { session, companyId });
    const doc = await NumberSeries.findOneAndUpdate(
      { companyId, branchId, series, fiscalYear },
      { $inc: { next: count }, $setOnInsert: { prefix: prefixFor(def, branchId), numberLength: def.numberLength } },
      { upsert: true, new: true, session }
    );
    return Array.from({ length: count }, (_, i) => `${doc.prefix}-${fiscalYear}-${String(doc.next - count + 1 + i).padStart(doc.numberLength, "0")}`);
  }

  static forTransactionType(type) {
    const s = SERIES_BY_TRANSACTION_TYPE[type];
    if (!s) throw new AppError(`No number series for transaction type ${type}`, 400, "UNKNOWN_SERIES");
    return s;
  }

  static forVoucherType(type) {
    const s = SERIES_BY_VOUCHER_TYPE[type];
    if (!s) throw new AppError(`No number series for voucher type ${type}`, 400, "UNKNOWN_SERIES");
    return s;
  }

  static async list(req) {
    const { companyId, branchId } = getTenant(req);
    return NumberSeries.find({ companyId, branchId }).sort({ series: 1, fiscalYear: -1 }).lean();
  }
}

module.exports = NumberSeriesService;
module.exports.SERIES = SERIES;
