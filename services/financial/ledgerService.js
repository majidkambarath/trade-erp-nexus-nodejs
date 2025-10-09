const mongoose = require("mongoose");
const LedgerEntry = require("../../models/modules/financial/financialModels").LedgerEntry;
const AppError = require("../../utils/AppError");

class LedgerService {
  // Get all ledger entries with filters and pagination
  static async getAllLedgerEntries(filters = {}) {
    const {
      voucherType,
      accountId,
      partyId,
      partyType,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 20,
      sortBy = "date",
      sortOrder = "desc",
    } = filters;

    // Build query object
    const query = {};

    // Filter by voucherType
    if (voucherType) {
      query.voucherType = voucherType;
    }

    // Filter by accountId
    if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
      query.accountId = accountId;
    }

    // Filter by partyId and partyType
    if (partyId && mongoose.Types.ObjectId.isValid(partyId) && partyType) {
      query.partyId = partyId;
      query.partyType = partyType;
    }

    // Date range filter
    if (dateFrom || dateTo) {
      query.date = {};
      if (dateFrom) {
        const fromDate = new Date(dateFrom);
        if (!isNaN(fromDate)) query.date.$gte = fromDate;
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        if (!isNaN(toDate)) query.date.$lte = toDate;
      }
    }

    // Search by voucherNo, accountName, or narration
    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { voucherNo: regex },
        { accountName: regex },
        { narration: regex },
      ];
    }

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Sorting
    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    try {
      // Query ledger entries with lean() for performance
      const ledgerEntries = await LedgerEntry.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .populate("accountId", "accountName accountCode accountType")
        .populate("voucherId", "voucherNo voucherType totalAmount narration")
        .populate("partyId", "customerName vendorName name")
        .lean();

      // Get total count for pagination
      const total = await LedgerEntry.countDocuments(query);

      // Format response
      const formattedEntries = ledgerEntries.map((entry) => ({
        _id: entry._id,
        voucherId: entry.voucherId?._id,
        voucherNo: entry.voucherNo,
        voucherType: entry.voucherType,
        accountId: entry.accountId?._id,
        accountName: entry.accountName,
        accountCode: entry.accountCode,
        accountType: entry.accountId?.accountType,
        date: entry.date,
        debitAmount: entry.debitAmount,
        creditAmount: entry.creditAmount,
        narration: entry.narration,
        partyId: entry.partyId?._id,
        partyName: entry.partyId?.customerName || entry.partyId?.vendorName || entry.partyId?.name,
        partyType: entry.partyType,
        financialYear: entry.financialYear,
        month: entry.month,
        year: entry.year,
        runningBalance: entry.runningBalance,
        createdBy: entry.createdBy,
        createdAt: entry.createdAt,
        isReversed: entry.isReversed,
        reversedAt: entry.reversedAt,
      }));

      return {
        ledgerEntries: formattedEntries,
        pagination: {
          current: pageNum,
          pages: Math.ceil(total / limitNum),
          total,
          limit: limitNum,
        },
      };
    } catch (error) {
      throw new AppError(`Failed to fetch ledger entries: ${error.message}`, 500);
    }
  }
}

module.exports = LedgerService;