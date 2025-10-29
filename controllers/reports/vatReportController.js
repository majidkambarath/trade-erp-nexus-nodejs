const VATReportService = require("../../services/reports/vatReportService");
const AppError = require("../../utils/AppError");

class VATReportController {
  // GET /api/vat-reports
  static async getAll(req, res, next) {
    try {
      const result = await VATReportService.getAllReports(req.query);
      res.status(200).json({
        success: true,
        data: result.reports,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  }

  // GET /api/vat-reports/:id
  static async getById(req, res, next) {
    try {
      const report = await VATReportService.getReportById(req.params.id);
      res.status(200).json({ success: true, data: report });
    } catch (err) {
      next(err);
    }
  }

  // POST /api/vat-reports/:id/finalize
  static async finalize(req, res, next) {
    try {
      const { userId } = req.body; // from auth middleware
      if (!userId) throw new AppError("userId is required", 400);

      const report = await VATReportService.finalizeReport(req.params.id, userId);
      res.status(200).json({ success: true, data: report });
    } catch (err) {
      next(err);
    }
  }

  // POST /api/vat-reports/:id/submit
  static async submit(req, res, next) {
    try {
      const { userId } = req.body;
      if (!userId) throw new AppError("userId is required", 400);

      const report = await VATReportService.submitReport(req.params.id, userId);
      res.status(200).json({ success: true, data: report });
    } catch (err) {
      next(err);
    }
  }

  // DELETE /api/vat-reports/:id
  static async deleteDraft(req, res, next) {
    try {
      await VATReportService.deleteDraftReport(req.params.id);
      res.status(200).json({ success: true, message: "Draft report deleted" });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = VATReportController;