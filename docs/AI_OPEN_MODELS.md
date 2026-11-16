# Running Zarvia AI on a free, open-source model

**Written 16 November 2026.** For whoever runs the server or an organisation's Settings page. Zarvia
AI (the in-app help assistant) talked to Claude only. It can now also talk to any **OpenAI-compatible**
service: Groq, OpenRouter, Together, DeepSeek, Mistral, or a self-hosted Ollama / vLLM / LM Studio.
Those are the services nearly every open-weight model (Qwen, Llama, gpt-oss, DeepSeek...) is served
through, so one adapter in `services/assistant/aiProviders.js` (provider `"openai"`) covers all of them.

**Nothing changes for an organisation that does not touch this.** Claude keeps working exactly as
before; this is an additional, cheaper path.

---

## What the assistant sends, and why a free tier is safe here

(This describes the assistant as it is by default. An organisation can also switch on **preparing
documents**, below, and then the names and amounts of the vendors, customers, items and bills a
question is about are sent too.)

Zarvia AI answers from the product's own help guides only. It reads no invoices, balances, or other
business records (`services/assistant/toolkit.js` has no database query at all - a test asserts it).
What leaves the building, per question: the question itself, the person's name and role, the
organisation's name, the screen they are on, and the help-guide text the search found. A free model's
terms that allow it to log or train on what is sent therefore expose far less than they would for a
normal AI feature. Still worth knowing before switching an organisation on.

## Two ways to set it up

### A. One free key for the whole installation (recommended to start)

Set these on the server (Render → Environment, or `.env` in development) and every organisation gets a
working, free assistant with nothing to configure on their side:

```
ASSISTANT_PROVIDER=openai
ASSISTANT_OPEN_BASE_URL=https://api.groq.com/openai/v1
ASSISTANT_OPEN_MODEL=openai/gpt-oss-120b
ASSISTANT_OPEN_API_KEY=gsk_...
```

An organisation that has never chosen a provider, and has no Claude key of its own, uses this
automatically. The Settings screen calls it "Zarvia's own free model". The key is only ever sent to
`ASSISTANT_OPEN_BASE_URL` - never to an address an organisation types in (see "How the keys are kept
apart" below).

### B. An organisation's own service

On Settings → Zarvia AI, with `settings.manage`:

1. Choose **Open model**.
2. Pick a ready-made starting point (Groq, OpenRouter, Ollama) or **Another OpenAI-compatible
   service**, and fill in or correct the address and model.
3. Paste the API key, if the service needs one.
4. Press **Test connection** - it runs one real question with a tool, and says plainly if the model
   cannot use tools at all (some small models cannot; better to find out here than from a client).
5. Save.

Changing the address forgets a stored key unless a new one is typed with it, so a key an organisation
saved for one service can never end up being sent to a different one by editing a box.

## Getting a free key

**Groq** (`console.groq.com`) - the recommended default: fast, and its free plan serves open models
(gpt-oss, Qwen) with roughly 1,000 questions a day per model, no card needed. Create a key under API
Keys, base address `https://api.groq.com/openai/v1`.

**OpenRouter** (`openrouter.ai`) - a wider choice of models, with any whose id ends `:free` free to use:
50 questions a day (1,000 after a one-time $10 top-up), no card needed to start. Base address
`https://openrouter.ai/api/v1`. The exact free model list changes often; check which currently support
tool calling before choosing one (not every `:free` model does).

**A self-hosted Ollama** - for an organisation that wants nothing to leave its own network. Needs a
machine with a GPU to be fast enough to be useful; a small Render instance cannot run one. Base address
`http://<that machine>:11434/v1`, no key. On the server, `ASSISTANT_ALLOW_PRIVATE_HOSTS=true` is needed
to let a production server point at a private address on purpose (otherwise addresses on the private
network are refused, as a guard against a mistake - see `utils/aiEndpoint.js`).

Limits above were checked on 16 November 2026 and rotate often (free model lists especially): check the
provider's own site before relying on a figure here.

## Which model to pick

For the tools this assistant uses (a help search, at most three rounds), the strongest open models at
tool calling in late 2026 are **gpt-oss-120b / gpt-oss-20b** and the **Qwen3 family** (8B upward).
**Llama 3.3 70B** is solid where it is still served. A model that fails the **Test connection** button's
tool-calling check will mostly have its answers withheld by the grounding check anyway (an answer with
no help topic behind it is never shown as if it were reliable) - so a model that cannot call
`search_help` is simply the wrong choice, not a safety problem.

For an Arabic-speaking organisation, **Qwen3** is the strongest general multilingual choice available
through these free routes. Arabic-first models exist (Falcon-H1 Arabic from TII in Abu Dhabi, Jais 3
from MBZUAI) but their tool-calling ability with this product's tools has not been checked.

## How the keys are kept apart

`AssistantSettings` keeps the open-model address, model and key (`openBaseUrl`, `openModel`,
`openApiKeyEnc`) entirely apart from Claude's (`apiKeyEnc`). `AssistantService.connection()`
(`services/assistant/assistantService.js`) is the one place that decides who answers and with what key:

- an organisation with its own address uses its own key, or none - **never** the installation's;
- the installation's own open-model key (`ASSISTANT_OPEN_API_KEY`) is sent **only** to the
  installation's own address (`ASSISTANT_OPEN_BASE_URL`).

So nobody with `settings.manage` can read the installation's free key off a request by pointing the
address at a server they control.

## Preparing payments, receipts, expenses and draft invoices

Off until an administrator switches it on (Settings, Zarvia AI, "Prepare payments and invoices"). Then a
person can type "pay Al Noor 5,000 by bank transfer", "Gulf Fresh paid us 2,000", "fuel 150 cash" or "invoice
Harbour Cafe 10 milk", and the assistant PREPARES it on a card in the chat.

**The assistant prepares; the person saves.** A prepared document is the exact body the product's own
route takes (`POST /vouchers/vouchers`, `POST /transactions/transactions`). The card's button posts it from the
person's own browser with their own sign-in, so everything that applies to a typed document applies: their
role, approval limits and the second approver, the period lock, reference numbers, bill allocation checks, plan
limits and the audit trail (labelled "prepared with Zarvia AI"). The assistant never saves, pays, posts or
approves anything. A payment, receipt or expense posts to the books the moment it is saved, which is why the
person's button, not the model, is the only thing that can do it. A sales invoice saves as a draft.

How it works (`services/assistant/actionTools.js`, `utils/assistantProposals.js`):

- Four tools, offered only when the organisation switched it on AND the person holds the keys (`finance.create`
  for payments, receipts and expenses, `sales.create` for invoices, plus the view right for the party). A
  Viewer is never offered them.
- The server does the work, so a small model needs one call: it finds the vendor or customer by name (an exact
  name beats a start beats a part; several equal matches are CHOICES, never a guess), the open bills (oldest
  settled first, the same as the voucher form), the cash or bank account, and the expense account.
- **The server writes the words that go with the card**, from the books. There is no second model call. A live run
  on the real model wrote "500" in pounds for a dirham payment when it phrased the answer itself; the amounts
  now come from the organisation's own currency, and it also halves the tokens.
- Cash, bank and bank transfer only. A cheque or a card payment needs more details than the card holds, so it
  points to the payment screen. A bank or transfer payment needs a reference, which the card asks for.
- "Change details" opens the normal payment, receipt or expense screen already filled in.
- Nothing is saved when it is prepared, and a card can be confirmed once (the answer remembers it).

## The free plan's real limit: tokens per minute

Measured live on 16 Nov 2026: Groq's free plan allows **8,000 tokens a minute** for gpt-oss-120b (the header
`x-ratelimit-limit-tokens` says so), and the request limit of 1,000 a day is the one people quote. The first
version sent about 3,900 tokens a round and took two rounds, so one question used the whole minute and the next
nine failed. Fixes, all in the code now: the server writes the answer after a prepared document (one round, not
two); an action-looking question carries one help topic instead of four; the preparing-documents rules are short;
gpt-oss is sent a `reasoning_effort` (its thinking counts against both max tokens and the minute); a rate limit
is answered "Zarvia AI is busy for a moment" with one short automatic retry. Measured after: about 2,700 tokens
and 2 seconds a question, ten in a row with no failures at 20 seconds apart. A busy organisation will still meet
the limit: that is what a paid key, or Claude, is for.

## Not built

- Streaming answers (the panel still waits for the whole answer, as it always has).
- A ready-made preset for Together, DeepSeek or Mistral specifically - "Another OpenAI-compatible
  service" covers them with a typed address.
- A per-provider cost table for open models (`costMicros` reads 0 for any model it does not know,
  which is the right answer for a free model, but a paid open-model host's figures are not priced in).
- Reading business data to answer questions ("what does Al Noor owe us?"). The only business data it touches is
  what it needs to prepare a document, and only when an administrator switched that on.
- Preparing a cheque or card payment, a credit note, a purchase bill or a document in a foreign currency.

## Tests

`services/__tests__/assistantProviders.test.js` (the adapter, pure, a fake `fetch`),
`utils/__tests__/aiEndpoint.test.js` (the address rules), `services/__tests__/assistantOpenHttp.test.js`
(a real server and a fake OpenAI-compatible service over HTTP: the installation default, an
organisation's own key never leaking to the installation's address or vice versa, the connection test,
a refused key). Frontend: `src/lib/__tests__/assistantSettingsForms.test.js`,
`src/components/Settings/__tests__/AssistantSettings.test.jsx`.
