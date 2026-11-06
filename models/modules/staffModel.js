const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// The employee record. It began as a thin staff directory (a name, a designation, an ID and two uploads) and is
// now what HR is built on - but it is STILL THIS COLLECTION, deliberately not a new `Employee` one beside it.
//
// WHY THE NAME STAYS. A garage job card's task already stores `staffId: { ref: "Staff" }` and the hours the
// technician took (models/modules/garage/jobCardModel.js), which is one half of what labour costing needs.
// Keeping the model name and every _id means those references keep resolving, with no migration and no rewrite
// of the garage module: Al Manara's existing job cards cost their labour the day the feature arrives. Renaming
// the collection would have bought a tidier word at the price of touching live records - the same trade the
// `docno` -> "Serial no." decision refused, where the rename would have mislabelled eleven real documents.
// The UI says "Employee"; the database says Staff. See utils/hr.js for the rules that put a cost on an hour.
const staffSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  // An employee belongs to ONE branch (the owner's own answer: people are fixed to a branch, they do not move
  // between them), so a branch manager sees their own people and head office sees everyone. The limit on how
  // many employees a plan allows is organisation-wide, so it is counted across every branch - see
  // services/core/usageService.js.
  branchId: { type: String, default: "main" }, // the branch; head office is "main"
  staffId: { type: String, required: true }, // unique within an organisation: see below
  name: { type: String, required: true, trim: true },
  designation: { type: String, required: true, trim: true },
  // Free text for now. A department master belongs with the rest of HR's setup, and inventing one here - before
  // anything reports by department - would be a form that saves nothing.
  department: { type: String, trim: true, maxlength: 80 },
  // The structured department (W4, organisation): optional and separate from the free-text field above -
  // an existing employee's typed department is never silently re-pointed at a master row. When set, the
  // form keeps the two in step (the department's own name is also written into `department`), so nothing
  // that already reads the free-text field needs to change.
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Department", default: null },
  // Who this person reports to - another employee, never a sign-in account (adminId already exists for
  // that bridge, for a different reason). Optional; most organisations will leave it unset at first.
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  contactNo: {
    type: String,
    required: true,
    trim: true,
    match: /^\+?\d{10,15}$/,
  },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  // Where somebody is from, which is an ordinary part of an employee file and the one field the Emiratisation
  // quota is counted from. Stored as an ISO 3166-1 alpha-2 code so it can be counted, never matched by name.
  nationality: { type: String, trim: true, uppercase: true, maxlength: 2 },
  idNo: { type: String, required: true, trim: true }, // unique within an organisation: see below
  joiningDate: { type: Date, required: true },
  // The day they left. A leaver is kept, never deleted: the work they did still has to carry its cost, and a
  // past order's labour must not change because somebody resigned.
  exitDate: { type: Date, default: null },
  /**
   * The sign-in account this person uses, IF they have one - and most will not. An employee is never an Admin
   * row (that is what the `users` limit counts, and 200 factory workers would blow a 50-user plan while landing
   * in "Users and roles" beside the finance manager), so this is a link, not an identity.
   *
   * It exists because a process order's step records its assignee as an ACCOUNT id
   * (models/modules/processOrderModel.js `assigneeId`), from the days when only people with logins were
   * assigned work. Labour costing needs the EMPLOYEE behind that account to find their cost rate, and this is
   * the bridge - so a step assigned the old way still costs correctly, with nothing to migrate.
   */
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  idProof: { type: String }, // Cloudinary public_id
  idProofUrl: { type: String }, // Cloudinary URL
  addressProof: { type: String }, // Cloudinary public_id
  addressProofUrl: { type: String }, // Cloudinary URL
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: String, required: true },
});

// Unique within an ORGANISATION, not within a branch: an employee code and an ID number name one person in the
// whole company, and `leadIndexes` prepends companyId alone (never branchId), which is exactly that.
staffSchema.index({ staffId: 1 }, { unique: true }); // unique within an organisation
staffSchema.index({ idNo: 1 }, { unique: true }); // unique within an organisation
staffSchema.index({ adminId: 1 }); // the bridge from a process step's account id to the employee behind it
staffSchema.index({ status: 1, name: 1 }); // the directory's own listing

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
// branchScoped: an employee is a person at a branch, so a branch user sees their own.
staffSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("Staff", staffSchema);
