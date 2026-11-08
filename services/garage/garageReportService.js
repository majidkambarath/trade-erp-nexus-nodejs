// The garage's reports: one static method per report, each doing its own bounded query and handing plain
// data to the pure rules (utils/garageReports.js). There is no such file before this - the module's whole
// reporting surface used to be two methods hanging off JobCardService (analysis, and InsuranceClaimService's
// ageing), and neither reads what the car is worth AFTER it leaves the workshop, which is the gap this file
// closes: revenue reconciled against invoices, not just the estimate.
const AppError = require("../../utils/AppError");
const JobCard = require("../../models/modules/garage/jobCardModel");
const Vehicle = require("../../models/modules/garage/vehicleModel");
const InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
const Bay = require("../../models/modules/garage/bayModel");
const Customer = require("../../models/modules/customerModel");
const Stock = require("../../models/modules/stockModel");
const Transaction = require("../../models/modules/transactionModel");
const JobCardService = require("./jobCardService");
const LabourCostService = require("../hr/labourCostService");
const rules = require("../../utils/garage");
const insRules = require("../../utils/insuranceClaims");
const R = require("../../utils/garageReports");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const { addMonths } = require("../../utils/yearEnd");

const fail = (message, status, code) => new AppError(message, status, code);
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));
const dayOf = (v) => toExpiryDay(v);
const REGISTER_LIMIT = 500;

function parsePeriod({ from, to } = {}) {
  const fromDay = from ? toExpiryDay(from) : null;
  const toDay = to ? toExpiryDay(to) : null;
  if (from && !fromDay) throw fail("The start date is not a date", 400, "INVALID_DATE");
  if (to && !toDay) throw fail("The end date is not a date", 400, "INVALID_DATE");
  return { fromDay, toDay };
}

// The real amount still owed on a set of job cards' APPROVED invoices - never the invoice's gross total
// (that is already on card.invoices[].amount, kept current by jobCardLinks.js with no query at all), and
// never a draft invoice's figure (nothing is posted yet, so nothing is "owed"). One _id-indexed read, no
// matter how many cards: the invoice ids are collected first, Transaction is read once by id.
async function outstandingByCard(cards) {
  const ids = [];
  const owner = new Map(); // transactionId -> cardId (a card can carry more than one invoice - a split bill)
  for (const c of cards) {
    for (const inv of c.invoices || []) {
      if (inv.status === "APPROVED" && inv.transactionId) {
        ids.push(inv.transactionId);
        owner.set(idOf(inv.transactionId), idOf(c._id));
      }
    }
  }
  if (!ids.length) return new Map();
  const txns = await Transaction.find({ _id: { $in: ids } }).select("outstandingAmount").lean();
  const byCard = new Map();
  for (const t of txns) {
    const cardId = owner.get(idOf(t._id));
    if (!cardId) continue;
    byCard.set(cardId, (byCard.get(cardId) || 0) + (Number(t.outstandingAmount) || 0));
  }
  return byCard;
}

class GarageReportService {
  // ---- Overview: what analysis() already answers, PLUS invoiced-vs-estimated and a previous-period trend.
  static async overview({ from, to } = {}) {
    const { fromDay, toDay } = parsePeriod({ from, to });
    const current = await JobCardService.analysis({ from: fromDay, to: toDay });
    const previousWindow = fromDay && toDay ? R.previousPeriod(fromDay, toDay) : null;
    const previous = previousWindow ? await JobCardService.analysis(previousWindow) : null;

    // Invoiced vs estimated: read straight off card.invoices[] - no extra query, because jobCardLinks.js
    // already keeps amount/status current with the real Transaction on every approval, rejection or delete.
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { "delivery.gatePassAt": match } : {};
    const delivered = await JobCard.find(filter).select("invoices").limit(3001).lean();
    const invoicedTotal = delivered.reduce((t, c) => t + (c.invoices || []).filter((i) => i.status === "APPROVED").reduce((s, i) => s + (Number(i.amount) || 0), 0), 0);

    return {
      ...current,
      invoiced: { total: Math.round((invoicedTotal + Number.EPSILON) * 100) / 100, gapFromEstimate: Math.round((current.jobs.revenue.total - invoicedTotal + Number.EPSILON) * 100) / 100 },
      previous: previous ? { period: previous.period, jobs: previous.jobs } : null,
      trend: previous ? {
        revenue: R.trend(current.jobs.revenue.total, previous.jobs.revenue.total),
        delivered: R.trend(current.jobs.delivered, previous.jobs.delivered),
        efficiencyPct: R.trend(current.jobs.efficiencyPct, previous.jobs.efficiencyPct),
      } : null,
    };
  }

  // ---- Work in progress: as at today, no period - what is on the floor right now.
  static async workInProgress() {
    const today = todayInOrg();
    const cards = await JobCard.find({ status: { $in: [...rules.LIVE_STATUS] } })
      .select("jobNo status jobType vehicle customer receivedAt lines tasks invoiceStatus invoices")
      .limit(2000).lean();
    const owedByCard = await outstandingByCard(cards);
    return R.workInProgress(cards, { today, dayOf, owedByCard });
  }

  // ---- Profit: revenue against cost, per stream, over the period's delivered jobs.
  static async profit({ from, to } = {}) {
    const { fromDay, toDay } = parsePeriod({ from, to });
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { "delivery.gatePassAt": match } : {};
    const cards = await JobCard.find(filter).select("lines tasks closedAt deliveredAt createdAt").sort({ "delivery.gatePassAt": -1 }).limit(2001).lean();
    const capped = cards.length > 2000;
    if (capped) cards.length = 2000;

    const itemIds = [...new Set(cards.flatMap((c) => rules.approvedLines(c).filter((l) => l.kind === "part" || l.kind === "consumable").map((l) => idOf(l.itemId))))];
    const stock = itemIds.length ? await Stock.find({ _id: { $in: itemIds } }).select("purchasePrice").lean() : [];
    const costOf = new Map(stock.map((s) => [idOf(s._id), Number(s.purchasePrice) || 0]));

    const lc = await LabourCostService.forJobCards(cards);
    const result = R.profit(cards, { costOf, labour: { total: lc.total.amount, uncostedHours: lc.uncostedHours } });
    return { period: { from: fromDay || null, to: toDay || null }, ...result, capped };
  }

  // ---- People & bays: hours sold against hours taken, by technician and by bay, over the period.
  static async peopleAndBays({ from, to } = {}) {
    const { fromDay, toDay } = parsePeriod({ from, to });
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { "tasks.doneAt": match } : {};
    const cards = await JobCard.find(filter).select("tasks").limit(2000).lean();
    const bayIds = [...new Set(cards.flatMap((c) => (c.tasks || []).map((t) => idOf(t.bayId)).filter(Boolean)))];
    const bays = bayIds.length ? await Bay.find({ _id: { $in: bayIds } }).select("kind").lean() : [];
    const bayKindOf = new Map(bays.map((b) => [idOf(b._id), b.kind || null]));
    return R.peopleAndBays(cards, { from: fromDay, to: toDay, dayOf, bayKindOf });
  }

  // ---- Customers: spend, repeat visits, average repair order - from jobs delivered in the period.
  static async customers({ from, to } = {}) {
    const { fromDay, toDay } = parsePeriod({ from, to });
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { "delivery.gatePassAt": match } : {};
    const cards = await JobCard.find(filter).select("customerId customer lines invoices delivery").sort({ "delivery.gatePassAt": -1 }).limit(REGISTER_LIMIT + 1).lean();
    const capped = cards.length > REGISTER_LIMIT;
    if (capped) cards.length = REGISTER_LIMIT;
    const result = R.customerSummary(cards);
    return { period: { from: fromDay || null, to: toDay || null }, ...result, capped };
  }

  // ---- Vehicles: as at today - the fleet, what is due or expiring, which cars come back the most.
  static async vehicles() {
    const today = todayInOrg();
    const vehicles = await Vehicle.find({})
      .select("plateNumber make model customerName registrationExpiry insurerId policyExpiry serviceInterval lastServiceDay lastServiceOdometer odometer status")
      .limit(5000).lean();
    const insurerIds = [...new Set(vehicles.map((v) => idOf(v.insurerId)).filter(Boolean))];
    const insurers = insurerIds.length ? await Customer.find({ _id: { $in: insurerIds } }).select("customerName").lean() : [];
    const insurerNameOf = new Map(insurers.map((c) => [idOf(c._id), c.customerName || ""]));
    // How many times, and for what, each vehicle has been delivered - one bounded aggregate for the whole
    // fleet, never one query per vehicle (which is what "lifetime spend per car" would otherwise cost).
    const visitRows = await JobCard.aggregate([
      { $match: { status: { $in: ["DELIVERED", "CLOSED"] } } },
      { $group: { _id: "$vehicleId", jobs: { $sum: 1 }, lastVisit: { $max: "$delivery.gatePassAt" }, lines: { $push: "$lines" } } },
      { $limit: 5000 },
    ]);
    const visits = new Map(visitRows.map((r) => {
      const lines = (r.lines || []).flat().filter((l) => l && l.approved !== false);
      const value = lines.reduce((t, l) => {
        const gross = (Number(l.qty) || 0) * (Number(l.price) || 0);
        const pct = Number(l.discountPercent) || 0;
        const off = pct > 0 ? (gross * pct) / 100 : Number(l.discountAmount) || 0;
        return t + Math.max(0, gross - off);
      }, 0);
      return [idOf(r._id), { jobs: r.jobs, value: Math.round((value + Number.EPSILON) * 100) / 100, lastVisit: r.lastVisit ? R.isoDay(r.lastVisit) : null }];
    }));
    return R.vehicleReport(vehicles, { today, visits, insurerNameOf, addMonths, dueWindowDays: 30 });
  }

  // ---- Insurers: every claim of the period (DECIDED included), unlike ageing which leaves rejected ones out.
  static async insurers({ from, to } = {}) {
    const { fromDay, toDay } = parsePeriod({ from, to });
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { createdAt: match } : {};
    const claims = await InsuranceClaim.find(filter).limit(REGISTER_LIMIT + 1).lean();
    const capped = claims.length > REGISTER_LIMIT;
    if (capped) claims.length = REGISTER_LIMIT;

    const jobIds = [...new Set(claims.map((c) => idOf(c.jobCardId)).filter(Boolean))];
    const jobs = jobIds.length ? await JobCard.find({ _id: { $in: jobIds } }).select("jobNo estimate.total").lean() : [];
    const jobByClaim = new Map(jobs.map((j) => [idOf(j._id), j]));

    const txnIds = [];
    const owner = new Map();
    for (const c of claims) {
      for (const inv of c.invoices || []) {
        if (inv.billTo === "insurer" && inv.status === "APPROVED" && inv.transactionId) {
          txnIds.push(inv.transactionId);
          owner.set(idOf(inv.transactionId), idOf(c._id));
        }
      }
    }
    const txns = txnIds.length ? await Transaction.find({ _id: { $in: txnIds } }).select("outstandingAmount").lean() : [];
    const owedByClaim = new Map();
    for (const t of txns) {
      const claimId = owner.get(idOf(t._id));
      if (!claimId) continue;
      owedByClaim.set(claimId, (owedByClaim.get(claimId) || 0) + (Number(t.outstandingAmount) || 0));
    }

    const result = R.insurerSummary(claims, { jobByClaim, owedByClaim, splitBill: insRules.splitBill });
    return { period: { from: fromDay || null, to: toDay || null }, ...result, capped };
  }
}

module.exports = GarageReportService;
