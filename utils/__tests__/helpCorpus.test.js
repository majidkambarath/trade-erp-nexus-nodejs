// The corpus loader and its retrieval. Pure: no database, no server, no model.
//
// Two of these tests are the feature's safety net rather than checks on behaviour: that the loader
// cannot reach a document written for developers, and that a question the corpus has nothing to say
// about returns nothing at all. Breaking either one is how a client ends up reading our decision
// log, or a confident answer assembled from an unrelated topic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const corpus = require("../helpCorpus");

const ROOT = path.join(__dirname, "..", "..");

const fixture = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-corpus-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, "utf8");
  return dir;
};

const topic = ({ title = "A topic", audience = "client", extra = "", body = "Some help text here." }) =>
  `---\ntitle: ${JSON.stringify(title)}\naudience: ${audience}\nsource: Guide 1.1\n${extra}---\n\n# ${title}\n\n${body}\n`;

test("the loader reads docs/help and cannot be pointed at a developer document", () => {
  // read() takes a directory only so the tests can use a fixture; nothing in the app passes one,
  // and the default is fixed at docs/help.
  assert.equal(corpus.HELP_DIR, path.join(ROOT, "docs", "help"));
  // Checked against the CODE, not the prose: the header comment names those documents on purpose,
  // to say why they are excluded. Comments are stripped before the check so the explanation can
  // stay and a code path that reached one of them would still fail.
  const code = fs
    .readFileSync(path.join(ROOT, "utils", "helpCorpus.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // HELP_DIR itself is asserted above, which is the real guarantee about where it reads.
  for (const forbidden of ["CLAUDE.md", "DOCUMENTATION.md", "ERP_FEATURE_SPEC"]) {
    assert.ok(!code.includes(forbidden), `the loader's code names ${forbidden} outside a comment`);
  }
  assert.ok(!code.includes("recursive"), "the loader must not walk into subdirectories");
  // and the real corpus holds none of them
  const names = fs.readdirSync(corpus.HELP_DIR);
  for (const n of names) assert.doesNotMatch(n, /CLAUDE|DOCUMENTATION|FEATURE_SPEC/i);
});

test("a topic is kept only when its audience is the client, and the rest are counted", () => {
  const dir = fixture({
    "a.md": topic({ title: "For a client", audience: "client" }),
    "b.md": topic({ title: "For us", audience: "internal" }),
    "c.md": topic({ title: "No audience at all", audience: "" }),
    "README.md": "# not a topic\n",
    "d.txt": topic({ title: "Not markdown" }),
  });
  const { topics, stats } = corpus.read(dir);
  assert.deepEqual(topics.map((t) => t.title), ["For a client"]);
  assert.equal(stats.withheld, 2, "internal and audience-less topics are dropped, and counted");
  assert.equal(stats.topics, 1);
  assert.equal(stats.missing, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no corpus on disk is a state the caller can see, not a crash", () => {
  const out = corpus.read(path.join(os.tmpdir(), "zai-no-such-dir-" + Date.now()));
  assert.deepEqual(out.topics, []);
  assert.equal(out.stats.missing, true);
});

test("front matter: quoted titles, inline lists and block lists all parse", () => {
  const parsed = corpus.parseFrontMatter(
    topic({
      title: 'Order to cash: "the" flow',
      extra: 'screens: ["/sales-order", "/delivery-notes"]\nquestions:\n  - "how do I raise an invoice"\n  - "how do I sell something"\ntags: [sales, invoice]\nreview: "stale in three ways"\n',
      body: "Body text.",
    })
  );
  assert.equal(parsed.meta.title, 'Order to cash: "the" flow');
  assert.deepEqual(parsed.meta.screens, ["/sales-order", "/delivery-notes"]);
  assert.deepEqual(parsed.meta.questions, ["how do I raise an invoice", "how do I sell something"]);
  assert.deepEqual(parsed.meta.tags, ["sales", "invoice"]);
  assert.equal(parsed.meta.review, "stale in three ways");
  assert.equal(parsed.body, "# Order to cash: \"the\" flow\n\nBody text.");
  assert.equal(corpus.parseFrontMatter("no front matter here"), null);
});

test("the loader does not walk into subdirectories: only *.md sitting in the folder itself", () => {
  const dir = fixture({ "a.md": topic({ title: "At the top" }) });
  fs.mkdirSync(path.join(dir, "deeper"));
  fs.writeFileSync(path.join(dir, "deeper", "b.md"), topic({ title: "Buried" }), "utf8");
  const { topics } = corpus.read(dir);
  assert.deepEqual(topics.map((t) => t.title), ["At the top"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("all() reads the fixed corpus and ignores anything a caller might pass", () => {
  const dir = fixture({ "x.md": topic({ title: "A planted topic nobody should see" }) });
  const titles = corpus.reload().map((t) => t.title);
  assert.ok(titles.length > 100, `the real corpus has ${titles.length} topics`);
  assert.ok(!titles.includes("A planted topic nobody should see"));
  assert.equal(corpus.all(dir).length, titles.length, "all() takes no directory");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- retrieval -----------------------------------------------------------------------------------

const POOL = [
  { id: "t1", title: "Order to cash", source: "", screens: ["/sales-order"], tags: [], review: "",
    questions: ["how do I raise an invoice", "how do I sell something"],
    body: "Price the order, check credit, approve it so stock leaves and the sale is booked." },
  { id: "t2", title: "Trial balance", source: "", screens: ["/financial-statements"], tags: [], review: "",
    questions: ["why is my trial balance out"], body: "Every account with a balance, debits against credits." },
  { id: "t3", title: "Customers and vendors", source: "", screens: ["/customers", "/vendors"], tags: [], review: "",
    questions: ["how do I add a customer"], body: "A customer carries a credit limit, contacts and documents." },
];

test("a phrasing somebody actually asks beats every other signal", () => {
  const hits = corpus.pick("how do I raise an invoice", { topics: POOL, limit: 3 });
  assert.equal(hits[0].title, "Order to cash");
  assert.ok(hits[0].score >= corpus.W.phrase, `scored only ${hits[0].score}`);
  assert.match(hits[0].why[0], /someone asks this as/);
});

test("the screen carries a question too vague to answer on its words alone", () => {
  const vague = "what do I do here";
  assert.deepEqual(corpus.pick(vague, { topics: POOL }), [], "no screen: nothing to go on");
  const onScreen = corpus.pick(vague, { topics: POOL, screen: "/customers" });
  assert.equal(onScreen.length, 1);
  assert.equal(onScreen[0].title, "Customers and vendors");
  assert.match(onScreen[0].why.join(" "), /this is the \/customers screen/);
});

test("a question the corpus cannot answer returns NOTHING, not its nearest miss", () => {
  // The honest default. Without the floor this collects a few points from incidental words and the
  // model is handed an unrelated topic to answer from.
  assert.deepEqual(corpus.pick("", { topics: POOL }), []);
  // Against the REAL corpus, which has no word about production, job work or the CRM. The nearest
  // miss is real there - a topic on approving documents shares "how" and a few body words - so this
  // pair of assertions is what proves the floor is doing the work and not the pool's small size.
  const q = "how do I set up production";
  assert.deepEqual(corpus.pick(q), [], "a question the corpus cannot answer must return nothing");
  const loose = corpus.pick(q, { minScore: 1 });
  assert.ok(loose.length > 0, "there IS a nearest miss, which is exactly what the floor exists to drop");
  assert.ok(loose[0].score < 20, `the nearest miss scored ${loose[0].score}, so the floor is mis-set`);
});

test("the same question always picks the same topics in the same order", () => {
  const once = corpus.pick("how do I add a customer", { topics: POOL, limit: 3 });
  const again = corpus.pick("how do I add a customer", { topics: [...POOL].reverse(), limit: 3 });
  assert.deepEqual(once.map((h) => h.id), again.map((h) => h.id), "order must not depend on disk order");
});

test("a long topic cannot win on length alone", () => {
  const padded = { ...POOL[1], id: "big", title: "A padded topic", questions: [],
    body: ("customer credit limit contacts documents invoice order stock ").repeat(400) };
  const hits = corpus.pick("how do I add a customer", { topics: [...POOL, padded], limit: 2 });
  assert.equal(hits[0].title, "Customers and vendors", "the padded topic outscored the right one");
});

test("an excerpt stops at a sentence and says it was cut", () => {
  const body = "First sentence here. Second sentence here. " + "x".repeat(500);
  const out = corpus.excerpt(body, 60);
  assert.ok(out.length < body.length);
  assert.match(out, /\[this topic continues\]$/);
  assert.equal(corpus.excerpt("short", 60), "short");
});

test("the real corpus is whole: every topic has a title, a body, and names no code", () => {
  const topics = corpus.reload();
  assert.ok(topics.length > 100, `only ${topics.length} topics`);
  for (const t of topics) {
    assert.ok(t.title.trim(), `${t.id} has no title`);
    assert.ok(t.body.trim().length > 80, `${t.id} has almost no body`);
    assert.doesNotMatch(`${t.title} ${t.body}`, /\.js\b|__tests__|\.test\./, `${t.id} names code`);
    for (const s of t.screens) assert.match(s, /^\/[a-z0-9-/]*$/, `${t.id} screen ${s}`);
  }
  assert.ok(corpus.stats().withheld > 0, "nothing was withheld: the audience filter did not run");
});

test("the screen tip lists what that screen is about", () => {
  const tips = corpus.forScreen("/customers", { topics: POOL });
  assert.deepEqual(tips.map((t) => t.title), ["Customers and vendors"]);
  assert.deepEqual(corpus.forScreen("", { topics: POOL }), []);
});

test("the screen ranks a topic but cannot qualify one", () => {
  // Asked while standing on Accounting setup, about something the corpus has no word about. Before
  // the screen was demoted to a ranking signal this came back with four confident topics about
  // setting up a company, because every topic on the screen collected the screen's 20 points.
  assert.deepEqual(corpus.pick("how do I set up production", { screen: "/accounting-setup" }), []);
  assert.deepEqual(corpus.pick("how do I do job work", { screen: "/stock" }), []);
  // The same screen still answers a question with no words worth scoring, which is the whole
  // reason the screen is a signal at all.
  const vague = corpus.pick("what do I do here", { screen: "/vat-return" });
  assert.ok(vague.length > 0, "a vague question on a specific screen is answerable");
  assert.ok(vague.every((h) => h.screens.includes("/vat-return")), "and only by topics about that screen");
});
