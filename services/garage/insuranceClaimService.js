const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
const JobCard = require("../../models/modules/garage/jobCardModel");
const Customer = require("../../models/modules/customerModel");
const Category = require("../../models/modules/categoryModel");
const Stock = require("../../models/modules/stockModel");
const rules = require("../../utils/garage");
const insRules = require("../../utils/insuranceClaims");
const JobCardService = require("./jobCardService");
const TransactionService = require("../orderPurchase/transactionService");
const NumberSeriesService = require("../core/numberSeriesService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");

// The insurance side of a job card (utils/insuranceClaims.js has the pure rules: validation, the survey and
// approval checks, and splitBill - the money). DRAFT -> SUBMITTED -> SURVEYED -> APPROVED | PARTLY_APPROVED |
// REJECTED -> INVOICED. Raising invoices bills the insurer for the approved repair (real job-card lines, so
// stock and cost move exactly as any other invoice's do) and the customer for what the insurer does not pay
// (the excess, any parts depreciation, and anything not approved) as a separate, ad hoc charge - the excess
// and depreciation are deductions, not goods, so they go through the item master's SERVICE path with no
// stock implication at all, the same reasoning utils/itemKinds.js already gives for labour.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.isValidObjectId(v);
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));

class InsuranceClaimService {
  static async #load(id, session) {
    if (!isId(id)) throw fail("That claim does not exist", 404, "CLAIM_NOT_FOUND");
    const q = InsuranceClaim.findById(id);
    const claim = await (session ? q.session(session) : q);
    if (!claim) throw fail("That claim does not exist", 404, "CLAIM_NOT_FOUND");
    return claim;
  }

  static present(doc) {
    const c = doc?.toObject ? doc.toObject() : doc;
    if (!c) return c;
    const status = c.status;
    return {
      ...c,
      actions: {
        edit: status === "DRAFT",
        delete: status === "DRAFT",
        submit: status === "DRAFT",
        recordSurvey: status === "SUBMITTED",
        recordApproval: status === "SURVEYED",
        raiseInvoices: ["APPROVED", "PARTLY_APPROVED"].includes(status) && !c.invoices?.length,
      },
    };
  }

  static async getById(id) {
    const claim = await this.#load(id);
    return this.present(claim);
  }

  static async list(query = {}) {
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.insurerId && isId(query.insurerId)) filter.insurerId = query.insurerId;
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ claimNo: rx }, { policyNo: rx }, { "insurer.name": rx }];
    }
    return InsuranceClaim.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  }

  // Open claims, bucketed by how long they have been waiting for a decision - the register's own ageing.
  static async ageing(today) {
    const claims = await InsuranceClaim.find({ status: { $in: [...insRules.LIVE_STATUS] } }).lean();
    return insRules.claimAgeing(claims, { today, dayOf: (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) });
  }

  // ---- the lazily-created charge items (the excess and parts depreciation) ------------------------------
  //
  // Resolved with NO session and called BEFORE raiseInvoices opens its own transaction - the same split
  // ProductionService.absorbedAccount() uses, for the same reason: transactionService.createTransaction's
  // own "does this item exist" check (services/orderPurchase/transactionService.js, the stock existence
  // loop) reads Stock with no session of its own, so an item created a moment earlier INSIDE a still-open
  // transaction is invisible to it - transaction isolation, not a bug in either place. Each upsert here is
  // already atomic on its own; committing it before the invoice's own transaction starts is what makes it
  // visible in time.

  static async ensureChargeItems() {
    const { companyId } = getTenant();
    const category = await Category.findOneAndUpdate(
      { name: "Insurance" },
      { $setOnInsert: { name: "Insurance", companyId, status: "Active" } },
      { upsert: true, new: true }
    );
    const make = async (itemCode, itemName) => {
      const doc = await Stock.findOneAndUpdate(
        { itemId: itemCode },
        { $setOnInsert: { itemId: itemCode, sku: itemCode, itemName, itemType: "service", category: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), status: "Active", companyId } },
        { upsert: true, new: true }
      );
      return doc._id;
    };
    return { excessItemId: await make("INS-EXCESS", "Insurance excess"), depreciationItemId: await make("INS-DEPR", "Parts depreciation") };
  }

  // ---- writing ------------------------------------------------------------------------------------------

  static create = withTransactionSession(async (data, createdBy, session) => {
    const { companyId, branchId } = getTenant();
    const vErrors = insRules.validateClaim(data);
    if (vErrors.length) throw fail(vErrors[0].message, 400, vErrors[0].code, { errors: vErrors });

    const insurer = await Customer.findById(data.insurerId).select("customerName isInsurer").session(session);
    if (!insurer) throw fail("That insurer does not exist", 404, "INSURER_NOT_FOUND");
    if (!insurer.isInsurer) throw fail(`${insurer.customerName} is not marked as an insurer`, 400, "NOT_AN_INSURER");

    const jobCard = await JobCard.findById(data.jobCardId).session(session);
    if (!jobCard) throw fail("That job card does not exist", 404, "JOB_NOT_FOUND");
    if (jobCard.claimId) throw fail("This job card already has a claim", 409, "CLAIM_ALREADY_EXISTS", { claimId: jobCard.claimId });

    const claimNo = await NumberSeriesService.numberFor("CLM", { typed: data.manualNumber, date: new Date(), session, docType: "InsuranceClaim" });
    const [claim] = await InsuranceClaim.create(
      [{
        claimNo, companyId, branchId,
        insurerId: insurer._id, insurer: { name: insurer.customerName },
        policyNo: insRules.text(data.policyNo, 60),
        policyHolder: insRules.text(data.policyHolder, 150),
        insurerClaimNo: insRules.text(data.insurerClaimNo, 60),
        jobCardId: jobCard._id, vehicleId: jobCard.vehicleId,
        accidentDate: data.accidentDate || undefined,
        reportedDate: data.reportedDate || undefined,
        policeReportNo: insRules.text(data.policeReportNo, 60),
        notes: insRules.text(data.notes, 1000),
        createdBy, updatedBy: createdBy,
      }],
      { session }
    );

    jobCard.claimId = claim._id;
    if (jobCard.jobType !== "insurance") jobCard.jobType = "insurance";
    await jobCard.save({ session });
    return claim;
  });

  static update = withTransactionSession(async (id, data, updatedBy, session) => {
    const claim = await this.#load(id, session);
    if (claim.status !== "DRAFT") throw fail("Only a draft claim can be edited; it has already been submitted", 409, "CLAIM_NOT_DRAFT");
    const vErrors = insRules.validateClaim({ insurerId: claim.insurerId, jobCardId: claim.jobCardId, policyNo: data.policyNo });
    if (vErrors.some((e) => e.field === "policyNo")) throw fail(vErrors[0].message, 400, vErrors[0].code);
    claim.policyNo = insRules.text(data.policyNo, 60);
    claim.policyHolder = insRules.text(data.policyHolder, 150);
    claim.insurerClaimNo = insRules.text(data.insurerClaimNo, 60);
    claim.accidentDate = data.accidentDate || claim.accidentDate;
    claim.reportedDate = data.reportedDate || claim.reportedDate;
    claim.policeReportNo = insRules.text(data.policeReportNo, 60);
    claim.notes = insRules.text(data.notes, 1000);
    claim.updatedBy = updatedBy;
    await claim.save({ session });
    return claim;
  });

  static remove = withTransactionSession(async (id, removedBy, session) => {
    const claim = await this.#load(id, session);
    if (claim.status !== "DRAFT") throw fail("Only a draft claim can be deleted", 409, "CLAIM_NOT_DRAFT");
    await JobCard.updateOne({ _id: claim.jobCardId }, { $unset: { claimId: 1 } }, { session });
    await claim.deleteOne({ session });
    return claim;
  });

  static submit = withTransactionSession(async (id, submittedBy, session) => {
    const claim = await this.#load(id, session);
    if (claim.status !== "DRAFT") throw fail(`This claim is ${String(claim.status).toLowerCase()}, not a draft`, 409, "CLAIM_NOT_DRAFT");
    claim.status = "SUBMITTED";
    claim.submittedAt = new Date();
    await claim.save({ session });
    return claim;
  });

  static recordSurvey = withTransactionSession(async (id, data, by, session) => {
    const claim = await this.#load(id, session);
    if (claim.status !== "SUBMITTED") throw fail(`This claim is ${String(claim.status).toLowerCase()}, not waiting for a survey`, 409, "CLAIM_NOT_SUBMITTED");
    const err = insRules.checkSurvey(data);
    if (err) throw fail(err.message, 400, err.code);
    claim.survey = {
      surveyorName: insRules.text(data.surveyorName, 150),
      company: insRules.text(data.company, 150),
      visitedAt: data.visitedAt || new Date(),
      notes: insRules.text(data.notes, 1000),
      photos: Array.isArray(data.photos) ? data.photos : [],
    };
    claim.status = "SURVEYED";
    await claim.save({ session });
    return claim;
  });

  // The insurer's decision: approved (whole or in part), or rejected. `deductions` is only meaningful on an
  // approval - a rejection leaves the job to be invoiced to the customer in full, through the job card's own
  // ordinary createInvoice, outside this claim.
  static recordApproval = withTransactionSession(async (id, data, by, session) => {
    const claim = await this.#load(id, session);
    if (claim.status !== "SURVEYED") throw fail(`This claim is ${String(claim.status).toLowerCase()}, not waiting for the insurer's decision`, 409, "CLAIM_NOT_SURVEYED");
    const err = insRules.checkApproval(data);
    if (err) throw fail(err.message, 400, err.code, { field: err.field });

    if (data.status === "REJECTED") {
      claim.status = "REJECTED";
      claim.rejectedAt = new Date();
      claim.rejectReason = insRules.text(data.reason, 300);
      await claim.save({ session });
      return claim;
    }

    claim.approval = {
      lpoNo: insRules.text(data.lpoNo, 60),
      approvedAt: new Date(),
      approvedAmount: insRules.num(data.approvedAmount) || 0,
      note: insRules.text(data.note, 300),
    };
    claim.deductions = {
      excess: insRules.num(data.deductions?.excess) || 0,
      partsDepreciationPct: insRules.num(data.deductions?.partsDepreciationPct) || 0,
      depreciablePartsAmount: insRules.num(data.deductions?.depreciablePartsAmount) || 0,
    };
    claim.status = data.status; // APPROVED | PARTLY_APPROVED
    await claim.save({ session });
    return claim;
  });

  // Two invoices from one decision: the insurer's, for the approved repair (real job-card lines - parts move
  // stock, labour does not, exactly as any other invoice), and the customer's, for the excess and any
  // depreciation, as a plain ad hoc charge with no stock implication. The customer invoice is skipped
  // entirely when nothing is owed by them (a fully approved claim with no excess set).
  //
  // The public entry point is NOT itself wrapped in a transaction: it resolves the charge items first (see
  // ensureChargeItems above for why), then hands them to the transactional half.
  static async raiseInvoices(id, createdBy) {
    const { excessItemId, depreciationItemId } = await this.ensureChargeItems();
    return this.#raiseInvoicesIn(id, createdBy, { excessItemId, depreciationItemId });
  }

  static #raiseInvoicesIn = withTransactionSession(async (id, createdBy, { excessItemId, depreciationItemId }, session) => {
    const claim = await this.#load(id, session);
    // Checked before the generic status guard: once invoiced, status moves PAST approved, so without this
    // a second attempt would read "not approved" - true, but not the actual reason, and not what a person
    // who just successfully raised the invoices themselves needs to be told.
    if (claim.status === "INVOICED" || claim.invoices?.length) throw fail("Invoices were already raised for this claim", 409, "ALREADY_INVOICED");
    if (!["APPROVED", "PARTLY_APPROVED"].includes(claim.status)) {
      throw fail(`This claim is ${String(claim.status).toLowerCase()}, so there is nothing approved to invoice`, 409, "CLAIM_NOT_APPROVED");
    }

    const jobCard = await JobCard.findById(claim.jobCardId).session(session);
    if (!jobCard) throw fail("The job card this claim is for no longer exists", 404, "JOB_NOT_FOUND");
    // billableLines, not approvedLines: an approved line already billed on some earlier invoice (the job
    // card's own ordinary one) must not be handed to the insurer a second time.
    const toBill = rules.billableLines(jobCard.toObject());
    if (!toBill.length) throw fail("The job card has nothing approved to bill", 409, "NOTHING_TO_INVOICE");

    const jobTotal = rules.jobTotals(jobCard.toObject()).total;
    const split = insRules.splitBill(jobTotal, {
      approvedAmount: claim.approval.approvedAmount,
      excess: claim.deductions.excess,
      depreciationPct: claim.deductions.partsDepreciationPct,
      depreciablePartsAmount: claim.deductions.depreciablePartsAmount,
    });

    const insurerResult = await JobCardService.createInvoice(
      { jobCardId: jobCard._id, billTo: "insurer", partyId: claim.insurerId, lineIds: toBill.map((l) => idOf(l._id)) },
      createdBy,
      session
    );
    const invoices = [{ transactionId: insurerResult.invoice._id, no: insurerResult.invoice.transactionNo, billTo: "insurer", amount: insurerResult.invoice.totalAmount, status: insurerResult.invoice.status }];

    if (split.customerAmount > 0) {
      const items = [];
      if (claim.deductions.excess > 0) items.push({ itemId: excessItemId, description: "Insurance excess", qty: 1, price: claim.deductions.excess });
      if (split.depreciationAmount > 0) items.push({ itemId: depreciationItemId, description: "Parts depreciation", qty: 1, price: split.depreciationAmount });
      if (split.notApproved > 0) items.push({ itemId: excessItemId, description: "Not approved by the insurer", qty: 1, price: split.notApproved });

      const customerInvoice = await TransactionService.createTransaction(
        { type: "sales_order", partyId: jobCard.customerId, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), items, notes: `Insurance claim ${claim.claimNo} - excess and depreciation`, status: "DRAFT" },
        createdBy,
        session
      );
      invoices.push({ transactionId: customerInvoice._id, no: customerInvoice.transactionNo, billTo: "customer", amount: customerInvoice.totalAmount, status: customerInvoice.status });
      jobCard.invoices.push({ transactionId: customerInvoice._id, no: customerInvoice.transactionNo, billTo: "customer", amount: customerInvoice.totalAmount, status: customerInvoice.status });
      jobCard.invoiceStatus = "DRAFT";
      await jobCard.save({ session });
    }

    claim.invoices = invoices;
    claim.split = { insurerAmount: split.insurerAmount, customerAmount: split.customerAmount };
    claim.status = "INVOICED";
    await claim.save({ session });
    return claim;
  });
}

module.exports = InsuranceClaimService;
