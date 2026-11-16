// What a model wrote, tidied before anybody reads it. Pure.
//
// A model sometimes writes a pretend `<button>Open Audit Trail</button>` (the real button comes from its open_screen
// call and is drawn under the answer, so a pretend one is noise), other HTML tags, or Markdown links. The words inside
// a tag or a link are kept; a button goes whole. The browser never renders an answer as HTML either - this keeps the
// stored answer clean. A twin of `withoutMarkup` in trade erp/src/lib/answerFormat.js, which also cleans answers
// saved before this existed.
function cleanAnswer(text) {
  return String(text || "")
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, "")
    // a tool call the model wrote out as text, for example {{open_screen({"path":"/x"})}}: the real button is drawn from the call
    .replace(/\{\{[\s\S]*?\}\}/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, "")
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1")
    // "(Topic used: Profit and loss)": the panel already says where an answer came from, under it
    .replace(/^[ \t]*\(?\s*\**\s*(?:help )?topics? used\s*:[^\n]*$/gim, "")
    // *italic* (one asterisk each side) loses its asterisks; **bold** is left for the formatter
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { cleanAnswer };
