const DefaultChartService = require("../services/financial/defaultChartService");

// Reports are only as complete as the ledger behind them. Before a report reads, make sure a company
// that never chose otherwise has ledger posting on, and that the documents approved so far have been
// posted (at most once a minute per server). A failure here never blocks the report itself.
module.exports = async function ledgerReady(req, res, next) {
  try {
    await DefaultChartService.onOpenThrottled(req);
  } catch (err) {
    console.error("[ledger] readiness check failed:", err.message);
  }
  next();
};
