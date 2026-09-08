# Standing Order

**Your shop, watched while you are not looking, inside limits you said out loud.**

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)
(Sep 1-30, 2026).

**Live:** https://standing-order-joanna8521s-projects.vercel.app

---

## What it is for

You run a small shop. You already have software that could watch your takings,
your stock and your competitors. What you do not have is a way to let it act
while you are asleep without either trusting it completely or approving every
step yourself.

So you connect two things, once: the Google Sheet your daily takings live in,
and a few product pages you care about. Then you say one sentence out loud:

> "Watch my daily takings and tell me the moment they fall off a cliff. Never
> touch prices, never spend money on ads, and ask me before you tell any
> customer anything."

That sentence is not a command. It becomes the standing orders: three things
permitted, two forbidden, one held for you. It stays in force after you stop
talking, and it is what every agent is judged against from then on.

### A morning it has already happened

Overnight, seven agents read your sheet and the pages you gave them. You wake
up to one message on Telegram, and this on the screen:

```
Daily Revenue    30 rows read. 2 423 yesterday against 3 919 the week
                 before, down 38%.
Cross Check      On the same day: ad spend down 54%, orders down 33%.
                 Chilton Parka carried days in that week and is sold out on
                 the page being watched. Whether it was already gone that day
                 is not something these readings can say.
Ad Performance   Return on ad spend 6.47x, against 6.48x before. Unchanged.
Unit Economics   Each order leaves 221 after advertising. Yesterday: 214.

✓ ALLOW   send_telegram_message    you asked to be told
✓ ALLOW   pause_ad                 ads pointing at something nobody can buy
✓ ALLOW   delist_product           the listing should come down
✕ DENY    issue_refund             you said never
? ASK     notify_customer          you said ask first, so it is waiting
```

Note what did *not* happen: return on ad spend is 6.47x against 6.48x, and it
says so rather than finding a story in it. Most mornings look like that, which
is the point of having something read every day.

Nothing here was decided by a model. The readings are arithmetic over your own
numbers. The four verdicts are a deterministic evaluator comparing
each request to what you said. The refusal is not an opinion; it is the
sentence you spoke, still holding at four in the morning.

**The thing being sold is the last two lines.** Anyone can build agents that
act. The hard part is being able to say, a month later, exactly what they did,
what they wanted to do, and what stopped them.

---

## The problem

Agent governance has two shapes today, and both fail.

**Full autonomy.** The agent decides, the agent executes. Fast, and one day it delists the
wrong product, messages your entire customer list, or burns a day's ad budget before anyone
notices.

**Approve every step.** The agent proposes, a human clicks yes, forever. Safe, and it
throws away the reason you hired the agent.

The third shape is *authority with a lifetime*: a human states the boundaries out loud, and
agents operate autonomously inside them, **after the human has left the room**.

That last clause is the whole problem. When you stop talking, what happens to what you said?

---

## What this is

You speak. The speech does not become an *action*. It becomes a **policy**: a structured,
versioned artifact with a scope and a lifetime.

Some time later, agents you are not talking to emit actions. Every consequential one is
evaluated against that policy by deterministic code. Allowed ones proceed. Denied ones stop.
Ones the policy does not cover come back and ask you.

Then you amend the policy by voice, mid-flight, and the workforce resumes under v2.

```
  speech ──▶ Universal-3.5 Pro streaming ──▶ tool.call(compile_policy)
                                                      │
                                              ┌───────▼────────┐
                                              │  POLICY  STORE │  versioned, scoped
                                              └───────┬────────┘
                                                      │
  workforce ──▶ action request ──▶ evaluator ─────────┘
                                      │
                        ALLOW ────────┼──────── DENY / ASK
                          │                        │
                       adapter                  back to you
```

---

## Why not just gate the action?

The interesting failure is not *"did you really say five hundred?"* It is
*"you said five hundred, we transcribed it perfectly, and it is still not allowed, because
this morning you said nothing over five thousand today."*

Provenance and authority are different layers. A serious system wants both. This one is the
authority layer.

---

## Status

What exists today, and what each thing actually touches:

| | |
|---|---|
| **Action catalogue** | 38 canonical actions, risk L0-L4 plus `L4-meta` |
| **Capability registry** | 110 skills → 723 typed edges, executive vs advisory separated |
| **Policy evaluator** | deterministic; every default points away from ALLOW |
| **Voice → policy** | tool schemas generated from the registry, validated server-side |
| **Workforce** | 36 agents across 10 departments, **18 of them built and running** |
| **Real sources** | a shared Google Sheet, public storefront pages, Telegram out |
| **Cross-source diagnosis** | lines a fall in the takings up against stock and rival prices |
| **Ledger** | append-only, per workspace, 90 days, separate from the session |
| **Plans and usage** | four meters that genuinely refuse when an allowance runs out |
| **MCP server** | 22 tools, dependency-free, stdio |
| **Tests** | 118, no dependencies |

Built and described are drawn differently everywhere, including in the interface.
Eighteen agents will really go and look; the other eighteen say they are
descriptions rather than pretending otherwise.

---

## The run that mattered

2026-09-04, one microphone, one browser, one policy spoken aloud in three
sentences with pauses between them.

```
"Pause all the Meta and Google ads."
"You can delist on Shopee and mark the website out of stock."
"But don't notify customers, don't cancel any orders, and don't issue refunds."
                                                    -> P-0001 v2, six rules

  notify_customer   DENY   L3       real      explicitly denied by human authorization
  issue_refund      DENY   L4       sandbox   explicitly denied by human authorization
  create_schedule   ASK    L4-meta  real      L4-meta is never assumed

"Actually, you can notify the 14 paid customers, but still no cancellations
 and no refunds."                                   -> P-0001 v3

  notify_customer {customer_group: paid}      ALLOW  conditions satisfied
  notify_customer {customer_group: all}       ASK    outside the authorized range
  notify_customer {customer_group: everyone}  ASK    outside the authorized range
  issue_refund                                DENY   unchanged by the amendment
```

The same action, the same policy, a different verdict, because a person said one
more sentence. And permission for fourteen people stayed permission for fourteen
people.

Four faults surfaced across that session and the one after it, and all are fixed. Turn detection ended the
turn after 1000 ms of silence, which is shorter than the pause between clauses
when someone dictates a list. A second compile replaced the first instead of
merging, so a rule spoken in the opening sentence disappeared. And, having heard
only half, the agent said it had recorded rules that were not in the policy. The
last one is the one worth naming: nothing had executed, because unmatched L4
resolves to ASK, but the sentence was false when it was said, and a governance
system that misreports its own state has failed at its only job.

---

## What the registry found

The workforce being governed is a real one: 110 OpenClaw commerce skills, already running.
Building the registry against it produced a result that changed the product:

```
110 skills · 723 edges · 498 executive / 225 advisory
 81 executive edges at L3 or above  ← the real governance surface
```

| Executive high-risk action | Skills that can perform it |
|---|---|
| `create_schedule` (L4-meta) | **47** |
| `send_line_push` (L3) | 12 |
| `notify_customer` (L3) | 11 |
| `send_email` (L3) | 11 |
| everything else | **0** |

**The largest real risk is not what the workforce can do. It is what it can schedule.**
Scheduling causes no effect itself. It manufactures the capacity to act later, unattended,
after the human who set the policy has gone home. A governance layer that only evaluates
direct actions is bypassed completely by *"run this at 8am tomorrow."* Hence `L4-meta`, a
band a plain L0-L4 scale would have missed.

Details and method: [`registry/README.md`](registry/README.md).

---

## Honest boundaries

Stated here rather than buried, because a governance project that overstates its own reach
has failed at the thing it claims to be about.

- **Most high-risk adapters are sandboxed.** A credential audit of all 110 skills found that
  **none** holds a credential for Shopee, Momo, PChome, Amazon, Meta Ads, Google Ads, or any
  payment processor. So `pause_ad`, `delist_product`, `issue_refund` and friends run against
  sandbox adapters. The evaluator governing them is real; the effect at the far end is
  simulated, and the UI labels every action `real` or `sandbox` on its face.
- **Real adapters** are Google (Sheets / Gmail / Drive / Calendar), Telegram, LINE, a
  read-only browser, and the host's own scheduler.
- **The registry is lexically derived**, not executed. Edges carry their evidence and a
  confidence band; low-confidence high-risk edges sit in a review queue until a person
  confirms them.
- **No unmeasured numbers.** Where a figure has not been measured, this repository says so
  rather than printing a plausible one.
- **Nothing is charged.** There are plans and there are four meters, and the
  meters genuinely refuse: over the source allowance and the next one is
  declined with the number and the reset date. But no payment is taken anywhere,
  the plan is chosen rather than bought, and the page says so. What the meters
  are for is the claim that this could be a service, made with counts rather
  than a pricing page.
- **One thing never degrades.** An allowance can stop an agent going out and can
  stop a message leaving. It can never stop a request being judged or written
  down, and a test holds that by reading the source: `decide()` reaches a verdict
  and records it before anything is metered, and does not consult an allowance at
  all. A refusal that failed to happen because of billing is the one failure this
  must not have.
- **A retraction.** An earlier version of this file said a model cannot express a capability
  the workforce does not have, because the tool schema has no member for it. That was an
  assumption and it is false. The API stores whatever JSON Schema it is sent, including
  keywords it does not implement, and passes it to the model as advice; a live run produced
  a condition value from outside a six-member enum without complaint. The schema shapes what
  the model tends to say. What actually holds is server-side validation in
  `governance/validate.js`, which refuses anything the registry does not declare and hands it
  back with a reason so the agent asks instead of guessing.

---

## Measured, not assumed

Three things about the Voice Agent API that are not in its documentation and
that cost a day each to find. Written down here because the next person should
not have to.

**A tool with three parameters is never called.** Not refused - never called.
The reply completes, empty, and the agent carries on talking as though it had
acted. There is no error, no `session.error`, nothing in the transcript. The
API takes no text input, so establishing this meant synthesising the same
sentence and streaming it in as audio about eighty times:

```
{ brief }                    called   3 of 3
{ brief, needs }             called   5 of 5
{ brief, needs, anything }   called   0 of 11
```

So a rule here is not an object of action, effect and conditions. The effect is
the name of the tool: `forbid`, `ask_first`, `permit`, each taking one list.

**A free-form parameter changes behaviour, not just output.** Given a parameter
with no enum, the agent stops and asks the user what to put in it - "which
product?", "what percentage?" - instead of calling anything. Constrained ones it
simply fills. Every parameter here is an enum except the brief.

**The schema is advice.** The API stores whatever JSON Schema it is sent,
including keywords it does not implement, and a live run produced a condition
value from outside a six-member enum without complaint. `governance/validate.js`
is what actually holds; the enum only shapes what the model tends to say.

A fourth, cheaper: `type: "function"` is mandatory on every tool and its absence
is reported as `invalid_value` with a null `param`. And `turn_detection` silently
drops keys it does not know, so a mis-spelled option looks like it applied.

---

## Not in this repository

The skill packs themselves are not here. What is here is derived metadata about
them: ids, groups, action names, risk levels, dependency edges, and which
connectors each one asks for. That is the shape of the graph, which is what a
registry needs.

Descriptions used to be included and were taken back out. A skill's description
is its trigger phrasing - the sentences somebody says to invoke it - which is
the material itself in miniature, and nothing in this project ever read them.

---

## Running it

```sh
cp .env.example .env      # then fill in the AssemblyAI key
npm start                 # http://localhost:8787
npm test                  # 118 tests, no dependencies
```

Everything except the voice connection works without a key: the policy, the
evaluator, the adapters and the audit trail all run offline.

### As an MCP server

Standing Order governs whatever speaks MCP. Point a client at `mcp/server.js` and the
workforce's consequential actions appear as tools, each one judged before it runs.

```json
{ "mcpServers": { "standing-order": {
    "command": "node", "args": ["mcp/server.js"],
    "env": { "STANDING_ORDER_URL": "http://localhost:8787" } } } }
```

Ask it to issue a refund. It will not, and it will tell you why, and it will tell
you that it cannot grant itself the permission.

### Deployment notes

The handler in `server/app.js` is shared by the local server and the Vercel
function, so there is one routing table rather than two that agree until they do
not.

State is per session and the store is chosen from configuration:
`governance/store.js` uses memory when it is the only process and a KV store when
`KV_REST_API_URL` is set. On serverless the memory store appears to work, because
consecutive requests often land on the same warm instance, and then fails on a
cold start or under any concurrency. Intermittent is worse than broken: it passes
a rehearsal and dies in front of an audience.

---

## Licence

MIT. See [`LICENSE`](LICENSE).
