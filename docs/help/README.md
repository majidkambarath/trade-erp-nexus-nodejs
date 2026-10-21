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

## Writing a topic by hand

The guides do not cover everything. 27 of the app's 63 screens are named by a topic; quotations,
the CRM, production, job work and process orders are in none of them, so the assistant correctly
says it has nothing written about those screens.

To close a gap, add a file named **`extra-<topic>.md`** with the same front matter. `build.sh`
removes only the generated `guide-*` and `accounting-*` files, so a hand-written one survives a
rebuild - which is the whole reason for the prefix. Set `source` to say it was written by hand and
when, since there is no guide behind it to correct.

Write it for the person using Zarvia, not for us: what the thing is, how it travels, what it will
not do. The `questions` list matters as much as the body - those are the words people type, and
they are what puts the topic in front of them.

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
