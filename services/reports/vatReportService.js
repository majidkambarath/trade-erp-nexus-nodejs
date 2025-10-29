const mongoose = require("mongoose");
const VATReport = require("../../models/modules/financial/VATReport");
const AppError = require("../../utils/AppError");

class VATReportService {
  // ──────────────────────────────────────────────────────────────
  // 1. Get all VAT reports (paginated + filters)
  // ──────────────────────────────────────────────────────────────
  static async getAllReports(filters = {}) {
    const {
      page = 1,
      limit = 20,
      status,
      generatedBy,
      periodStart,
      periodEnd,
      sort = "-generatedAt",
    } = filters;

    const query = {};
    if (status) query.status = status;
    if (generatedBy) query.generatedBy = new RegExp(generatedBy, "i");
    if (periodStart || periodEnd) {
      query.periodStart = {};
      if (periodStart) query.periodStart.$gte = new Date(periodStart);
      if (periodEnd) query.periodStart.$lte = new Date(periodEnd);
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const sortObj = {};
    sort.split(",").forEach((p) => {
      const [field, order] = p.split(":");
      sortObj[field.replace(/^-/, "")] = order === "desc" ? -1 : 1;
    });

    const pipeline = [
      { $match: query },

      // Lookup stock details for items
      {
        $lookup: {
          from: "stocks",
          localField: "items.itemId",
          foreignField: "_id",
          as: "stockLookup",
        },
      },

      // Attach stock data to each item
      {
        $addFields: {
          items: {
            $map: {
              input: "$items",
              as: "it",
              in: {
                $mergeObjects: [
                  "$$it",
                  {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: "$stockLookup",
                          as: "st",
                          cond: { $eq: ["$$st._id", "$$it.itemId"] },
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        },
      },

      // Lookup party (Customer / Vendor)
      {
        $lookup: { from: "customers", localField: "items.partyId", foreignField: "_id", as: "customerLookup" },
      },
      {
        $lookup: { from: "vendors", localField: "items.partyId", foreignField: "_id", as: "vendorLookup" },
      },

      // Enrich each item with party name
      {
        $addFields: {
          items: {
            $map: {
              input: "$items",
              as: "it",
              in: {
                $mergeObjects: [
                  "$$it",
                  {
                    partyName: {
                      $cond: {
                        if: { $eq: ["$$it.partyType", "Customer"] },
                        then: {
                          $getField: {
                            field: "customerName",
                            input: {
                              $arrayElemAt: [
                                {
                                  $filter: {
                                    input: "$customerLookup",
                                    as: "c",
                                    cond: { $eq: ["$$c._id", "$$it.partyId"] },
                                  },
                                },
                                0,
                              ],
                            },
                          },
                        },
                        else: {
                          $getField: {
                            field: "vendorName",
                            input: {
                              $arrayElemAt: [
                                {
                                  $filter: {
                                    input: "$vendorLookup",
                                    as: "v",
                                    cond: { $eq: ["$$v._id", "$$it.partyId"] },
                                  },
                                },
                                0,
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },

      { $unset: ["stockLookup", "customerLookup", "vendorLookup"] },

      { $sort: sortObj },
      { $skip: skip },
      { $limit: limitNum },
    ];

    const [reports, total] = await Promise.all([
      VATReport.aggregate(pipeline),
      VATReport.countDocuments(query),
    ]);

    return {
      reports,
      pagination: {
        current: pageNum,
        pages: Math.ceil(total / limitNum),
        total,
        limit: limitNum,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────
  // 2. Get single report
  // ──────────────────────────────────────────────────────────────
  static async getReportById(id) {
    if (!mongoose.Types.ObjectId.isValid(id))
      throw new AppError("Invalid report ID", 400);

    const report = await VATReport.findById(id);
    if (!report) throw new AppError("VAT report not found", 404);

    const enriched = await VATReport.aggregate([
      { $match: { _id: report._id } },
      // Re-use same pipeline stages as above (skip pagination)
      ...pipeline.slice(0, -3), // exclude sort/skip/limit
    ]);

    return enriched[0] || report.toObject();
  }

  // ──────────────────────────────────────────────────────────────
  // 3. Finalize DRAFT → FINALIZED
  // ──────────────────────────────────────────────────────────────
  static async finalizeReport(id, finalizedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const report = await VATReport.findById(id).session(session);
      if (!report) throw new AppError("Report not found", 404);
      if (report.status !== "DRAFT")
        throw new AppError(`Cannot finalize a ${report.status} report`, 400);

      report.status = "FINALIZED";
      report.generatedAt = new Date();
      report.generatedBy = finalizedBy;

      const output = report.items
        .filter((i) => ["sales_order", "purchase_return"].includes(i.transactionType))
        .reduce((s, i) => s + i.vatAmount, 0);
      const input = report.items
        .filter((i) => ["purchase_order", "sales_return"].includes(i.transactionType))
        .reduce((s, i) => s + i.vatAmount, 0);

      report.totalVATOutput = +output.toFixed(2);
      report.totalVATInput = +input.toFixed(2);
      report.netVATPayable = +(output - input).toFixed(2);

      await report.save({ session });
      await session.commitTransaction();
      return report;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 4. Submit FINALIZED → SUBMITTED
  // ──────────────────────────────────────────────────────────────
  static async submitReport(id, submittedBy) {
    const report = await VATReport.findById(id);
    if (!report) throw new AppError("Report not found", 404);
    if (report.status !== "FINALIZED")
      throw new AppError("Only FINALIZED reports can be submitted", 400);

    report.status = "SUBMITTED";
    report.submittedAt = new Date();
    report.submittedBy = submittedBy;
    await report.save();
    return report;
  }

  // ──────────────────────────────────────────────────────────────
  // 5. Delete DRAFT report
  // ──────────────────────────────────────────────────────────────
  static async deleteDraftReport(id) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const report = await VATReport.findById(id).session(session);
      if (!report) throw new AppError("Report not found", 404);
      if (report.status !== "DRAFT")
        throw new AppError("Only DRAFT reports can be deleted", 400);

      await VATReport.deleteOne({ _id: id }).session(session);
      await session.commitTransaction();
      return { deleted: true };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }
}

// Reuse the pipeline stages for getReportById
const pipeline = [
  {
    $lookup: {
      from: "stocks",
      localField: "items.itemId",
      foreignField: "_id",
      as: "stockLookup",
    },
  },
  {
    $addFields: {
      items: {
        $map: {
          input: "$items",
          as: "it",
          in: {
            $mergeObjects: [
              "$$it",
              {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: "$stockLookup",
                      as: "st",
                      cond: { $eq: ["$$st._id", "$$it.itemId"] },
                    },
                  },
                  0,
                ],
              },
            ],
          },
        },
      },
    },
  },
  { $lookup: { from: "customers", localField: "items.partyId", foreignField: "_id", as: "customerLookup" } },
  { $lookup: { from: "vendors", localField: "items.partyId", foreignField: "_id", as: "vendorLookup" } },
  {
    $addFields: {
      items: {
        $map: {
          input: "$items",
          as: "it",
          in: {
            $mergeObjects: [
              "$$it",
              {
                partyName: {
                  $cond: {
                    if: { $eq: ["$$it.partyType", "Customer"] },
                    then: {
                      $getField: {
                        field: "customerName",
                        input: {
                          $arrayElemAt: [
                            {
                              $filter: {
                                input: "$customerLookup",
                                as: "c",
                                cond: { $eq: ["$$c._id", "$$it.partyId"] },
                              },
                            },
                            0,
                          ],
                        },
                      },
                    },
                    else: {
                      $getField: {
                        field: "vendorName",
                        input: {
                          $arrayElemAt: [
                            {
                              $filter: {
                                input: "$vendorLookup",
                                as: "v",
                                cond: { $eq: ["$$v._id", "$$it.partyId"] },
                              },
                            },
                            0,
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
  { $unset: ["stockLookup", "customerLookup", "vendorLookup"] },
];

module.exports = VATReportService;