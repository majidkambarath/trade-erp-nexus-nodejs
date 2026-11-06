const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * What an employee is paid, and therefore what an hour of their work costs, FROM A GIVEN DAY.
 *
 * THIS IS A HISTORY, NEVER OVERWRITTEN. A pay rise is a new row with its own `effectiveFrom`, and the old row
 * is closed, not edited. Everything about labour costing rests on that:
 *
 *   - A posted order keeps the cost it was really built at. The rate is stamped on the cost line when the work
 *     is costed (utils/hr.js, rule 2), and the row it came from is still there to explain it. A March rise
 *     cannot reach into February's product cost - and product cost in a closed period must not move.
 *   - "The salary disagrees with the registered contract" becomes a checkable thing when payroll arrives: a
 *     WPS file has to match the contract lodged with the ministry, and you cannot check that against a figure
 *     somebody typed over.
 *   - An increment is an auditable event rather than a silent edit.
 *
 * WHY THE MONEY IS `select: false`. These are the most sensitive figures in the product, and the codebase's own
 * habit for such things (Admin.twoFactor.secretEnc, Voucher.heldCheque) is to keep them out of every read that
 * does not ask: a `.lean()` skips a schema's toJSON, so a projection is the only thing that actually holds, and
 * a new endpoint that forgets to ask leaks nothing. A reader must opt in with .select("+basicPay ...") AND hold
 * `hr.confidential`.
 *
 * The cost of that choice is understood: a caller who forgets gets no figures, so utils/hr.js reads a null rate
 * and says "this person cannot be costed" - which the costing service turns into a warning somebody sees,
 * never a silent zero. Fail closed on the wage, loud on the costing.
 */
const employeeContractSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the employee's branch; head office is "main"
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },

    // Calendar days as "YYYY-MM-DD", the convention the whole product travels dates on when the DAY is what
    // matters (utils/documentExpiry.js, FiscalYear.lockedThrough): comparing two of them is comparing the
    // dates, with no instant, no zone and no UTC-midnight trap. `effectiveTo` empty means "still current".
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },

    // The pay itself. Basic is kept apart from allowances because statutory figures are built on basic alone
    // (UAE end-of-service is 21 days of BASIC a year; India's gratuity and PF read basic too), so a package
    // lumped into one number cannot answer the questions wave 2 asks of it.
    basicPay: { type: Number, min: 0, default: null, select: false },
    allowances: { type: Number, min: 0, default: null, select: false },
    // What the employer carries beyond the payslip - medical insurance, the visa spread over its term, the
    // end-of-service accruing every month. Costing an hour at bare basic pay understates every product that
    // hour went into, which is the "job cost built on the wrong labour rate" mistake the trade writes about.
    otherMonthlyCost: { type: Number, min: 0, default: null, select: false },
    // Stated outright when somebody simply knows it ("he costs me 25 an hour"), which is also how a daily-wage
    // or hourly worker is recorded. It WINS over the figure derived from the package: somebody chose it.
    costPerHour: { type: Number, min: 0, default: null, select: false },
    // The divisor for turning a monthly package into an hourly cost. Empty uses the usual 8 x 26.
    hoursPerMonth: { type: Number, min: 1, max: 744, default: null, select: false },

    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// One contract per employee per start day: a second row for the same day is a double entry, not a history, and
// would make "which rate was in force" ambiguous on exactly the day somebody needs an answer.
employeeContractSchema.index({ staffId: 1, effectiveFrom: 1 }, { unique: true });
// Reading a person's history, newest first, is the commonest query there is here.
employeeContractSchema.index({ staffId: 1, effectiveFrom: -1 });

employeeContractSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("EmployeeContract", employeeContractSchema);
