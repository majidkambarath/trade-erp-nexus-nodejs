const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanAnswer } = require("../assistantAnswer");

test("a pretend button goes whole: the real one is drawn from the open_screen call", () => {
  assert.equal(cleanAnswer("You can view the audit trail in the Ledger Reports screen.\n<button>Open Audit Trail</button>"), "You can view the audit trail in the Ledger Reports screen.");
  assert.equal(cleanAnswer('Go. <button onclick="x()">Open</button>'), "Go.");
});

test("other tags and Markdown links keep their words; plain text is untouched", () => {
  assert.equal(cleanAnswer("<p>One</p><p>Two <b>bold</b></p>"), "One\n\nTwo bold");
  assert.equal(cleanAnswer("Open [Payments](/payment-voucher) to pay."), "Open Payments to pay.");
  assert.equal(cleanAnswer("Stock < 10 means reorder. **Bold** stays.\n1. Step"), "Stock < 10 means reorder. **Bold** stays.\n1. Step");
});

test("a tool call the model wrote out as text is taken out", () => {
  assert.equal(cleanAnswer('You can view it. {{open_screen({"label":"Balance Sheet","path":"/financial-statements"})}}'), "You can view it.");
});
