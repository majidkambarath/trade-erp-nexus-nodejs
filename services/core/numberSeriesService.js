const NumberSeries = require("../../models/modules/financial/numberSeriesModel");
const IssuedNumber = require("../../models/modules/financial/issuedNumberModel");
const FiscalYearService = require("./fiscalYearService");
const VoucherTypeService = require("./voucherTypeService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { ambientTenant } = require("../../utils/tenantContext");
const V = require("../../utils/voucherTypes");

// The one generator of document numbers. What a series is NAMED and how its number is SHAPED now lives
// in the voucher type master (utils/voucherTypes.js, services/core/voucherTypeService.js); this file
// claims the next number and records that it did.
//
// Three rules hold whatever an organisation configures:
//   - A number is rendered from the type, and the counter is keyed on the LABEL that number prints, so
//     "same label, same counter" is true by construction and two documents cannot be handed one number.
//   - Every number given out is recorded (IssuedNumber), so a gap in a sequence can always be explained.
//   - A number is re-used only where the type allows it, only from the record of a released one, and
//     only inside a transaction. Everywhere else the counter only ever moves forward.
//
// Call inside the posting transaction and pass its session.

// The built-in series, as the old hardcoded table: kept so `NumberSeriesService.SERIES` stays a usable
// surface. The master is seeded from the same place (utils/voucherTypes.js SEED).
const SERIES = Object.fromEntries(
  V.SEED.map((r) => [r.key, { prefix: r.prefix, numberLength: V.DEFAULTS.numberLength, label: r.name }])
);

const SERIES_BY_TRANSACTION_TYPE = Object.fromEntries(
  V.SEED.filter((r) => r.kind === "trade" && r.postsAs).map((r) => [r.postsAs, r.key])
);

const SERIES_BY_VOUCHER_TYPE = Object.fromEntries(
  V.SEED.filter((r) => r.kind === "voucher" && r.postsAs).map((r) => [r.postsAs, r.key])
);

const HEAD_OFFICE = V.HEAD_OFFICE;
const actorOf = (req) => (req && req.admin && req.admin.id ? String(req.admin.id) : null);
const inTransaction = (session) => Boolean(session && typeof session.inTransaction === "function" && session.inTransaction());

class NumberSeriesService {
  /**
   * The configuration and the counter's label for a series on a date. One place, so allocate, allocateMany
   * and the manual-override path cannot disagree about which counter a date belongs to.
   */
  static async plan(series, date, { session, req, voucherTypeKey, postsAs } = {}) {
    const { companyId, branchId } = getTenant(req);
    const type = await VoucherTypeService.configFor({ series, voucherTypeKey, postsAs, companyId });
    if (!type) throw new AppError("Unknown number series: " + series, 500, "UNKNOWN_SERIES");
    if (type.isActive === false) {
      throw new AppError(type.name + " is switched off, so no number can be given out for it.", 422, "VOUCHER_TYPE_INACTIVE");
    }
    // keyForDate is the fiscal year's code when one covers the date, else the organisation's own
    // calendar year - exactly the string this has always printed.
    const yearKey = await FiscalYearService.keyForDate(date, { session, companyId });
    const { label, yearCode } = V.labelOf({ type, fiscalYear: { code: yearKey }, year: yearKey });
    return { companyId, branchId, type, label, yearCode, series: type.key };
  }

  /**
   * Allocates the next number. Concurrent callers get distinct numbers: the counter moves with ONE
   * atomic findOneAndUpdate($inc), and two allocations against the same counter row inside transactions
   * conflict and are retried on a fresh session by utils/withTransactionSession.js.
   *
   * `docType` / `docId` say what the number was given to, so it can be released again if the document is
   * deleted and the type allows it. A caller that passes neither still gets its number and still leaves a
   * record; the record simply does not name a document.
   */
  static async allocate(series, date = new Date(), { session, req, voucherTypeKey, postsAs, docType, docId } = {}) {
    const p = await this.plan(series, date, { session, req, voucherTypeKey, postsAs });
    const by = actorOf(req);

    // A number freed by a deletion comes first, lowest first, where the type allows re-use. Claimed with
    // one conditional update so two callers cannot take the same row: the loser's filter no longer
    // matches and it falls through to the counter. Only inside a transaction - without one the claim
    // commits on its own, and a caller that then fails to write its document would lose the number with
    // nothing to show for it.
    if (V.mayReuse(p.type) && inTransaction(session)) {
      const claimed = await IssuedNumber.findOneAndUpdate(
        { companyId: p.companyId, branchId: p.branchId, series: p.series, label: p.label, status: "released" },
        { $set: { status: "issued", docType: docType || null, docId: docId || null, at: new Date(), by, reason: null, endedAt: null, endedBy: null } },
        { sort: { seq: 1 }, new: true, session }
      );
      // Re-issued exactly as it was first rendered: the gap being filled is that number, not whatever
      // the format would produce today.
      if (claimed) return claimed.number;
    }

    const counter = await NumberSeries.findOneAndUpdate(
      { companyId: p.companyId, branchId: p.branchId, series: p.series, fiscalYear: p.label },
      {
        $inc: { next: 1 },
        // $set, not $setOnInsert: the row then shows the format that minted its latest number, instead
        // of the format that happened to be in force the first time the series was ever used.
        $set: { prefix: V.renderPrefixFor(p.type, p.branchId), numberLength: V.widthOf(p.type) },
      },
      { upsert: true, new: true, session }
    );

    const number = V.renderNumber({ type: p.type, branchId: p.branchId, yearCode: p.yearCode, seq: counter.next });
    await this.record({ ...p, seq: counter.next, number, docType, docId, by, session });
    return number;
  }

  /** One row per number given out. The unique index on the number is what guarantees it is never used twice. */
  static async record({ companyId, branchId, series, label, seq, number, docType, docId, by, manual, session }) {
    try {
      const rows = [{
        companyId, branchId, series, label, seq, number,
        docType: docType || null, docId: docId || null,
        status: "issued", manual: Boolean(manual), by: by || null, at: new Date(),
      }];
      await IssuedNumber.create(rows, { session, ordered: true });
    } catch (err) {
      if (err && err.code === 11000) {
        throw new AppError(number + " has already been given to another document.", 409, "NUMBER_ALREADY_USED");
      }
      throw err;
    }
  }

  /**
   * `count` consecutive numbers from ONE atomic $inc: a bulk document such as a batch of opening
   * invoices, which would otherwise pay one round trip per number inside the transaction.
   *
   * Deliberately does NOT re-use released numbers: a caller asking for a run wants it contiguous.
   */
  static async allocateMany(series, count, date = new Date(), { session, req, docType } = {}) {
    const n = Math.trunc(Number(count) || 0);
    if (!(n >= 1)) return [];
    const p = await this.plan(series, date, { session, req });
    const by = actorOf(req);

    const counter = await NumberSeries.findOneAndUpdate(
      { companyId: p.companyId, branchId: p.branchId, series: p.series, fiscalYear: p.label },
      { $inc: { next: n }, $set: { prefix: V.renderPrefixFor(p.type, p.branchId), numberLength: V.widthOf(p.type) } },
      { upsert: true, new: true, session }
    );

    const first = counter.next - n + 1;
    const numbers = Array.from({ length: n }, (_, i) => V.renderNumber({ type: p.type, branchId: p.branchId, yearCode: p.yearCode, seq: first + i }));
    try {
      await IssuedNumber.create(
        numbers.map((number, i) => ({
          companyId: p.companyId, branchId: p.branchId, series: p.series, label: p.label,
          seq: first + i, number, docType: docType || null, docId: null,
          status: "issued", manual: false, by, at: new Date(),
        })),
        { session, ordered: true }
      );
    } catch (err) {
      if (err && err.code === 11000) throw new AppError("One of those numbers has already been given out.", 409, "NUMBER_ALREADY_USED");
      throw err;
    }
    return numbers;
  }

  /**
   * A number a person typed, where the type allows it. The number is theirs; what this does is make sure
   * the automatic series can never collide with it later.
   *
   * Before this, a client-supplied transactionNo was accepted on trade documents with nothing but a
   * uniqueness check and the counter was left where it was - so the series would eventually reach the
   * typed number and fail on the unique index. Here the counter is FLOATED past it, the way
   * AccountGroupService.generateNextAccountCode floors an account code against the highest one already
   * used.
   */
  static async claimManual(series, number, date = new Date(), { session, req, voucherTypeKey, postsAs, docType, docId } = {}) {
    const p = await this.plan(series, date, { session, req, voucherTypeKey, postsAs });
    if (!V.mayOverride(p.type)) {
      throw new AppError(p.type.name + " is numbered automatically, so its number cannot be typed.", 422, "NUMBER_NOT_TYPEABLE");
    }
    const typed = String(number || "").trim().toUpperCase();
    if (!typed) throw new AppError("A number is needed.", 400, "NUMBER_REQUIRED");

    // Only a number in this series' OWN format belongs to its sequence. One outside it is still
    // recorded, but it is not part of the count and cannot float the counter.
    const seq = V.seqOf({ type: p.type, branchId: p.branchId, yearCode: p.yearCode, number: typed });
    if (seq) {
      await NumberSeries.updateOne(
        { companyId: p.companyId, branchId: p.branchId, series: p.series, fiscalYear: p.label },
        { $max: { next: seq }, $set: { prefix: V.renderPrefixFor(p.type, p.branchId), numberLength: V.widthOf(p.type) } },
        { upsert: true, session }
      );
    }
    await this.record({ ...p, seq, number: typed, docType, docId, by: actorOf(req), manual: true, session });
    return typed;
  }

  /**
   * A document has been deleted. Either its number goes back to be used again, or it is retired and the
   * gap stays on record with its reason.
   *
   * `retire: true` forces retirement whatever the type says, and is how a caller reports that THIS
   * document has spent its number - it was sent to the customer, or e-invoiced, so the number is already
   * in somebody else's hands.
   *
   * Idempotent: the claim is conditional on the row still being `issued`, so a repeated delete, or a
   * retried transaction, changes nothing the second time.
   */
  static async release({ number, docId, reason, retire, session, req, series, by } = {}) {
    if (!number && !docId) return null;
    const { companyId } = getTenant(req);
    // By NUMBER wherever possible: a number is allocated before the document that will carry it exists,
    // so the register does not always know the id - but the document always knows its number.
    const filter = { companyId, status: "issued" };
    if (number) filter.number = String(number).trim().toUpperCase();
    else filter.docId = docId;
    if (series) filter.series = String(series).toUpperCase();
    const q = IssuedNumber.findOne(filter);
    const row = await (session ? q.session(session) : q).lean();
    if (!row) return null;

    const type = await VoucherTypeService.configFor({ series: row.series, companyId });
    const reusable = !retire && V.mayReuse(type);
    const res = await IssuedNumber.updateOne(
      { _id: row._id, status: "issued" },
      { $set: { status: reusable ? "released" : "cancelled", reason: String(reason || "").slice(0, 200) || null, endedAt: new Date(), endedBy: by ? String(by) : actorOf(req) } },
      { session }
    );
    if (!res.modifiedCount) return null; // somebody else got there first
    return { number: row.number, seq: row.seq, series: row.series, status: reusable ? "released" : "cancelled" };
  }

  static forTransactionType(type) {
    const s = SERIES_BY_TRANSACTION_TYPE[type];
    if (!s) throw new AppError("No number series for transaction type " + type, 400, "UNKNOWN_SERIES");
    return s;
  }

  static forVoucherType(type) {
    const s = SERIES_BY_VOUCHER_TYPE[type];
    if (!s) throw new AppError("No number series for voucher type " + type, 400, "UNKNOWN_SERIES");
    return s;
  }

  /**
   * The series a voucher is numbered from, allowing for a named variant. A variant is chosen by its own
   * key and posts as its parent, which is why nothing that compares voucherType against "payment" needs
   * to know it exists.
   */
  static async seriesFor({ voucherType, voucherTypeKey, req } = {}) {
    const { companyId } = getTenant(req);
    const type = await VoucherTypeService.configFor({ voucherTypeKey, postsAs: voucherType, companyId });
    if (type) return type.key;
    return this.forVoucherType(voucherType);
  }

  /**
   * The counters as they stand. A head office in the all-branches view sees every branch's: it used to
   * be pinned to the one branch being worked in, so head office could not see a branch's numbering at
   * all. branchView is read from the ambient scope because getTenant() does not carry it.
   */
  static async list(req, { series } = {}) {
    const { companyId, branchId } = getTenant(req);
    const ambient = ambientTenant();
    const view = ambient && Object.prototype.hasOwnProperty.call(ambient, "branchView") ? ambient.branchView : branchId;
    const filter = { companyId };
    if (view) filter.branchId = view;
    if (series) filter.series = String(series).toUpperCase();
    const rows = await NumberSeries.find(filter).sort({ series: 1, fiscalYear: -1 }).lean();
    return rows.map((r) => ({ ...r, label: r.fiscalYear, scope: V.labelText(r.fiscalYear) }));
  }
}

module.exports = NumberSeriesService;
module.exports.SERIES = SERIES;
module.exports.SERIES_BY_TRANSACTION_TYPE = SERIES_BY_TRANSACTION_TYPE;
module.exports.SERIES_BY_VOUCHER_TYPE = SERIES_BY_VOUCHER_TYPE;
module.exports.HEAD_OFFICE = HEAD_OFFICE;
