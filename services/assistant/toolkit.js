// The three things Zarvia AI can do. This file is the boundary on the ACTION side.
//
// In this version there is no tool that reads a client's books: the assistant answers from the
// documentation and points at screens. That is a product decision, not an oversight - letting it
// read live data is its own stage with its own risks - and it is enforced here by there being no
// such tool to call. A test asserts this file performs no database query at all.
//
// The screens it may link to are NOT a list kept here. They are the union of every screen the
// documentation mentions and every screen a refusal explanation points at, so the assistant can
// only send somebody to a page the product's own help describes, and the list maintains itself as
// the corpus grows. It also means a path the model invents cannot become a link.

const corpus = require("../../utils/helpCorpus");
const codes = require("../../utils/assistantCodes");

const MAX_RESULT_CHARS = 6000;

/** Every screen the help or a refusal explanation names, sorted. Cheap enough to compute per ask. */
function allowedScreens({ topics = null } = {}) {
  const fromHelp = (topics || corpus.all()).flatMap((t) => t.screens || []);
  return [...new Set([...fromHelp, ...codes.screensNamed()])].sort();
}

const DEFINITIONS = [
  {
    name: "search_help",
    description:
      "Search Zarvia's own documentation. Use it before answering anything about how Zarvia works, " +
      "and again with different words if the first search does not answer the question. If it " +
      "returns nothing, the documentation does not cover it: say so and offer ask_support.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What to look for, in the words the person used. Not a keyword list.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "open_screen",
    description:
      "Offer the person a button that opens a screen in Zarvia. Use it whenever the answer is " +
      "'go here and do this'. The path must be one of the screens listed in the context; anything " +
      "else is refused, so do not guess a path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The screen's path, exactly as listed in the context." },
        label: { type: "string", description: "What the button should say, in two or three words." },
      },
      required: ["path", "label"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "ask_support",
    description:
      "Pass the question to the Zarvia team. Use it when the documentation does not cover it, when " +
      "something seems broken or a figure looks wrong, when only we can make the change (a plan, a " +
      "module, a limit), or when the person is still stuck after you have tried. Tell them you are " +
      "passing it on.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line a support person can triage from." },
        question: { type: "string", description: "What the person actually needs, in their words." },
      },
      required: ["summary", "question"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const definitions = () => DEFINITIONS.map((d) => ({ ...d, input_schema: { ...d.input_schema } }));

// ---- running a call -----------------------------------------------------------------------------
//
// Every tool returns the same shape, and a refusal is a RESULT rather than a thrown error: the model
// has to be told it asked for something it cannot have, so that it corrects itself in the next turn
// instead of the whole answer failing.

const ok = (data) => ({ ok: true, data });
const refused = (reason) => ({ ok: false, error: reason });

function runSearchHelp(input, ctx) {
  const question = String(input.question || "").trim();
  if (!question) return refused("Say what to search for.");
  const hits = corpus.pick(question, {
    screen: ctx.screen || "",
    limit: 4,
    maxChars: MAX_RESULT_CHARS,
    topics: ctx.topics || null,
  });
  if (!hits.length) {
    return ok({
      found: 0,
      note:
        "The documentation has nothing on this. Do not answer it from anything else you know - " +
        "tell them it is not covered and offer to pass it on with ask_support.",
    });
  }
  return ok({
    found: hits.length,
    topics: hits.map((h) => ({ title: h.title, body: h.body })),
  });
}

function runOpenScreen(input, ctx) {
  const path = String(input.path || "").trim();
  const label = String(input.label || "").trim().slice(0, 40);
  const allowed = ctx.screens || allowedScreens({ topics: ctx.topics || null });
  if (!path) return refused("Name the screen's path.");
  if (!allowed.includes(path)) {
    return refused(
      `There is no screen at ${path} that I can link to. The ones I can are: ${allowed.join(", ")}. ` +
        "Pick one of those or leave the link out."
    );
  }
  // Recorded, not navigated: the panel decides whether to draw the button, and checks the path
  // again against the app's own routes before it does.
  ctx.links.push({ path, label: label || "Open" });
  return ok({ offered: path });
}

function runAskSupport(input, ctx) {
  const summary = String(input.summary || "").trim().slice(0, 300);
  const question = String(input.question || "").trim().slice(0, 2000);
  if (!summary || !question) return refused("Both a one-line summary and the question are needed.");
  if (ctx.escalation) return ok({ alreadyPassedOn: true });
  ctx.escalation = { summary, question };
  return ok({
    passedOn: true,
    note: "Tell them you have passed it to the Zarvia team, and what you passed on.",
  });
}

const RUNNERS = { search_help: runSearchHelp, open_screen: runOpenScreen, ask_support: runAskSupport };

/**
 * Run one tool call. `ctx` is the turn's own scratch space: { screen, topics, screens, links[],
 * escalation }. `links` and `escalation` are what the service reads afterwards, so a tool never
 * writes anything itself.
 */
function run(name, input, ctx) {
  const runner = RUNNERS[name];
  if (!runner) return refused(`There is no tool called ${name}.`);
  try {
    return runner(input && typeof input === "object" ? input : {}, ctx);
  } catch (err) {
    // A tool that throws must not take the answer down with it.
    return refused(`That did not work: ${err.message}`);
  }
}

const newContext = ({ screen = "", topics = null } = {}) => ({
  screen,
  topics,
  screens: allowedScreens({ topics }),
  links: [],
  escalation: null,
});

module.exports = { DEFINITIONS, definitions, run, allowedScreens, newContext, MAX_RESULT_CHARS };
