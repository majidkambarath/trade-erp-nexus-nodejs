// The rules behind writing to a customer from the CRM. Pure, so the things that would reach a customer's inbox
// before anybody noticed - an unfilled placeholder, markup in a subject, a signature put on twice - are failures here.
const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("../crmEmail");

test("an address is read, or it is not an address", () => {
  assert.equal(e.addressOf("  Hassan@Example.COM "), "hassan@example.com");
  assert.equal(e.addressOf("hassan at example.com"), "");
  assert.equal(e.addressOf("hassan@example"), "");
  assert.equal(e.addressOf("has san@example.com"), "");
  // The security sweep posts these at every route; none of them may read as an address.
  assert.equal(e.addressOf({ $ne: null }), "");
  assert.equal(e.addressOf(["a@b.com"]), "");
  assert.equal(e.addressOf(null), "");
});

test("a first name is the first word, and nothing is nothing", () => {
  assert.equal(e.firstNameOf("Hassan Al Mansoori"), "Hassan");
  assert.equal(e.firstNameOf("Hassan"), "Hassan");
  assert.equal(e.firstNameOf("  "), "");
  assert.equal(e.firstNameOf(undefined), "");
});

test("a known placeholder is filled, an empty one is blanked, an unknown one is LEFT ALONE", () => {
  const values = e.valuesFor({ contact: { name: "Hassan Al Mansoori" }, deal: { title: "" } });
  assert.equal(e.fill("Hello {{contact.firstName}},", values), "Hello Hassan,");
  assert.equal(e.fill("about {{deal.title}}.", values), "about .");
  // Left exactly as written, so a person proof-reading sees it and fixes it, rather than sending a sentence with a
  // hole where the quiet deletion used to be.
  assert.equal(e.fill("your {{customer.trn}} please", values), "your {{customer.trn}} please");
  assert.equal(e.fill("{{ contact.firstName }}", values), "Hassan"); // spaces inside the braces are tolerated
});

test("the values come from whatever the email is about", () => {
  const v = e.valuesFor({
    contact: { name: "Rania Haddad" },
    customer: { customerName: "Gulf Steel LLC" },
    deal: { title: "Coating line", value: 48000 },
    sender: { name: "Asif" },
    company: "Brivox",
  });
  assert.equal(v["contact.name"], "Rania Haddad");
  assert.equal(v["contact.firstName"], "Rania");
  assert.equal(v["company.name"], "Gulf Steel LLC");
  assert.equal(v["deal.title"], "Coating line");
  assert.equal(v["deal.value"], "48000");
  assert.equal(v["sender.name"], "Asif");
  assert.equal(v["sender.company"], "Brivox");
});

test("a deal worth nothing is empty, not the word undefined", () => {
  assert.equal(e.valuesFor({ deal: {} })["deal.value"], "");
  assert.equal(e.valuesFor({ deal: { value: null } })["deal.value"], "");
  assert.equal(e.valuesFor({ deal: { value: 0 } })["deal.value"], "0");
});

test("the editor can say which placeholders it cannot fill", () => {
  assert.deepEqual(e.unknownIn("Hi {{contact.firstName}}, your {{customer.trn}} and {{customer.trn}}"), ["customer.trn"]);
  assert.deepEqual(e.unknownIn("Hi {{contact.name}}"), []);
  assert.deepEqual(e.unknownIn(null), []);
});

test("what will not be sent", () => {
  const codes = (input) => e.validateEmail(input).map((x) => x.code);
  const good = { to: ["a@b.com"], subject: "Hello", body: "Something" };

  assert.deepEqual(e.validateEmail(good), []);
  assert.deepEqual(codes({ ...good, to: [] }), ["EMAIL_TO_REQUIRED"]);
  assert.deepEqual(codes({ ...good, to: ["nonsense"] }), ["EMAIL_TO_INVALID"]);
  assert.deepEqual(codes({ ...good, to: ["a@b.com", "nonsense"] }), ["EMAIL_TO_INVALID"]);
  assert.deepEqual(codes({ ...good, subject: "   " }), ["EMAIL_SUBJECT_REQUIRED"]);
  assert.deepEqual(codes({ ...good, body: "" }), ["EMAIL_BODY_REQUIRED"]);
  assert.deepEqual(codes({ ...good, cc: ["nope"] }), ["EMAIL_CC_INVALID"]);
  // A list is a conversation, not a campaign.
  assert.deepEqual(codes({ ...good, to: Array.from({ length: 11 }, (_, i) => `p${i}@b.com`) }), ["EMAIL_TOO_MANY"]);
  // A body longer than the limit is refused rather than quietly cut off mid-sentence.
  assert.deepEqual(codes({ ...good, body: "x".repeat(e.MAX_BODY + 1) }), ["EMAIL_BODY_TOO_LONG"]);
  // Nothing an injection probe sends reads as a valid email.
  assert.ok(codes({ to: { $ne: null }, subject: { $ne: null }, body: { $ne: null } }).length >= 3);
});

test("the message is built with the addresses cleaned and each one once", () => {
  const m = e.buildMessage(
    { to: ["A@B.com", "a@b.com", "bad"], cc: ["C@D.com"], subject: "Hi {{contact.firstName}}", body: "Dear {{contact.name}}" },
    { values: e.valuesFor({ contact: { name: "Hassan Ali" } }) }
  );
  assert.deepEqual(m.to, ["a@b.com"]); // the duplicate collapses, the nonsense is dropped
  assert.deepEqual(m.cc, ["c@d.com"]);
  assert.equal(m.subject, "Hi Hassan");
  assert.equal(m.body, "Dear Hassan Ali");
});

test("the signature is added once, and never twice", () => {
  const sig = "Asif\nBrivox";
  assert.equal(e.buildMessage({ to: ["a@b.com"], subject: "s", body: "Hello" }, { signature: sig }).body, "Hello\n\nAsif\nBrivox");
  // Somebody who typed their own sign-off does not get it again underneath.
  assert.equal(e.buildMessage({ to: ["a@b.com"], subject: "s", body: `Hello\n\n${sig}` }, { signature: sig }).body, `Hello\n\n${sig}`);
});

test("the body a person typed is escaped into the HTML, never passed through", () => {
  const html = e.htmlOf('Hi <script>alert(1)</script> & "quotes"');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&quot;"));
});

test("a blank line in the message stays a blank line", () => {
  const html = e.htmlOf("One\n\nTwo");
  assert.equal((html.match(/<p>/g) || []).length, 3);
  assert.ok(html.includes("<p>&nbsp;</p>"));
});

test("what a template must have", () => {
  const codes = (list) => e.validateTemplates(list).map((x) => x.code);
  assert.deepEqual(e.validateTemplates([{ name: "A", subject: "S", body: "B" }]), []);
  assert.deepEqual(codes([{ subject: "S", body: "B" }]), ["TEMPLATE_NAME_REQUIRED"]);
  assert.deepEqual(codes([{ name: "A", body: "B" }]), ["TEMPLATE_SUBJECT_REQUIRED"]);
  assert.deepEqual(codes([{ name: "A", subject: "S" }]), ["TEMPLATE_BODY_REQUIRED"]);
  assert.deepEqual(codes([{ name: "A", subject: "S", body: "B" }, { name: "a", subject: "S", body: "B" }]), ["TEMPLATE_NAME_DUPLICATE"]);
  assert.deepEqual(codes("not a list"), ["TEMPLATES_INVALID"]);
});

test("a template is given a key from its name, and keeps one it already has", () => {
  const [made, kept] = e.normaliseTemplates([
    { name: "After a call!", subject: "S", body: "B" },
    { key: "mine", name: "Other", subject: "S", body: "B" },
  ]);
  assert.equal(made.key, "after-a-call");
  assert.equal(kept.key, "mine");
});

test("the starters are real templates that fill from what we hold", () => {
  assert.deepEqual(e.validateTemplates(e.STARTER_TEMPLATES), []);
  for (const t of e.STARTER_TEMPLATES) {
    assert.deepEqual(e.unknownIn(t.subject), [], `${t.name} subject`);
    assert.deepEqual(e.unknownIn(t.body), [], `${t.name} body`);
  }
});
