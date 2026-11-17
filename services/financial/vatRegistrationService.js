// Whether the organisation is registered for VAT on a given day (the rule is utils/vatRegistration.js; this reads the facts).
//
// One read of the organisation's own settings per call, inside the caller's session when it has one, so a document being priced
// in a transaction sees the settings as that transaction does.
//
// KILL SWITCH: VAT_REGISTRATION_RULES=off makes every answer "not governed" (nothing forced, nothing stamped, nothing hidden), which
// is what the older test suites run under - they build organisations with no tax number and expect VAT at the standard rate. A
// deployment never sets it; it exists so one wrong assumption about a live organisation can be undone with a variable, not a deploy.
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const orgLocale = require("../../utils/orgLocale");
const rule = require("../../utils/vatRegistration");
const { getTenant } = require("../../utils/tenant");

const NOT_GOVERNED = Object.freeze({ governs: false, registered: true, from: null });
const off = () => String(process.env.VAT_REGISTRATION_RULES || "").toLowerCase() === "off";

class VatRegistrationService {
  /** { governs, registered, from } for a document dated `date` (an instant or a "YYYY-MM-DD"), in the caller's organisation. */
  static async stateOn(date, { session } = {}) {
    if (off()) return NOT_GOVERNED;
    const country = orgLocale.country();
    if (String(country || "").toUpperCase() !== rule.GOVERNED_COUNTRY) return NOT_GOVERNED;
    const q = CompanySettings.findOne({ companyId: getTenant().companyId }).select("profile").lean();
    const settings = await (session ? q.session(session) : q);
    const day = orgLocale.dayOf(date || new Date());
    return { ...rule.stateOn(settings?.profile, country, day), from: settings?.profile?.vatRegisteredFrom || null };
  }
}

module.exports = VatRegistrationService;
