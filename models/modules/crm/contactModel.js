// A person: who you actually speak to at a customer, at a supplier, or behind an enquiry that is not a customer yet.
//
// Before this, a contact was a line inside the party form (`Customer.contacts[]`, models/modules/partyMasterSchemas.js)
// and nothing else: you could not open a person, see what was said to them, or find them without knowing which company
// they worked for. This is that record.
//
// IT IS NOT A SECOND MASTER. A contact that belongs to a party is stored in BOTH places under the SAME _id - the party's
// embedded array stays authoritative and every existing reader of it (the e-mail recipient list in
// services/messaging/documentSource.js, the party form, the shared snapshot) is untouched. services/crm/contactService.js
// owns that mirror and writes the party side through the existing services/masters/partyMasterService.js path, so there
// is one set of validation rules, not two. `partyMasterSchemas.js` already declares `{ _id: true }` on its contact
// subdocument, which is what makes sharing the id possible with no mapping table.
//
// A MASTER, like Customer: organisation-wide, NOT branch scoped. A person does not belong to a branch - the enquiry they
// came in on does (Lead and CrmActivity are documents and keep their branchId).
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

const contactSchema = new mongoose.Schema(
  {
    // The same four fields as the party's embedded contact row, deliberately: the mirror copies them across unchanged.
    name: { type: String, required: true, trim: true, maxlength: 100 },
    designation: { type: String, trim: true, maxlength: 100, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 30, default: "" },
    isPrimary: { type: Boolean, default: false },

    // Who they work for. At most one of customerId / vendorId is ever set (utils/crm.js `validateContact` refuses both):
    // the mirror has to know which array owns the row. leadId is for a person captured before there is a party at all;
    // qualifying the lead moves them onto the new customer.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    notes: { type: String, trim: true, maxlength: 1000, default: "" },

    createdBy: { type: String, default: "system" },
    updatedBy: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  },
  { timestamps: true }
);

// Declared with schema.index, never a field-level index: tenantPlugin puts companyId in front of each of these, which
// is what makes them per-organisation (utils/__tests__/tenantGuard.test.js fails on a global one).
// The party listings read "this customer's people, the main one first".
contactSchema.index({ customerId: 1, isPrimary: -1, name: 1 });
contactSchema.index({ vendorId: 1, isPrimary: -1, name: 1 });
contactSchema.index({ leadId: 1 });
// Searching for a person by how you have their number, which is usually all anybody remembers.
contactSchema.index({ email: 1 });
contactSchema.index({ phone: 1 });
contactSchema.index({ name: 1 });
contactSchema.index({ createdAt: -1 });

contactSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.Contact || mongoose.model("Contact", contactSchema);
