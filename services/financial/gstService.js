const mongoose = require("mongoose");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const orgLocale = require("../../utils/orgLocale");
const gst = require("../../utils/gst");
const { stateCodeOfGstin, isStateCode } = require("../../utils/gstStates");

// India GST, where the database is involved (the pure rules are in utils/gst.js).
//
// Whether the supply is within the supplier's state decides CGST + SGST or IGST. That is worked out ONCE, when a document is
// priced, and stored on it (gstType, placeOfSupply, supplierState), so changing a party's state later never rewrites a document
// that was already issued. A return follows the invoice it returns: the credit note undoes what that invoice charged.
class GstService {
  static get applies() {
    return orgLocale.country() === "IN";
  }

  // The state the company is registered in: the one entered, else the one inside its own GSTIN. null when neither is on file.
  static async companyState({ session } = {}) {
    const q = CompanySettings.findOne({}).select("profile.stateCode profile.trn").lean();
    const row = await (session ? q.session(session) : q);
    const typed = row?.profile?.stateCode;
    if (isStateCode(typed)) return String(typed);
    return stateCodeOfGstin(row?.profile?.trn);
  }

  /**
   * The GST view a document is priced under, or null when the organisation is not Indian or the company's own state is unknown
   * (the document then carries total tax only, exactly as before GST detail existed).
   *   { partyType, partyId, side, returnOf: { transactionId }, session }
   * -> { gstType, placeOfSupply, supplierState }
   */
  static async context({ partyType, partyId, side, returnOf, session } = {}) {
    if (!this.applies || !side) return null;
    if (returnOf?.transactionId) {
      const Transaction = require("../../models/modules/transactionModel");
      const q = Transaction.findById(returnOf.transactionId).select("gstType placeOfSupply supplierState").lean();
      const original = await (session ? q.session(session) : q);
      if (original?.gstType) return { gstType: original.gstType, placeOfSupply: original.placeOfSupply, supplierState: original.supplierState };
    }
    const companyState = await this.companyState({ session });
    if (!companyState) return null;
    let party = null;
    if (partyId) {
      const Model = mongoose.model(partyType === "Vendor" ? "Vendor" : "Customer");
      const q = Model.findById(partyId).select("stateCode vat trnNumber trnNO").lean();
      party = await (session ? q.session(session) : q);
    }
    const r = gst.placeOfSupply({ companyState, party, side });
    return r.gstType ? r : null;
  }
}

module.exports = GstService;
