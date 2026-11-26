// Self-billed tax invoices and credit notes: who may, and their numbers. The rules are utils/selfBilling.js.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/selfBilling");
const orgLocale = require("../../utils/orgLocale");
const { getTenant } = require("../../utils/tenant");
const VatRegistrationService = require("./vatRegistrationService");
const NumberSeriesService = require("../core/numberSeriesService");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");

const SERIES = { purchase_order: "SBI", purchase_return: "SBC" };

class SelfBillingService {
  /** Refuses a self-billed document the law does not allow for this supplier on this day. */
  static async assertAllowed({ partyId, date, session }) {
    const refused = await this.refusalFor({ partyId, date, session });
    if (refused) throw new AppError(refused.message, 400, refused.code);
  }

  /** Why we may not raise a document for this supplier on this day, or null. */
  static async refusalFor({ partyId, date, session }) {
    const Vendor = mongoose.model("Vendor");
    const vendorQuery = Vendor.findById(partyId).select("vendorName trnNO vat.trn selfBilling").lean();
    const settingsQuery = CompanySettings.findOne({ companyId: getTenant().companyId }).select("profile.trn").lean();
    const [vendor, settings] = await Promise.all([
      session ? vendorQuery.session(session) : vendorQuery,
      session ? settingsQuery.session(session) : settingsQuery,
    ]);
    const vat = await VatRegistrationService.stateOn(date || new Date(), { session });
    return rules.refusal({
      country: orgLocale.country(),
      recipientTrn: settings?.profile?.trn || "",
      registered: vat.governs ? vat.registered : true,
      vendor: vendor && { vendorName: vendor.vendorName, trn: vendor.vat?.trn || vendor.trnNO || "", selfBilling: vendor.selfBilling },
      day: orgLocale.dayOf(date || new Date()),
    });
  }

  /**
   * Whether a new document is self-billed. A purchase invoice when asked (and allowed); a purchase return when the
   * invoice it returns was and the agreement still covers the return's day (after it ends the credit note is the
   * supplier's to issue, and the return is an ordinary one); nothing else ever.
   */
  static async forNew(data, { session } = {}) {
    if (data.type === "purchase_return") {
      const id = data.returnOf?.transactionId;
      if (!mongoose.isValidObjectId(id)) return false;
      const Transaction = mongoose.model("Transaction");
      const original = await Transaction.findById(id).select("selfBilled").session(session || null).lean();
      if (!original?.selfBilled) return false;
      return !(await this.refusalFor({ partyId: data.partyId, date: data.date, session }));
    }
    if (data.selfBilled !== true) return false;
    if (data.type !== "purchase_order") throw new AppError("Only a purchase invoice or its return can be self-billed", 400, "SELF_BILLING_PURCHASES_ONLY");
    await this.assertAllowed({ partyId: data.partyId, date: data.date, session });
    return true;
  }

  /**
   * On approval: an invoice we may no longer raise is refused (the person unticks it or records the agreement); a
   * return outside the agreement becomes an ordinary return, since it still has to be booked. Else it takes its number.
   */
  static async stamp(transaction, { session }) {
    const refused = await this.refusalFor({ partyId: transaction.partyId, date: transaction.date, session });
    if (refused && transaction.type === "purchase_return") {
      transaction.set("selfBilled", undefined);
      return;
    }
    if (refused) throw new AppError(refused.message, 400, refused.code);
    // what the paper prints, kept as it was on the day: the agreement, and for a credit note the tax invoice it credits
    const vendor = await mongoose.model("Vendor").findById(transaction.partyId).select("selfBilling").session(session || null).lean();
    transaction.set("selfBillingRef", vendor?.selfBilling?.agreementRef);
    if (transaction.type === "purchase_return" && transaction.returnOf?.transactionId) {
      const original = await mongoose.model("Transaction").findById(transaction.returnOf.transactionId).select("selfBilledNo").session(session || null).lean();
      transaction.set("selfBilledAgainst", original?.selfBilledNo);
    }
    if (!transaction.selfBilledNo) transaction.selfBilledNo = await this.number(transaction, { session });
  }

  /** The statutory number of the tax invoice or credit note we raise, taken when the document is approved. */
  static async number(transaction, { session }) {
    return NumberSeriesService.allocate(SERIES[transaction.type], transaction.date, { session, docType: "Transaction", docId: transaction._id });
  }
}

module.exports = SelfBillingService;
