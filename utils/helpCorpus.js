// The help corpus Zarvia AI answers from. Reads docs/help and nothing else.
//
// THIS FILE IS THE BOUNDARY between what a client may be told and what is written for us. The
// repository is full of documents that must never reach a client - CLAUDE.md, DOCUMENTATION.md and
// docs/ERP_FEATURE_SPEC.md are written for developers and name files, tests, open bugs and
// decisions - so the loader does not take a directory from a caller, reads only *.md sitting
// directly in docs/help, and keeps a topic only when its front matter says `audience: client`.
// A topic with any other audience is loaded and then dropped, deliberately: being able to count
// what was withheld is how we know the filter ran.
//
// Retrieval is a deterministic score over the organisation's own topics, not an embedding. With a
// few hundred topics that is the right answer: it is explainable (the assistant can say which
// signal matched), it needs no index to build or keep warm, and the same question always picks the
// same topics, so an answer that was wrong can be reproduced. Revisit past a few hundred topics.

const fs = require("node:fs");
const path = require("node:path");

const HELP_DIR = path.join(__dirname, "..", "docs", "help");
const CLIENT = "client";
// README.md documents the corpus for us; it is not a topic.
const NOT_A_TOPIC = new Set(["readme.md"]);
const LEASE_MS = 60_000;

// Front matter is a fixed, tiny shape written by scripts/help/split.py, so it is parsed strictly
// rather than with a YAML library: a field we do not recognise is ignored, and a file with no front
// matter is not a topic at all.
const SCALARS = new Set(["title", "audience", "source", "review"]);
const LISTS = new Set(["screens", "questions", "tags"]);

const unquote = (v) => {
  const s = v.trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1).replace(/"/g, '\\"')}"` : s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
};

function parseFrontMatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  const meta = {};
  let listKey = null;
  for (const raw of head.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (SCALARS.has(key)) {
      meta[key] = unquote(value);
    } else if (LISTS.has(key)) {
      if (value.trim().startsWith("[")) {
        meta[key] = value
          .trim()
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(unquote)
          .filter(Boolean);
      } else {
        meta[key] = [];
        listKey = key;
      }
    }
  }
  return { meta, body: body.trim() };
}

let cache = null;
let cachedAt = 0;
let lastStats = null;

/** Read every topic from disk. `dir` is for tests only; nothing in the app passes it. */
function read(dir = HELP_DIR) {
  const topics = [];
  let withheld = 0;
  let unreadable = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md") && !NOT_A_TOPIC.has(n.toLowerCase()));
  } catch {
    // No corpus on disk is a real state, not a crash: readiness reports it and the assistant
    // refuses to answer rather than inventing from the model's own memory.
    return { topics: [], stats: { topics: 0, withheld: 0, unreadable: 0, missing: true } };
  }
  for (const name of names.sort()) {
    let parsed = null;
    try {
      parsed = parseFrontMatter(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      unreadable += 1;
      continue;
    }
    if (!parsed || !parsed.meta.title) {
      unreadable += 1;
      continue;
    }
    if (parsed.meta.audience !== CLIENT) {
      withheld += 1;
      continue;
    }
    topics.push({
      id: name.replace(/\.md$/, ""),
      title: parsed.meta.title,
      source: parsed.meta.source || "",
      screens: parsed.meta.screens || [],
      questions: parsed.meta.questions || [],
      tags: parsed.meta.tags || [],
      review: parsed.meta.review || "",
      body: parsed.body,
    });
  }
  return { topics, stats: { topics: topics.length, withheld, unreadable, missing: false } };
}

/** Every client topic, cached on a short lease so a corrected guide shows without a restart. */
function all({ now = Date.now() } = {}) {
  if (!cache || now - cachedAt > LEASE_MS) {
    const out = read();
    cache = out.topics;
    lastStats = out.stats;
    cachedAt = now;
  }
  return cache;
}

const stats = () => (lastStats ? { ...lastStats } : (all(), { ...lastStats }));
const reload = () => {
  cache = null;
  cachedAt = 0;
  return all();
};

// ---- retrieval ----------------------------------------------------------------------------------

// Words that carry no signal in a question about an ERP. Deliberately short: a stop list that grows
// starts deciding meaning, and "how", "where" and "why" really do distinguish questions.
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "i",
  "if", "in", "is", "it", "its", "me", "my", "not", "of", "on", "or", "our", "that", "the", "then",
  "there", "these", "this", "to", "was", "we", "what", "when", "which", "with", "you", "your",
  "here", "now", "please", "help",
]);

const words = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));

const uniq = (xs) => [...new Set(xs)];

// How a topic earns its place. The weights are blunt on purpose: a phrasing somebody actually asked
// beats everything, the title beats the body, and a long topic cannot win on length alone (its body
// contribution is capped), or the account-mapping reference would answer every question.
const W = { phrase: 60, question: 5, title: 8, tag: 4, body: 1, bodyCap: 10, screen: 20 };

function scoreTopic(topic, { tokens, phrase, screen }) {
  let score = 0;
  const why = [];
  for (const q of topic.questions) {
    const qq = String(q).toLowerCase().trim();
    // The second direction is for somebody who types less than the stored phrasing ("raise an
    // invoice" against "how do I raise an invoice"). It needs a minimum length of its own: every
    // string contains the empty string, so without it a blank question scored a full phrase match
    // against every topic that had a long phrasing.
    const briefer = phrase.length >= 8 && qq.length > 12 && qq.includes(phrase);
    if (qq && (phrase.includes(qq) || briefer)) {
      score += W.phrase;
      why.push(`someone asks this as "${q}"`);
      break;
    }
  }
  const hit = (hay, weight, label, cap) => {
    const bag = new Set(words(hay));
    const matched = tokens.filter((t) => bag.has(t));
    if (!matched.length) return;
    let add = matched.length * weight;
    if (cap) add = Math.min(add, cap);
    score += add;
    why.push(`${label}: ${uniq(matched).slice(0, 4).join(", ")}`);
  };
  hit(topic.title, W.title, "title");
  hit(topic.questions.join(" "), W.question, "questions");
  hit(topic.tags.join(" "), W.tag, "tags");
  hit(topic.body, W.body, "body", W.bodyCap);
  const lexical = score;
  let onScreen = false;
  if (screen && topic.screens.includes(screen)) {
    score += W.screen;
    onScreen = true;
    why.push(`this is the ${screen} screen`);
  }
  // `lexical` is the score from the person's own words alone. It is kept apart because the screen
  // must not be able to QUALIFY a topic, only rank it: otherwise every question asked on a screen
  // collects that screen's topics, and "how do I set up production" asked on Accounting setup comes
  // back with four confident topics about something else entirely.
  return { score, lexical, onScreen, why };
}

/**
 * The topics to put in front of the model for one question.
 *
 * `screen` is the app path the person is on, which is often more informative than their words:
 * "why can I not save this" on /receipt-voucher is a different question from the same words on
 * /accounting-setup.
 *
 * `minScore` is the important argument. A question the corpus has nothing to say about still
 * collects a few points from incidental words - "how do I set up production" scores 15 against a
 * topic on approving documents, because the corpus has no production content at all. Handing that
 * to the model invites it to answer from whatever it was given. Below the floor we return NOTHING,
 * which is what makes "I do not know, shall I pass this to the team?" the honest default rather
 * than a confident wrong answer. A match on the screen alone scores 20, and that is deliberately
 * kept: a vague question on a specific screen is answerable.
 */
function pick(question, { screen = "", limit = 4, maxChars = 6000, minScore = 20, topics = null } = {}) {
  const pool = topics || all();
  const phrase = String(question || "").toLowerCase().trim();
  const tokens = uniq(words(question));
  // Nothing to go on at all: no words worth scoring and no screen to fall back on.
  if (!pool.length || (!tokens.length && !screen)) return [];
  const scored = pool
    .map((t) => ({ topic: t, ...scoreTopic(t, { tokens, phrase, screen }) }))
    .filter((s) => s.lexical >= minScore || (s.onScreen && s.lexical === 0 && tokens.length <= 2))
    .sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title))
    .slice(0, limit);
  let left = maxChars;
  return scored.map(({ topic, score, why }) => {
    const body = excerpt(topic.body, Math.max(600, left));
    left -= body.length;
    return { id: topic.id, title: topic.title, source: topic.source, screens: topic.screens, review: topic.review, score, why, body };
  });
}

/** Everything about one screen, for the tip the panel opens with before anything is asked. */
const forScreen = (screen, { topics = null } = {}) =>
  (topics || all())
    .filter((t) => screen && t.screens.includes(screen))
    .map((t) => ({ id: t.id, title: t.title, screens: t.screens }))
    .sort((a, b) => a.title.localeCompare(b.title));

/**
 * Questions worth offering on a screen, taken from the documentation itself.
 *
 * Every topic's front matter carries the phrasings people actually use, so the suggestions are
 * whatever the guide already says this screen is about - they grow as the corpus does, and there is
 * no second list to keep in step with it. Shortest first: a short question reads as a button, and a
 * long one reads as a paragraph nobody taps.
 */
function suggestionsFor(screen, { limit = 4, topics = null } = {}) {
  if (!screen) return [];
  const asked = (topics || all())
    .filter((t) => (t.screens || []).includes(screen))
    .flatMap((t) => t.questions || [])
    .map((q) => String(q).trim())
    .filter(Boolean);
  // Some phrasings in the front matter are search keywords rather than questions ("order to cash",
  // "VAT 201"). They earn their place in retrieval and read as nonsense on a button, so a phrasing
  // that actually asks something is offered first, and a bare two-word fragment not at all.
  const ASKS = /^(how|why|what|where|when|which|who|can|do|does|is|are|should) /i;
  const seen = new Set();
  const unique = asked.filter((q) => (seen.has(q.toLowerCase()) ? false : seen.add(q.toLowerCase())));
  // Only a phrasing that asks something is offered. A screen with none offers fewer buttons, which
  // is better than padding with a keyword nobody would tap.
  return unique
    .filter((q) => ASKS.test(q))
    .sort((x, y) => x.length - y.length)
    .slice(0, limit)
    .map((q) => (q.endsWith("?") ? q : `${q}?`))
    .map((q) => q.charAt(0).toUpperCase() + q.slice(1));
}

/** Cut a body down without ending mid-sentence, and say so when something was dropped. */
function excerpt(body, maxChars) {
  const s = String(body || "");
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return (at > maxChars * 0.4 ? cut.slice(0, at + 1) : cut) + "\n\n[this topic continues]";
}

const byId = (id, { topics = null } = {}) => (topics || all()).find((t) => t.id === id) || null;

module.exports = { HELP_DIR, parseFrontMatter, read, all, stats, reload, pick, forScreen, suggestionsFor, excerpt, byId, words, scoreTopic, W };
