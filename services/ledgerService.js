// services/ledgerService.js

const Vendor = require("../models/modules/vendorModel");
const Customer = require("../models/modules/customerModel");
const DebitLog = require("../models/modules/DebitLog");
const CreditLog = require("../models/modules/CreditLog");
const AppError = require("../utils/AppError");

class LedgerService {
  // 1. All Parties (Combined) - Optional
  static async getAllParties() {
    const [vendors, customers] = await Promise.all([
      this.getDebitAccounts(),
      this.getCreditAccounts(),
    ]);
    return [...vendors, ...customers].sort((a, b) => a.name.localeCompare(b.name));
  }

  // 2. DEBIT ACCOUNTS → Only Vendors (Accounts Payable)
  static async getDebitAccounts() {
    const vendors = await Vendor.find({})
      .select("vendorId vendorName cashBalance")
      .lean();

    if (vendors.length === 0) return [];

    const vendorIds = vendors.map(v => v._id);

    const stats = await DebitLog.aggregate([
      { $match: { vendorId: { $in: vendorIds } }},
      {
        $group: {
          _id: "$vendorId",
          totalInvoices: {
            $sum: {
              $cond: [{ $in: ["$type", ["purchase_order", "purchase_return"]] }, 1, 0]
            }
          },
          totalInvoiced: {
            $sum: {
              $switch: {
                branches: [
                  { case: { $eq: ["$type", "purchase_order"] }, then: "$amount" },
                  { case: { $eq: ["$type", "purchase_return"] }, then: { $multiply: ["$amount", -1] } },
                ],
                default: 0
              }
            }
          },
          totalPaid: {
            $sum: { $cond: [{ $eq: ["$type", "payment_received"] }, "$paid", 0] }
          },
        },
      },
    ]);

    const statMap = Object.fromEntries(stats.map(s => [s._id.toString(), s]));

    return vendors.map(v => {
      const s = statMap[v._id.toString()] || { totalInvoices: 0, totalInvoiced: 0, totalPaid: 0 };
      const totalPayable = Math.max(0, s.totalInvoiced - s.totalPaid);

      return {
        _id: v._id,
        partyId: v.vendorId,
        name: v.vendorName,
        type: "Vendor",
        totalInvoices: s.totalInvoices,
        totalInvoiced: s.totalInvoiced,
        totalPaid: s.totalPaid,
        totalPayable: totalPayable,
        balance: v.cashBalance || 0,
      };
    });
  }

  // 3. CREDIT ACCOUNTS → Only Customers (Accounts Receivable)
  static async getCreditAccounts() {
    const customers = await Customer.find({})
      .select("customerId customerName cashBalance")
      .lean();

    if (customers.length === 0) return [];

    const customerIds = customers.map(c => c._id);

    const stats = await CreditLog.aggregate([
      { $match: { customerId: { $in: customerIds } } },
      {
        $group: {
          _id: "$customerId",
          totalInvoices: {
            $sum: {
              $cond: [{ $in: ["$type", ["sales_order", "sales_return"]] }, 1, 0]
            }
          },
          totalInvoiced: {
            $sum: {
              $switch: {
                branches: [
                  { case: { $eq: ["$type", "sales_order"] }, then: "$amount" },
                  { case: { $eq: ["$type", "sales_return"] }, then: { $multiply: ["$amount", -1] } },
                ],
                default: 0
              }
            }
          },
          totalPaid: {
            $sum: { $cond: [{ $eq: ["$type", "payment_made"] }, "$paid", 0] }
          },
        },
      },
    ]);

    const statMap = Object.fromEntries(stats.map(s => [s._id.toString(), s]));

    return customers.map(c => {
      const s = statMap[c._id.toString()] || { totalInvoices: 0, totalInvoiced: 0, totalPaid: 0 };
      const totalReceivable = Math.max(0, s.totalInvoiced - s.totalPaid);

      return {
        _id: c._id,
        partyId: c.customerId,
        name: c.customerName,
        type: "Customer",
        totalInvoices: s.totalInvoices,
        totalInvoiced: s.totalInvoiced,
        totalPaid: s.totalPaid,
        totalReceivable,
        balance: c.cashBalance || 0,
      };
    });
  }

static async getPartyLedger(partyType, partyId, filters = {}) {
  const LogModel = partyType === "Vendor" ? DebitLog : CreditLog;
  const field = partyType === "Vendor" ? "vendorId" : "customerId";

  // Build query
  const query = { [field]: partyId };

  // Apply filters
  if (filters.from || filters.to) {
    query.date = {};
    if (filters.from) {
      query.date.$gte = new Date(filters.from);
    }
    if (filters.to) {
      const toDate = new Date(filters.to);
      toDate.setHours(23, 59, 59, 999);
      query.date.$lte = toDate;
    }
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status.toUpperCase();
  }

  if (filters.type && filters.type !== "all") {
    const typeMap = {
      "purchase_order": "purchase_order",
      "purchase_return": "purchase_return",
      "payment_received": "payment_received",
      "sales_order": "sales_order",
      "sales_return": "sales_return",
      "payment_made": "payment_made",
    };
    query.type = typeMap[filters.type] || filters.type;
  }

  const logs = await LogModel.find(query)
    .sort({ date: 1, createdAt: 1 })
    .lean();

  let runningBalance = 0;
  const ledger = logs.map(log => {
    const previousBalance = runningBalance;
    runningBalance = log.balance;

    const isPayment = log.type.includes("payment");
    const drCr = log.amount > 0 ? "Dr" : "Cr";

    return {
      date: log.date,
      invNo: log.invNo,
      type: log.type.replace(/_/g, " ").toUpperCase(),
      amount: Math.abs(log.amount),
      paid: log.paid,
      balance: log.balance,
      previousBalance,
      allocatedAmount: isPayment ? log.paid : 0,
      drCr,
      ref: log.ref || "-",
      status: log.status,
    };
  });

  const PartyModel = partyType === "Vendor" ? Vendor : Customer;
  const party = await PartyModel.findById(partyId)
    .select(partyType === "Vendor" ? "vendorName vendorId" : "customerName customerId")
    .lean();
  // The tenant plugin already scopes this query to the organisation in scope, so a missing party
  // means either no such id or one that belongs to someone else - answered the same way, like every
  // other by-id read (see CLAUDE.md "another organisation's document ... answers 404").
  if (!party) throw new AppError(`${partyType} not found`, 404);

  return {
    party: {
      name: partyType === "Vendor" ? party.vendorName : party.customerName,
      partyId: partyType === "Vendor" ? party.vendorId : party.customerId,
      currentBalance: runningBalance,
    },
    ledger,
    summary: {
      totalEntries: ledger.length,
      closingBalance: runningBalance,
    },
  };
}
}

module.exports = LedgerService;