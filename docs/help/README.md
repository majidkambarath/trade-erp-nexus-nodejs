# The help corpus

What Zarvia AI answers from. Every file here is one help topic, and **a client can be shown any
word of it**, so nothing in this folder may name a file, a service, a test, a bug or a decision.

Generated from the Word guides in `docs/help-source/` by `scripts/help/build.sh` — do not hand-edit
a topic file: edit the guide (or `scripts/help/meta-*.json`) and rebuild, or the next rebuild
silently throws the edit away.

## Front matter

| Field | Meaning |
| --- | --- |
| `title` | What the topic is called. Shown as the citation under an answer |
| `audience` | `client` (may be served) or `internal` (**never** served; kept for our own reference) |
| `source` | Which guide and section it came from, so a correction can be made at the source |
| `screens` | The app paths this topic is about. Used to pick topics for the screen the person is on, and to offer them a link |
| `questions` | The phrasings people actually use. These are the retrieval keys — adding a real question someone asked is the cheapest way to improve an answer |
| `review` | Present when the topic is known to be out of date. **A topic carrying `review` is still served**: the flag is a note to us, not a filter, because a mostly-right answer beats no answer. Clear it when the guide is corrected |

## The two rules that keep this safe to serve

1. **`audience: client` only.** The loader reads nothing else, and never reaches `CLAUDE.md`,
   `DOCUMENTATION.md` or `docs/ERP_FEATURE_SPEC.md`, all of which are written for developers and
   name internals, open bugs and decisions. A test pins this.
2. **No code references.** The source guides cite the code and its tests on purpose ("every
   statement names the key, function or test it relies on"). `scripts/help/declassify.py` strips
   those, and `build.sh` **refuses to finish** if any survive. Posting keys (`vat-sales`, `cogs`)
   are deliberately kept — they are configuration names a client sees in Accounting setup.

## Known staleness (21 Oct 2026)

The guides were written on 5 October and have not caught up with what shipped since. Nine topics
carry a `review` note. The ones that matter most:

- **Roles and access (guide 3.1-3.3)** describe a system where "the menu carries role lists but
  they are not applied". Wrong: permissions, approval limits, roles per branch and two-factor are
  all live and enforced by the server.
- **Order to cash (guide 4.5)** and **Procure to pay (4.4)** predate the Orders -> Delivery notes /
  Goods received -> Invoices flow, and say the Send button "only shows a message" — it now really
  emails the customer the PDF and a link.
- **The roadmap (guide 8.x)** is `audience: internal` on purpose. A status promise made to a client
  by an assistant is a commitment nobody authorised, and several of its rows are now false.
- Nothing in the corpus mentions the CRM, production, job work or process orders at all.

Correcting the guides is the single highest-value thing anyone can do for answer quality.
