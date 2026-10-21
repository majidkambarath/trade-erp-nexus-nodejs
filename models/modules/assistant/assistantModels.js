// Zarvia AI: the settings, the questions people asked, and what it cost.
//
// All four are organisation-wide and NOT branch scoped. A question about how a screen works is not
// a document belonging to a branch, and a person who moves branch does not want their own history
// to disappear. Shaped like models/modules/messagingModels.js, including the write-only key.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

const PROVIDERS = ["echo", "anthropic"];
const EFFORTS = ["low", "medium", "high"];
// What a message is. A question and its answer are ONE row: they are read together, they are
// scored together (the thumbs), and there is no state in which one exists without the other.
const OUTCOMES = ["answered", "no_answer", "escalated", "suppressed", "failed"];

const settingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    provider: { type: String, enum: PROVIDERS, default: "echo" },
    // Write-only, encrypted with utils/secretBox.js, never returned by the API. Normally unset:
    // we pay for this, so the key lives in the environment. The field exists for a large client
    // who wants their own account.
    apiKeyEnc: { type: String, select: false },
    model: { type: String, default: "claude-opus-5-5" },
    effort: { type: String, enum: EFFORTS, default: "medium" },
    maxOutputTokens: { type: Number, default: 1024, min: 256, max: 4096 },
    // The brakes. These are OURS, not the client's plan: the assistant exists to cut our support
    // load, so the cap is a guard against a runaway bill rather than something we sell.
    dailyQuestionCap: { type: Number, default: 300, min: 1, max: 20000 },
    dailyTokenCap: { type: Number, default: 2_000_000, min: 10_000 },
    perPersonHourlyCap: { type: Number, default: 40, min: 1, max: 1000 },
    maxRounds: { type: Number, default: 3, min: 1, max: 6 },
    lastAuthFailureAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: "" },
  },
  { timestamps: true }
);

const conversationSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    adminId: { type: String, required: true, index: true },
    personName: { type: String, default: "" },
    role: { type: String, default: "" },
    // Where it started. A conversation can wander, but the first screen is what the question was
    // usually about, and it is what the analysis groups by.
    screen: { type: String, default: "" },
    questions: { type: Number, default: 0 },
    escalations: { type: Number, default: 0 },
    lastAskedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const messageSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AssistantConversation", required: true },
    adminId: { type: String, required: true },
    question: { type: String, required: true, maxlength: 2200 },
    answer: { type: String, default: "", maxlength: 8000 },
    // Where the answer came from, by topic title. This is what the panel shows under an answer and
    // what makes a wrong answer traceable to the documentation that caused it.
    citations: [{ _id: false, id: String, title: String }],
    links: [{ _id: false, path: String, label: String }],
    screen: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    outcome: { type: String, enum: OUTCOMES, default: "answered" },
    reason: { type: String, default: "" },
    rounds: { type: Number, default: 0 },
    toolCalls: [{ _id: false, name: String, ok: Boolean }],
    provider: { type: String, default: "" },
    model: { type: String, default: "" },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      cacheReadTokens: { type: Number, default: 0 },
    },
    costMicros: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
    // null until somebody says. A thumbs-down is the article backlog, so it is worth a column.
    helpful: { type: Boolean, default: null },
    supportRequestId: { type: String, default: "" },
  },
  { timestamps: true }
);

const usageDaySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    // "YYYY-MM-DD" in the ORGANISATION's own zone, like CrmActivity.dueAt: a question asked at
    // 01:00 in Dubai belongs to that day there, not to the previous one in UTC.
    day: { type: String, required: true },
    model: { type: String, required: true },
    questions: { type: Number, default: 0 },
    escalations: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    costMicros: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Declared with schema.index so tenantPlugin's leadIndexes puts companyId in front of each one: a
// day is unique within an organisation, not across the installation.
conversationSchema.index({ adminId: 1, lastAskedAt: -1 });
conversationSchema.index({ lastAskedAt: -1 });
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ createdAt: -1 });
messageSchema.index({ helpful: 1, createdAt: -1 });
messageSchema.index({ outcome: 1, createdAt: -1 });
usageDaySchema.index({ day: 1, model: 1 }, { unique: true });

settingsSchema.plugin(tenantPlugin);
conversationSchema.plugin(tenantPlugin, { leadIndexes: true });
messageSchema.plugin(tenantPlugin, { leadIndexes: true });
usageDaySchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = {
  PROVIDERS,
  EFFORTS,
  OUTCOMES,
  AssistantSettings: mongoose.model("AssistantSettings", settingsSchema),
  AssistantConversation: mongoose.model("AssistantConversation", conversationSchema),
  AssistantMessage: mongoose.model("AssistantMessage", messageSchema),
  AssistantUsageDay: mongoose.model("AssistantUsageDay", usageDaySchema),
};
