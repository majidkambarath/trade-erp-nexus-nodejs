// Text typed into a search box is text to FIND, not a pattern to run. A pattern from outside can be invalid (and crash the request with
// a 500), or catastrophic (a few characters that make the database spin on every row), so a search term is escaped and capped before it
// becomes a regular expression. Anything that is not a string (a query string like ?search[$ne]=x arrives as a literal key, and a JSON
// body can carry an object) is searched for as its plain text, never as an operator.
const escapeRegex = (text) => String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A case-insensitive "contains" regular expression for what a person typed. */
const searchRegex = (text, { max = 100 } = {}) => new RegExp(escapeRegex(typeof text === "string" ? text.trim().slice(0, max) : String(text ?? "").slice(0, max)), "i");

module.exports = { escapeRegex, searchRegex };
