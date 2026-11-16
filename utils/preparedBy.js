// "Prepared with Zarvia AI": a label on the audit row of a document the person confirmed from a card the
// assistant filled in. The person's own browser sends X-Prepared-By on the normal create route, so the
// route, its permissions and its rules are exactly the ones a typed document goes through. It is a LABEL
// on the trail, not evidence of anything: the audit row still names the person who saved it.
const HEADER = "x-prepared-by";
const VALUE = "zarvia-ai";

const preparedNote = (req) => (String(req?.headers?.[HEADER] || "").trim().toLowerCase() === VALUE ? " (prepared with Zarvia AI)" : "");

module.exports = { preparedNote, HEADER, VALUE };
