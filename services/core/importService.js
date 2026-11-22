// The loop every spreadsheet import runs once its rows are planned (utils/importRules.js, utils/masterImport.js): preview, or write one row
// at a time and say what happened to each. Knows nothing about customers or items; the caller names how a row is made.
//
// THREE RULES THAT MATTER:
//   - Only an explicit `dryRun: false` writes. Anything else - a missing flag, "false", 0 - is the preview, so an import is never done
//     by accident, and the screen always previews first.
//   - One row is one call to `create`, never a whole lot in one transaction. A single duplicate key inside a shared transaction aborts ALL of
//     it, and a retry would replay every row. Each `create` is the form's own save, which opens (and retries) its own transaction.
//   - A row that fails is reported with its line and its own words, and the rest carry on. Running the same file twice is safe: the second
//     time every row is a duplicate.
const AppError = require("../../utils/AppError");
const R = require("../../utils/importRules");

/** An error as one failed row: a code and words a person can act on. A duplicate key is a record somebody made a moment ago. */
function failure(line, error) {
  if (error?.code === 11000) return { line, code: "DUPLICATE", message: "That record was made a moment ago, by somebody else or by an earlier lot of this file" };
  return { line, code: typeof error?.code === "string" ? error.code : "IMPORT_ROW_FAILED", message: error?.message || "The row could not be saved" };
}

class ImportService {
  static failure = failure;

  /**
   * @param plan    { rows, summary } from a planXImport (an `error` there is the caller's to throw before it gets here)
   * @param create  async (fields, row) -> the record made, for ONE row
   * @param describe (record) -> what the person reads of it: { id, ... }
   * @param extra   more to say in the answer (new categories, missing units, notes ...)
   */
  static async run(plan, { dryRun = true, create, describe, extra = {}, writeLimit = R.MAX_WRITE_ROWS } = {}) {
    const issues = R.issuesOf(plan.rows);
    if (dryRun !== false) {
      const sample = plan.rows.filter((r) => r.status === "create").slice(0, 5).map((r) => r.fields);
      return { dryRun: true, summary: plan.summary, issues, sample, ...extra };
    }
    if (plan.rows.length > writeLimit) throw new AppError(R.tooMany(writeLimit).message, 400, "IMPORT_TOO_MANY");

    const created = [];
    const failed = [];
    for (const row of plan.rows) {
      if (row.status !== "create") continue;
      try {
        const record = await create(row.fields, row);
        created.push({ line: row.line, ...describe(record) });
      } catch (error) {
        failed.push(failure(row.line, error));
      }
    }
    return { dryRun: false, summary: { ...plan.summary, created: created.length, failed: failed.length }, created, issues, failed, ...extra };
  }
}

module.exports = ImportService;
