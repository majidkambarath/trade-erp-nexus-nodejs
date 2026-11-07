// Pure rules of W6 (talent): what a standard onboarding or exit checklist contains, and whether an
// appraisal can be saved. No Mongoose, no clock beyond what is handed in.
const { isCalendarDay } = require("./documentExpiry");

const str = (v) => (typeof v === "string" ? v.trim() : "");

// The standard items. An organisation does not configure these in Setup (no Setup screen for it this
// wave - D16's own "the smallest wave" choice): they are a sensible, editable-later starting checklist,
// and the service lets any one item be renamed or removed once created, the same as any other task.
const ONBOARDING_ITEMS = Object.freeze([
  "Collect ID and visa documents",
  "Set up email and system access",
  "Issue ID card and any required equipment",
  "Introduce to the team and the reporting line",
  "Explain pay, leave and attendance policy",
]);

const EXIT_ITEMS = Object.freeze([
  "Return company assets (ID card, equipment, keys)",
  "Revoke system and email access",
  "Settle outstanding leave and dues",
  "Conduct an exit interview",
  "Issue the final settlement",
]);

const LIST_TYPES = Object.freeze(["onboarding", "exit"]);

/** The standard items for a checklist, or null for an unknown type. Pure data, no day attached - the
 * service stamps a due day (or leaves it unset) when it actually creates the rows. */
function standardItems(listType) {
  if (listType === "onboarding") return [...ONBOARDING_ITEMS];
  if (listType === "exit") return [...EXIT_ITEMS];
  return null;
}

/** Whether an appraisal can be saved. Deliberately light: a period label, a real review day, and at
 * least ONE of strengths/improvements/goals/rating actually says something - an appraisal that is
 * entirely blank is not a record of anything. */
function validateAppraisal(data) {
  const errors = [];
  const add = (code, message, field) => errors.push({ code, message, field });
  const d = data && typeof data === "object" ? data : {};
  if (!str(d.periodLabel)) add("PERIOD_REQUIRED", "Name the review period", "periodLabel");
  if (!isCalendarDay(d.reviewDate)) add("INVALID_REVIEW_DATE", "Enter the day of the review", "reviewDate");
  const saysSomething = [d.strengths, d.improvements, d.goals, d.rating].some((v) => str(v).length > 0);
  if (!saysSomething) add("APPRAISAL_EMPTY", "Write at least one of strengths, improvements, goals or a rating", "strengths");
  return errors;
}

module.exports = { ONBOARDING_ITEMS, EXIT_ITEMS, LIST_TYPES, standardItems, validateAppraisal };
