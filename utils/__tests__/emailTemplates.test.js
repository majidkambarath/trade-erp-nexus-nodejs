const test = require("node:test");
const assert = require("node:assert/strict");
const { renderDocumentEmail, subjectFor, escapeHtml } = require("../emailTemplates");

const company = { companyName: "Harbour Trading LLC", addressLine1: "Al Quoz", phoneNumber: "04 123 4567", email: "accounts@harbour.ae", vatNumber: "100123456700003" };
const base = {
  docType: "tax_invoice", documentNo: "INV-2026-0042", date: "2026-10-06T10:00:00Z", dueDate: "2026-11-05T00:00:00Z", total: 1234.5, currency: "AED",
  partyName: "Al Noor Trading", contactPerson: "Ali", company, shareUrl: "https://app.example/d/ABC.xyz", shareExpiresAt: "2026-11-05T00:00:00Z", hasAttachment: true,
};

test("subject names the document and the sender", () => {
  assert.equal(subjectFor(base), "Tax invoice INV-2026-0042 from Harbour Trading LLC");
  assert.equal(subjectFor({ ...base, docType: "quotation", documentNo: "QT-2026-0007", validUntil: "2026-11-14T00:00:00Z" }), "Quotation QT-2026-0007 from Harbour Trading LLC - valid until 14 Nov 2026");
  assert.equal(subjectFor({ ...base, docType: "delivery_note", documentNo: "DLN-2026-0031" }), "Delivery note DLN-2026-0031 from Harbour Trading LLC");
  assert.equal(subjectFor({ ...base, docType: "statement", period: { from: "2026-01-01", to: "2026-03-31" } }), "Statement of account - 1 Jan 2026 to 31 Mar 2026 from Harbour Trading LLC");
  assert.equal(subjectFor({ ...base, company: {} }), "Tax invoice INV-2026-0042");
});

test("the body states the facts: number, date, amount and due date", () => {
  const { text, html } = renderDocumentEmail(base);
  assert.match(text, /^Dear Ali,/);
  assert.match(text, /tax invoice INV-2026-0042 dated 6 Oct 2026 for 1,234\.50 AED\. It is due on 5 Nov 2026\./);
  assert.match(html, /1,234\.50 AED/);
});

test("the text part carries the raw link, because a button does not survive every mail client", () => {
  const { text, html } = renderDocumentEmail(base);
  assert.ok(text.includes("https://app.example/d/ABC.xyz"));
  assert.match(html, /<a href="https:\/\/app\.example\/d\/ABC\.xyz"[^>]*>View document<\/a>/);
  assert.match(text, /This link works until 5 Nov 2026\./);
});

test("the attachment sentence and the link sentence appear only when there is one", () => {
  const bare = renderDocumentEmail({ ...base, shareUrl: null, hasAttachment: false });
  assert.equal(/PDF copy is attached/.test(bare.text + bare.html), false);
  assert.equal(/View document|works until/.test(bare.text + bare.html), false);
  assert.match(renderDocumentEmail(base).text, /A PDF copy is attached\./);
});

test("everything a person typed or a record holds is escaped in the HTML", () => {
  const evil = "<script>alert(1)</script>";
  const { html } = renderDocumentEmail({ ...base, partyName: evil, contactPerson: "", note: `<b>hi</b>\nsecond line "quoted"`, company: { ...company, companyName: evil }, signature: "<i>sig</i>" });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>hi</b>"), false);
  assert.equal(html.includes("<i>sig</i>"), false);
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;<br>second line &quot;quoted&quot;/);
  assert.equal(escapeHtml(`a&b<c>"d"'e'`), "a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;");
});

test("no tracking pixel, no script, no remote stylesheet; a logo only over https", () => {
  const { html } = renderDocumentEmail(base);
  assert.equal(/<img/i.test(html), false, "no logo given, so no image at all");
  assert.equal(/<script|<link|@import|<iframe/i.test(html), false);
  assert.match(renderDocumentEmail({ ...base, company: { ...company, logo: "https://cdn.example/l.png" } }).html, /<img src="https:\/\/cdn\.example\/l\.png"/);
  assert.equal(/<img/i.test(renderDocumentEmail({ ...base, company: { ...company, logo: "http://insecure/l.png" } }).html), false);
  assert.equal(/<img/i.test(renderDocumentEmail({ ...base, company: { ...company, logo: "javascript:alert(1)" } }).html), false);
});

test("a customer with no contact name is greeted by the company name, then plainly", () => {
  assert.match(renderDocumentEmail({ ...base, contactPerson: "" }).text, /^Dear Al Noor Trading,/);
  assert.match(renderDocumentEmail({ ...base, contactPerson: "", partyName: "" }).text, /^Dear customer,/);
});

test("a statement says the period and the balance", () => {
  const { text } = renderDocumentEmail({ ...base, docType: "statement", documentNo: "", period: { from: "2026-01-01", to: "2026-03-31" }, total: 5400 });
  assert.match(text, /statement of account for 1 Jan 2026 to 31 Mar 2026\. The balance at the end of the period is 5,400\.00 AED\./);
});

test("the company block and the reply line close the message", () => {
  const { text } = renderDocumentEmail(base);
  assert.match(text, /Harbour Trading LLC\nAl Quoz\nTel 04 123 4567  \|  accounts@harbour\.ae\nTRN 100123456700003/);
  assert.match(text, /Reply to this email if you have a question\.$/);
});
