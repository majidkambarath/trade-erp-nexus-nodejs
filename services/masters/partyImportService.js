// A spreadsheet of customers or vendors (utils/masterImport.js decides each row; services/core/importService.js runs the loop). Every row is
// made through the SAME service the party form saves through, so it gets its number from the sequence, its ledger account in the chart, its
// VAT block and its terms exactly as a typed one does - nothing here writes a party by another road.
//
// ADD ONLY: a name or tax number we already hold is reported as a duplicate and left alone.
const AppError = require("../../utils/AppError");
const orgLocale = require("../../utils/orgLocale");
const masterImport = require("../../utils/masterImport");
const importRules = require("../../utils/importRules");
const ImportService = require("../core/importService");

const KINDS = {
  customer: { model: () => require("../../models/modules/customerModel"), nameField: "customerName", codeField: "customerId", trnField: "trnNumber", create: (fields) => require("../customer/customerService").createCustomer(fields) },
  vendor: { model: () => require("../../models/modules/vendorModel"), nameField: "vendorName", codeField: "vendorId", trnField: "trnNO", create: (fields) => require("../vendor/vendorService").createVendor(fields) },
};

class PartyImportService {
  /**
   * What the organisation already holds of this kind, as the sets the planner compares against. Read through the model (never the raw
   * driver), so it is the organisation's own records and nobody else's. `.lean()` skips the vendor's / customer's toJSON, which is where an
   * older record's tax number is lifted from its legacy field, so BOTH tax fields are read.
   */
  static async held(kind) {
    const k = KINDS[kind];
    const rows = await k.model().find({}).select(`${k.nameField} vat.trn ${k.trnField} email phone`).limit(50000).lean();
    return {
      names: new Set(rows.map((r) => masterImport.same(r[k.nameField])).filter(Boolean)),
      trns: new Set(rows.flatMap((r) => [r.vat?.trn, r[k.trnField]]).map((t) => String(t ?? "").trim()).filter(Boolean)),
      emails: new Set(rows.map((r) => String(r.email ?? "").trim().toLowerCase()).filter(Boolean)),
      phones: new Set(rows.map((r) => importRules.phoneTail(r.phone)).filter(Boolean)),
    };
  }

  /** `kind` is "customer" or "vendor"; `rows` the screen's mapped rows. Previews unless `dryRun === false`. */
  static async run(kind, rows, { dryRun = true } = {}) {
    const k = KINDS[kind];
    if (!k) throw new AppError(`Unknown party kind ${kind}`, 500);
    const plan = masterImport.planPartyImport(kind, rows, { existing: await this.held(kind), country: orgLocale.country() });
    if (plan.error) throw new AppError(plan.error.message, 400, plan.error.code);
    return ImportService.run(plan, {
      dryRun,
      create: (fields) => k.create(fields),
      describe: (doc) => ({ id: String(doc._id), code: doc[k.codeField], name: doc[k.nameField] }),
    });
  }
}

module.exports = PartyImportService;
