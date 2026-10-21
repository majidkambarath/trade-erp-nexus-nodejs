// Asking Zarvia AI a question. One service method does the whole turn, because the turn is the
// unit: a question, the topics retrieved for it, the model's rounds, the answer, and what it cost.
//
// Nothing here writes a client's business data, and there is no path by which it could: the only
// tools are in services/assistant/toolkit.js and none of them queries a collection.
const mongoose = require("mongoose");
const AppError = require("../../utils/appError");
const corpus = require("../../utils/helpCorpus");
const codes = require("../../utils/assistantCodes");
const prompt = require("../../utils/assistantPrompt");
const toolkit = require("./toolkit");
const ai = require("./aiProviders");
const orgLocale = require("../../utils/orgLocale");
const { getTenant } = require("../../utils/tenant");
const { encrypt, decrypt } = require("../../utils/secretBox");
const { orgTaxTerms } = require("../../utils/countryRules");
const systemMailer = require("../core/systemMailer");
const { SupportRequest } = require("../../models/platform/supportRequestModel");
const { AssistantSettings, AssistantConversation, AssistantMessage, AssistantUsageDay } = require("../../models/modules/assistant/assistantModels");

// What we say when we will not answer. Each one is a plain sentence, because a person reading it is
// already mildly annoyed and a code would make it worse.
const WONT = {
  disabled: "Zarvia AI is switched off for your organisation.",
  dayCap: "Zarvia AI has answered as many questions as it can today for your organisation. It will work again tomorrow, and the team can still help you in the meantime.",
  personCap: "You have asked a lot of questions in the last hour, so Zarvia AI needs a short break. The team can still help you.",
  noAnswer: "I do not have anything reliable to tell you about that - it is not in the documentation I can read. Shall I pass it to the Zarvia team?",
  broke: "Something went wrong on my side, so I would rather say so than guess. Please try again, or let the team know.",
};

const MAX_QUESTION = prompt.MAX_QUESTION;

class AssistantService {
  /**
   * The organisation's settings, with the defaults the schema declares when it has none.
   *
   * The stored default provider is `echo`, which answers canned text and needs no account. That is
   * right for a test and wrong for a client: they would read a stub answer believing it was real.
   * So an organisation that has never chosen gets the real provider the moment a key exists, and
   * `testMode` says plainly when it does not - the same honesty as messaging's "Record only".
   */
  static async settings(companyId, { withKey = false } = {}) {
    const q = AssistantSettings.findOne({ companyId });
    const row = (await (withKey ? q.select("+apiKeyEnc") : q)) || new AssistantSettings({ companyId });
    row.provider = this.resolveProvider(row);
    return row;
  }

  /** The rule above, as a function, so it is a test rather than a database. */
  static resolveProvider({ providerChosen = false, provider = "echo", apiKeyEnc = "" } = {}, env = process.env) {
    if (providerChosen) return provider;
    return apiKeyEnc || env.ASSISTANT_API_KEY ? "anthropic" : "echo";
  }

  /** The key, if this organisation brought its own; otherwise ours from the environment. */
  static keyFor(settings) {
    if (settings.apiKeyEnc) {
      try {
        return decrypt(settings.apiKeyEnc);
      } catch {
        throw new AppError(
          "The saved AI service key cannot be read. Enter it again in Settings.",
          422,
          "SECRET_UNREADABLE"
        );
      }
    }
    return process.env.ASSISTANT_API_KEY || "";
  }

  /** Today in the ORGANISATION's calendar, which is the day a cap is measured against. */
  static today() {
    return orgLocale.today();
  }

  /**
   * Is there room to answer? Returns null when there is, or the reason there is not. Checked BEFORE
   * anything is spent, and a breach is always told to the person: a silent assistant reads as
   * broken, and they ring us instead, which is the opposite of the point.
   */
  static async room(settings, adminId, { now = new Date() } = {}) {
    if (!settings.enabled) return "disabled";
    const day = this.today();
    const spent = await AssistantUsageDay.aggregate([
      { $match: { day } },
      { $group: { _id: null, questions: { $sum: "$questions" }, tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } },
    ]);
    const used = spent[0] || { questions: 0, tokens: 0 };
    if (used.questions >= settings.dailyQuestionCap) return "dayCap";
    if (used.tokens >= settings.dailyTokenCap) return "dayCap";
    const anHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const mine = await AssistantMessage.countDocuments({ adminId, createdAt: { $gte: anHourAgo } });
    if (mine >= settings.perPersonHourlyCap) return "personCap";
    return null;
  }

  /**
   * One question, start to finish.
   *
   * The loop is deliberately short (settings.maxRounds, three by default). An assistant that can
   * search five times is not five times more useful; it is five times the cost and five times the
   * chance of talking itself into an answer the documentation does not support.
   */
  static async ask({ question, screen = "", screenName = "", errorCode = "", errorMessage = "", conversationId = "" } = {}, req) {
    const started = Date.now();
    const { companyId } = getTenant(req);
    const admin = req.admin || {};
    const adminId = String(admin._id || admin.id || "");
    const asked = String(question || "").trim().slice(0, MAX_QUESTION);
    if (!asked) throw new AppError("Ask a question first.", 400, "QUESTION_REQUIRED");

    const settings = await this.settings(companyId, { withKey: true });
    const blocked = await this.room(settings, adminId);
    if (blocked) {
      // Recorded, so a cap that bites often is visible rather than a mystery.
      await this.record({ settings, adminId, admin, asked, screen, errorCode, conversationId, outcome: "suppressed", reason: blocked, answer: WONT[blocked], started });
      return { answer: WONT[blocked], citations: [], links: [], outcome: "suppressed", reason: blocked, canEscalate: true };
    }

    const refusal = errorCode ? codes.explain(errorCode, { serverMessage: errorMessage }) : null;
    // Retrieval runs here, not in the tool, so the first turn already carries the topics: it saves
    // a whole round trip on the common case where the question is answerable straight away.
    const topics = corpus.pick(asked, { screen, limit: 4 });
    const ctx = toolkit.newContext({ screen });
    const { stable, context } = prompt.render({
      organisation: (req.organisation && (req.organisation.displayName || req.organisation.legalName || req.organisation.code)) || "",
      person: { name: admin.name || "", role: (admin.roleName || admin.roleKey || admin.type || "") },
      screen,
      screenName,
      taxWords: orgTaxTerms ? orgTaxTerms() : {},
      topics,
      refusal,
      screens: ctx.screens,
    });

    const provider = ai.providerFor(settings.provider);
    const key = provider.needsKey ? this.keyFor(settings) : "";
    const messages = [{ role: "user", content: prompt.wrapQuestion(asked) }];
    const toolCalls = [];
    let grounded = topics.length > 0;
    let text = "";
    let outcome = "answered";
    let reason = "";
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    for (let round = 0; round <= settings.maxRounds; round += 1) {
      let out;
      try {
        out = await provider.complete(
          { stable, context, messages, tools: toolkit.definitions(), model: settings.model, maxTokens: settings.maxOutputTokens, effort: settings.effort },
          { key }
        );
      } catch (err) {
        if (err.code === "PROVIDER_AUTH") {
          await AssistantSettings.updateOne({ companyId }, { $set: { lastAuthFailureAt: new Date(), lastErrorCode: err.code } }, { upsert: true });
        }
        outcome = "failed";
        reason = err.code || "PROVIDER_FAILED";
        text = WONT.broke;
        break;
      }
      for (const field of Object.keys(usage)) usage[field] += Number(out.usage?.[field] || 0);

      // stopReason is read BEFORE content: a refusal arrives as a normal response with none.
      if (out.stopReason === "refusal") {
        outcome = "no_answer";
        reason = "refused by the model";
        text = WONT.noAnswer;
        break;
      }
      const calls = (out.content || []).filter((b) => b.type === "tool_use");
      const said = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!calls.length) {
        text = said;
        break;
      }
      if (round === settings.maxRounds) {
        // It is still asking for tools and we are out of rounds. Say so rather than send whatever
        // half-thought it had reached.
        outcome = "no_answer";
        reason = "ran out of rounds";
        text = said || WONT.noAnswer;
        break;
      }
      const results = [];
      for (const call of calls) {
        const result = toolkit.run(call.name, call.input, ctx);
        toolCalls.push({ name: call.name, ok: result.ok });
        if (call.name === "search_help" && result.ok && result.data.found > 0) grounded = true;
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result.ok ? result.data : { error: result.error }) });
      }
      messages.push({ role: "assistant", content: out.content }, { role: "user", content: results });
    }

    // The grounding check, in code rather than in the prompt. If nothing from the documentation
    // ever reached the model and it still produced a substantive answer, that answer came from its
    // own memory of other accounting software - which will be confidently wrong about this one. We
    // keep what it said in `reason` for our own review and tell the person the honest thing.
    if (outcome === "answered" && !grounded && text.length > 160) {
      reason = `ungrounded answer withheld: ${text.slice(0, 500)}`;
      outcome = "no_answer";
      text = WONT.noAnswer;
    }
    if (outcome === "answered" && !text) {
      outcome = "no_answer";
      reason = "the model said nothing";
      text = WONT.noAnswer;
    }
    if (ctx.escalation) outcome = "escalated";

    const citations = topics.map((t) => ({ id: t.id, title: t.title }));
    const saved = await this.record({
      settings, adminId, admin, asked, screen, errorCode, conversationId,
      outcome, reason, answer: text, citations, links: ctx.links, usage,
      toolCalls, rounds: toolCalls.length, provider: settings.provider, model: settings.model, started,
      escalation: ctx.escalation,
    });

    // The assistant asked for a person. Done after the message is written, so the request can name
    // it, and the whole turn is still returned even if the hand-over itself fails.
    let supportRequestId = "";
    if (ctx.escalation) {
      try {
        const handed = await this.handOver(
          { question: ctx.escalation.question || asked, summary: ctx.escalation.summary, messageId: String(saved._id), screen, errorCode, citations, conversationId: String(saved.conversationId) },
          req
        );
        supportRequestId = handed.supportRequestId;
      } catch (err) {
        // Never swallow this silently in the answer: if we could not take the question, say so.
        text = `${text}

(I could not pass that on just now - please contact the team directly.)`;
      }
    }

    return {
      conversationId: String(saved.conversationId),
      messageId: String(saved._id),
      supportRequestId,
      answer: text,
      citations,
      links: ctx.links,
      outcome,
      // True while the stub provider is answering: the panel says so, because a canned answer that
      // looks real is worse than no assistant.
      testMode: settings.provider === "echo",
      // Offered whenever we did not actually answer, so the way out is always one tap away.
      canEscalate: outcome !== "answered" && !ctx.escalation,
      escalated: Boolean(ctx.escalation),
    };
  }

  /**
   * Hand a question to us. Called by the assistant's own ask_support tool and by the button a
   * person presses when the answer did not help.
   *
   * The row goes on the PLATFORM side, so it lands in one queue across every organisation - which
   * is the whole point, and the reason it carries the organisation's code rather than being scoped
   * to it. The mail is best effort: systemMailer never throws and never changes an answer, so a
   * mail server having a bad morning cannot lose the request.
   */
  static async handOver({ question, summary = "", messageId = "", screen = "", errorCode = "", citations = [], conversationId = "" } = {}, req) {
    const { companyId } = getTenant(req);
    const admin = req.admin || {};
    const org = req.organisation || {};
    const asked = String(question || "").trim().slice(0, MAX_QUESTION);
    if (!asked) throw new AppError("There is no question to pass on.", 400, "QUESTION_REQUIRED");

    // The few turns before this one, so whoever picks it up does not have to ask what happened.
    let transcript = [];
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      const rows = await AssistantMessage.find({ conversationId }).sort({ createdAt: -1 }).limit(4).select("question answer createdAt");
      transcript = rows.reverse().map((r) => ({ question: r.question, answer: r.answer, at: r.createdAt }));
    }

    const row = await SupportRequest.create({
      organisation: companyId,
      organisationName: org.displayName || org.legalName || "",
      adminId: String(admin._id || admin.id || ""),
      personName: admin.name || "",
      personEmail: admin.email || "",
      role: admin.roleName || admin.roleKey || admin.type || "",
      screen, errorCode,
      question: asked,
      aiSummary: String(summary || "").slice(0, 500),
      citations: (citations || []).map((c) => ({ title: c.title })).slice(0, 6),
      transcript,
      messageId: String(messageId || ""),
    });

    if (messageId && mongoose.isValidObjectId(messageId)) {
      await AssistantMessage.updateOne({ _id: messageId }, { $set: { supportRequestId: String(row._id) } });
    }
    this.notify(row).catch(() => {});
    return { supportRequestId: String(row._id) };
  }

  /** Tell us there is one waiting. Never awaited by the answer, and never able to fail it. */
  static async notify(row) {
    const to = process.env.SUPPORT_CONTACT || process.env.SUPPORT_EMAIL || "";
    if (!to) return { ok: false, provider: "none" };
    const lines = [
      `${row.personName || "Somebody"} at ${row.organisationName || row.organisation} asked:`,
      "",
      row.question,
      "",
      row.screen ? `Screen: ${row.screen}` : "",
      row.errorCode ? `They had just been refused with: ${row.errorCode}` : "",
      row.aiSummary ? `Zarvia AI's own summary: ${row.aiSummary}` : "",
      row.personEmail ? `Reply to: ${row.personEmail}` : "",
      "",
      `Organisation: ${row.organisation}`,
    ].filter(Boolean);
    return systemMailer.send({
      to,
      subject: `Zarvia AI could not answer: ${String(row.question).slice(0, 80)}`,
      text: lines.join("\n"),
    });
  }

  /** Write the turn: its conversation, its message, and what it cost. */
  static async record({ settings, adminId, admin = {}, asked, screen, errorCode, conversationId, outcome, reason = "", answer, citations = [], links = [], usage = null, toolCalls = [], rounds = 0, provider = "", model = "", started = Date.now(), escalation = null }) {
    const { companyId } = getTenant();
    let conversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      conversation = await AssistantConversation.findById(conversationId);
    }
    if (!conversation) {
      conversation = await AssistantConversation.create({
        companyId, adminId, personName: admin.name || "", role: admin.roleName || admin.roleKey || admin.type || "", screen,
      });
    }
    const costMicros = usage ? ai.costMicros(model, usage) : 0;
    const message = await AssistantMessage.create({
      companyId, conversationId: conversation._id, adminId,
      question: asked, answer: answer || "", citations, links, screen, errorCode,
      outcome, reason: String(reason || "").slice(0, 2000), rounds, toolCalls,
      provider, model, usage: usage || undefined, costMicros, ms: Date.now() - started,
    });
    await AssistantConversation.updateOne(
      { _id: conversation._id },
      { $inc: { questions: 1, escalations: escalation ? 1 : 0 }, $set: { lastAskedAt: new Date() } }
    );
    if (usage) await this.meter({ model, usage, outcome, costMicros });
    return { _id: message._id, conversationId: conversation._id };
  }

  /**
   * Add the turn to the day's rollup.
   *
   * Never inside a transaction: a duplicate key inside one aborts the whole transaction, and
   * catching it afterwards does not bring it back. Outside one a racing upsert can still collide,
   * so the collision is caught and retried exactly once.
   */
  static async meter({ model, usage, outcome, costMicros, attempt = 0 }) {
    const { companyId } = getTenant();
    const day = this.today();
    const inc = {
      questions: 1,
      escalations: outcome === "escalated" ? 1 : 0,
      failures: outcome === "failed" ? 1 : 0,
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      cacheReadTokens: Number(usage.cacheReadTokens || 0),
      costMicros: Number(costMicros || 0),
    };
    try {
      await AssistantUsageDay.updateOne({ day, model }, { $inc: inc, $setOnInsert: { companyId, day, model } }, { upsert: true });
    } catch (err) {
      if (err.code === 11000 && attempt === 0) return this.meter({ model, usage, outcome, costMicros, attempt: 1 });
      throw err;
    }
  }

  /** What an administrator may see of the settings: never the key itself, only that there is one. */
  static async publicSettings(companyId) {
    const s = await this.settings(companyId, { withKey: true });
    return {
      enabled: s.enabled, provider: s.provider, model: s.model, effort: s.effort,
      maxOutputTokens: s.maxOutputTokens, dailyQuestionCap: s.dailyQuestionCap,
      dailyTokenCap: s.dailyTokenCap, perPersonHourlyCap: s.perPersonHourlyCap, maxRounds: s.maxRounds,
      hasApiKey: Boolean(s.apiKeyEnc),
      usesOurKey: !s.apiKeyEnc && Boolean(process.env.ASSISTANT_API_KEY),
      lastAuthFailureAt: s.lastAuthFailureAt, lastErrorCode: s.lastErrorCode,
      models: Object.keys(ai.MODELS),
      corpus: corpus.stats(),
    };
  }

  /** Change them. A non-empty key replaces what is stored; omitting it keeps what is there. */
  static async saveSettings(body = {}, req) {
    const { companyId } = getTenant(req);
    const s = await this.settings(companyId, { withKey: true });
    const numbers = { maxOutputTokens: [256, 4096], dailyQuestionCap: [1, 20000], dailyTokenCap: [10000, 1e9], perPersonHourlyCap: [1, 1000], maxRounds: [1, 6] };
    if (body.provider !== undefined) {
      if (!ai.PROVIDERS[body.provider]) throw new AppError("That is not an AI provider we support.", 400, "PROVIDER_UNKNOWN");
      s.provider = body.provider;
      s.providerChosen = true;
    }
    if (body.model !== undefined) {
      if (!ai.isModel(body.model)) throw new AppError("That is not a model we support.", 400, "MODEL_NOT_SUPPORTED");
      s.model = body.model;
    }
    if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
    if (body.effort !== undefined) s.effort = body.effort;
    for (const [field, [lo, hi]] of Object.entries(numbers)) {
      if (body[field] === undefined) continue;
      const n = Number(body[field]);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new AppError(`${field} must be between ${lo} and ${hi}.`, 400, "SETTINGS_INVALID");
      s[field] = Math.round(n);
    }
    // Empty means "leave it alone", not "clear it" - the screen cannot show the key, so it cannot
    // send it back. `clearApiKey` is how somebody deliberately removes one.
    if (body.apiKey) s.apiKeyEnc = encrypt(String(body.apiKey).trim());
    if (body.clearApiKey) s.apiKeyEnc = undefined;
    s.companyId = companyId;
    await s.save();
    return this.publicSettings(companyId);
  }

  /** What a person said about an answer. A thumbs-down is the article backlog, so it is kept. */
  static async rate(messageId, helpful, req) {
    const admin = req.admin || {};
    const adminId = String(admin._id || admin.id || "");
    const row = await AssistantMessage.findOne({ _id: messageId, adminId });
    if (!row) throw new AppError("That answer was not found.", 404, "NOT_FOUND");
    row.helpful = helpful === null ? null : Boolean(helpful);
    await row.save();
    return { messageId: String(row._id), helpful: row.helpful };
  }

  /** A person's own history, newest first. Nobody reads anybody else's. */
  static async mine(req, { limit = 20 } = {}) {
    const admin = req.admin || {};
    const adminId = String(admin._id || admin.id || "");
    const rows = await AssistantMessage.find({ adminId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 20, 100))
      .select("question answer citations links outcome screen errorCode helpful createdAt conversationId");
    return rows;
  }

  /** What the assistant has cost and how often it could not answer. */
  static async usage(req, { from = "", to = "" } = {}) {
    const match = {};
    if (from) match.day = { ...(match.day || {}), $gte: String(from) };
    if (to) match.day = { ...(match.day || {}), $lte: String(to) };
    const days = await AssistantUsageDay.find(match).sort({ day: -1, model: 1 }).limit(400);
    const totals = days.reduce(
      (acc, d) => {
        for (const f of ["questions", "escalations", "failures", "inputTokens", "outputTokens", "cacheReadTokens", "costMicros"]) acc[f] += d[f] || 0;
        return acc;
      },
      { questions: 0, escalations: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0 }
    );
    const unanswered = await AssistantMessage.find({ outcome: { $in: ["no_answer", "escalated"] } })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("question screen outcome createdAt");
    return {
      days,
      totals,
      costPerQuestionMicros: totals.questions ? Math.round(totals.costMicros / totals.questions) : 0,
      // The questions it could not answer ARE the list of articles to write next.
      unanswered,
      corpus: corpus.stats(),
    };
  }
}

module.exports = AssistantService;
