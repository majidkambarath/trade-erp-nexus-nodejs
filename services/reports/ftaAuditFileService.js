// The FTA VAT Audit File (FAF) for a period, from the books. The layout is utils/ftaAuditFile.js; this decides the rows.
//
// The purchase and supply listings are made from the SAME lines as the VAT return (VatReturnService.collect), one row per
// document line, so the file's VAT totals are the return's: supplies against the output tax on our own supplies, purchases
// against the recoverable input tax including the reverse charge. The general ledger table is every ledger entry of the
// period (a reversed posting and its mirror are left out, as every financial report leaves them out), each with its
// account's balance after it.
//
// Nothing is stored and nothing in the file can be edited: it is generated on request from what is posted.

const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const faf = require("../../utils/ftaAuditFile");
const orgLocale = require("../../utils/orgLocale");
const { getTenant } = require("../../utils/tenant");
const { round2 } = require("../../utils/accounting");
const VatReturnService = require("./vatReturnService");
const { VOUCHER_LABEL, dayStart, dayEnd } = require("./ledgerReportsService");
const AccountConfigService = require("../financial/accountConfigService");
const { LedgerEntry, LedgerAccount } = require("../../models/modules/financial/financialModels");

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCT = `Zarvia ${require("../../package.json").version}`;

const titleCase = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const unique = (list) => [...new Set(list.filter(Boolean).map(String))];

class FtaAuditFileService {
  /** The parties named by the rows: name, tax number and country. */
  static async parties(customerIds, vendorIds) {
    const Customer = mongoose.model("Customer");
    const Vendor = mongoose.model("Vendor");
    const [customers, vendors] = await Promise.all([
      Customer.find({ _id: { $in: customerIds } }).select("customerName trnNumber vat.trn country").lean(),
      Vendor.find({ _id: { $in: vendorIds } }).select("vendorName trnNO vat.trn country").lean(),
    ]);
    return new Map([
      ...customers.map((c) => [String(c._id), { name: c.customerName, trn: c.vat?.trn || c.trnNumber || "", country: c.country || "" }]),
      ...vendors.map((v) => [String(v._id), { name: v.vendorName, trn: v.vat?.trn || v.trnNO || "", country: v.country || "" }]),
    ]);
  }

  /** The two listings, from the VAT return's own lines. */
  static async listings({ from, to }) {
    const lines = await VatReturnService.collect({ from, to });
    const parties = await this.parties(
      unique(lines.filter((l) => l.partyType === "Customer").map((l) => l.partyId)),
      unique(lines.filter((l) => l.partyType === "Vendor").map((l) => l.partyId))
    );
    // a document line saved with no description is described by its item
    const bare = unique(lines.filter((l) => !String(l.description || "").trim() && l.itemId).map((l) => l.itemId));
    const items = bare.length ? await mongoose.model("Stock").find({ _id: { $in: bare } }).select("itemName").lean() : [];
    const itemName = new Map(items.map((i) => [String(i._id), i.itemName]));

    const purchases = [];
    const supplies = [];
    for (const l of lines) {
      const input = l.direction === "input";
      const party = parties.get(String(l.partyId)) || {};
      const reverse = l.kind === "reverse_charge";
      const row = {
        party: party.name || l.partyName || "",
        trn: party.trn || "",
        day: orgLocale.dayOf(l.date),
        // the tax invoice's number: the one we issued where we raised it ourselves, else the supplier's own where it was
        // recorded; otherwise our document's number
        invoiceNo: l.selfBilledNo || (input && l.docType === "purchase_order" && l.supplierRef) || (input && l.source === "expense" && l.supplierRef) || l.docNo,
        permitNo: "", // customs import permits are not recorded
        lineNo: l.lineNo || 1,
        description: String(l.description || "").trim() || itemName.get(String(l.itemId)) || "",
        amountAED: round2(l.taxable),
        // a reverse-charge purchase carries the tax we assessed on it; our own sale of that kind charges none
        vatAED: round2(reverse ? (input ? l.rcmVat : 0) : l.vat),
        kind: l.kind === "unclassified" ? "" : l.kind,
        currency: l.fx?.currency || "",
        amountFCY: l.fx ? round2(l.fx.taxable) : 0,
        vatFCY: l.fx ? round2(l.fx.vat) : 0,
      };
      if (input) purchases.push(row);
      else supplies.push({ ...row, country: l.kind === "zero_rated" && party.country && party.country !== "AE" ? party.country : "" });
    }
    return { purchases, supplies };
  }

  /** Every ledger entry of the period in date order, with its account's balance after it (debit less credit). */
  static async ledger({ from, to }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    const before = await LedgerEntry.aggregate([
      { $match: { isReversed: { $ne: true }, date: { $lt: start } } },
      { $group: { _id: "$accountId", net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
    ]);
    const balance = new Map(before.map((r) => [String(r._id), r.net || 0]));
    const entries = await LedgerEntry.find({ isReversed: { $ne: true }, date: { $gte: start, $lte: end } })
      .select("date accountId accountName accountCode narration partyId partyType voucherNo voucherType referenceNo debitAmount creditAmount")
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean();
    const [accounts, parties] = await Promise.all([
      LedgerAccount.find({ _id: { $in: unique(entries.map((e) => e.accountId)) } }).select("accountCode accountName").lean(),
      this.parties(
        unique(entries.filter((e) => e.partyType === "Customer").map((e) => e.partyId)),
        unique(entries.filter((e) => e.partyType === "Vendor").map((e) => e.partyId))
      ),
    ]);
    const account = new Map(accounts.map((a) => [String(a._id), a]));
    return entries.map((e) => {
      const key = String(e.accountId);
      const after = round2((balance.get(key) || 0) + (e.debitAmount || 0) - (e.creditAmount || 0));
      balance.set(key, after);
      const a = account.get(key);
      return {
        day: orgLocale.dayOf(e.date),
        accountId: a?.accountCode || e.accountCode || key,
        accountName: a?.accountName || e.accountName,
        description: e.narration || "",
        name: parties.get(String(e.partyId))?.name || "",
        transactionId: e.voucherNo,
        sourceDocumentId: e.referenceNo || e.voucherNo,
        sourceType: VOUCHER_LABEL[e.voucherType] || titleCase(e.voucherType),
        debit: e.debitAmount || 0,
        credit: e.creditAmount || 0,
        balance: after,
      };
    });
  }

  /** -> { fileName, text, totals } */
  static async generate({ from, to } = {}) {
    VatReturnService.assertWholeOrganisation(); // one file for the taxpayer, every branch
    if (!YMD.test(String(from || "")) || !YMD.test(String(to || ""))) throw new AppError("Choose the first and last day of the period", 400, "PERIOD_REQUIRED");
    if (from > to) throw new AppError("The period ends before it starts", 400, "INVALID_PERIOD");
    if (orgLocale.baseCurrency() !== "AED") {
      throw new AppError("The FTA audit file is stated in dirhams, and these books are kept in another currency", 409, "FAF_NEEDS_AED");
    }
    const { companyId } = getTenant();
    const settings = await AccountConfigService.getSettings({});
    const profile = settings?.profile || {};
    if (!String(profile.trn || "").trim()) {
      throw new AppError("Save the company's tax number under Settings > Business rules > Tax identity first", 409, "TRN_REQUIRED");
    }
    const organisation = await mongoose.model("Organisation").findOne({ code: companyId }).select("legalName name").lean();

    const [{ purchases, supplies }, ledger] = await Promise.all([this.listings({ from, to }), this.ledger({ from, to })]);
    const built = faf.build({
      company: {
        nameEn: profile.legalName || organisation?.legalName || organisation?.name || "",
        nameAr: profile.legalNameArabic || "",
        trn: profile.trn,
        periodStart: from,
        periodEnd: to,
        createdOn: orgLocale.today(),
        product: PRODUCT,
      },
      purchases,
      supplies,
      ledger,
      currency: "AED",
    });
    const trn = String(profile.trn).replace(/[^A-Za-z0-9]/g, "");
    return { fileName: `FAF_${trn}_${from}_${to}.csv`, text: built.text, totals: built.totals };
  }
}

module.exports = FtaAuditFileService;
