const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const { classify, STATUS, DEFAULT_WARNING_DAYS, MAX_WARNING_DAYS, todayInOrg, addDays } = require("../../utils/documentExpiry");

// Which customer / vendor documents have expired or expire soon. The documents live on the party
// records (the single source of truth); this reads them and classifies each by Dubai calendar day.
// Nothing is sent to anyone: there is no e-mail or notification job yet.
const PARTIES = {
  customer: { model: "Customer", nameField: "customerName", codeField: "customerId", partyType: "Customer" },
  vendor: { model: "Vendor", nameField: "vendorName", codeField: "vendorId", partyType: "Vendor" },
};

// An employee's own documents (W4) are a SEPARATE collection (EmployeeDocument, one row each), not an
// embedded array on Staff - services/hr/labourCostService.js already reads it this way. So "staff" is
// handled by its own branch in list() below rather than forced into the embedded-array shape PARTIES
// reads; it is still the same classify()/STATUS reasoning and the same combined report.
const STAFF_KIND = "staff";

class DocumentExpiryService {
  static parseWithin(value) {
    if (value === undefined || value === null || value === "") return DEFAULT_WARNING_DAYS;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_WARNING_DAYS) {
      throw new AppError(`withinDays must be a whole number from 0 to ${MAX_WARNING_DAYS}`, 400, "INVALID_WITHIN_DAYS");
    }
    return n;
  }

  // { rows, summary }: the documents that are expired or expire within `withinDays` days, soonest
  // first. `partyType` is "customer" or "vendor" (anything else, or none, lists both). An inactive
  // customer is left out unless `includeInactive`.
  static async list({ withinDays, partyType, includeInactive = false, now = new Date() } = {}) {
    const within = this.parseWithin(withinDays);
    const wanted = String(partyType || "").toLowerCase();
    const validKinds = [...Object.keys(PARTIES), STAFF_KIND];
    if (wanted && !validKinds.includes(wanted)) throw new AppError("partyType must be customer, vendor or staff", 400, "INVALID_PARTY_TYPE");
    const kinds = wanted ? [wanted] : validKinds;
    const today = todayInOrg(now);
    // two days of slack in the query, so the exact Dubai-day decision is made by classify() alone
    const horizon = new Date(`${addDays(today, within + 2)}T00:00:00.000Z`);

    const rows = [];
    for (const kind of kinds) {
      if (kind === STAFF_KIND) {
        const EmployeeDocument = mongoose.models.EmployeeDocument;
        if (!EmployeeDocument) continue;
        const docs = await EmployeeDocument.find({ expiryDate: { $ne: null, $lte: horizon } }).select("staffId documentTypeId name number expiryDate attachmentId").lean();
        const staffIds = [...new Set(docs.map((d) => String(d.staffId)))];
        const staff = staffIds.length
          ? await mongoose.model("Staff").find({ _id: { $in: staffIds }, ...(includeInactive ? {} : { status: { $ne: "Inactive" } }) }).select("name staffId").lean()
          : [];
        const byId = new Map(staff.map((s) => [String(s._id), s]));
        for (const doc of docs) {
          const s = byId.get(String(doc.staffId));
          if (!s) continue; // inactive and excluded, or the employee no longer exists
          const c = classify(doc.expiryDate, { today, warningDays: within });
          if (c.status !== STATUS.EXPIRED && c.status !== STATUS.EXPIRING_SOON) continue;
          rows.push({
            partyType: "Staff",
            partyId: s._id,
            partyName: s.name,
            partyCode: s.staffId,
            documentId: doc._id,
            documentTypeId: doc.documentTypeId || null,
            documentType: doc.name || "",
            number: doc.number || "",
            expiryDate: c.expiryDay,
            status: c.status,
            daysLeft: c.daysLeft,
            hasFile: Boolean(doc.attachmentId),
          });
        }
        continue;
      }
      const p = PARTIES[kind];
      const filter = { documents: { $elemMatch: { expiryDate: { $ne: null, $lte: horizon } } } };
      if (kind === "customer" && !includeInactive) filter.status = { $ne: "Inactive" };
      const parties = await mongoose.model(p.model).find(filter).select(`${p.nameField} ${p.codeField} documents`).lean();
      for (const party of parties) {
        for (const doc of party.documents || []) {
          const c = classify(doc.expiryDate, { today, warningDays: within });
          if (c.status !== STATUS.EXPIRED && c.status !== STATUS.EXPIRING_SOON) continue;
          rows.push({
            partyType: p.partyType,
            partyId: party._id,
            partyName: party[p.nameField],
            partyCode: party[p.codeField],
            documentId: doc._id,
            documentTypeId: doc.documentTypeId || null,
            documentType: doc.typeName || "",
            number: doc.number || "",
            expiryDate: c.expiryDay,
            status: c.status,
            daysLeft: c.daysLeft,
            hasFile: Boolean(doc.attachmentId),
          });
        }
      }
    }
    rows.sort((a, b) => a.daysLeft - b.daysLeft || a.partyName.localeCompare(b.partyName));
    const expired = rows.filter((r) => r.status === STATUS.EXPIRED).length;
    return {
      asOf: today,
      withinDays: within,
      rows,
      summary: { expired, expiringSoon: rows.length - expired, total: rows.length },
    };
  }
}

module.exports = DocumentExpiryService;
