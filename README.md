# Signal Box

**Voice-compiled policy for an AI commerce workforce.**

> One sentence, spoken once, governs a workforce that keeps running after you stop talking.

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)
(Sep 1–30, 2026).

---

## The problem

Agent governance has two shapes today, and both fail.

**Full autonomy** — the agent decides, the agent executes. Fast, and one day it delists the
wrong product, messages your entire customer list, or burns a day's ad budget before anyone
notices.

**Approve every step** — the agent proposes, a human clicks yes, forever. Safe, and it
throws away the reason you hired the agent.

The third shape is *authority with a lifetime*: a human states the boundaries out loud, and
agents operate autonomously inside them — **after the human has left the room**.

That last clause is the whole problem. When you stop talking, what happens to what you said?

---

## What this is

You speak. The speech does not become an *action* — it becomes a **policy**: a structured,
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

Because the interesting failure is not *"did you really say five hundred?"* — it is
*"you said five hundred, we transcribed it perfectly, and it is still not allowed, because
this morning you said nothing over five thousand today."*

Provenance and authority are different layers. A serious system wants both. This one is the
authority layer.

---

## Status

Early. What exists today:

| | |
|---|---|
| **Capability registry** | ✅ 110 skills → 723 typed edges, derived from a real corpus |
| **Action catalog** | ✅ 36 canonical actions, risk levels L0–L4 plus `L4-meta` |
| **Governance canvas** | ✅ interactive prototype (`prototype/`) |
| **Policy evaluator** | ⏳ next |
| **Voice → policy compiler** | ⏳ next |
| **End-to-end with a real microphone** | ⏳ the milestone that matters |

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
Scheduling causes no effect itself — it manufactures the capacity to act later, unattended,
after the human who set the policy has gone home. A governance layer that only evaluates
direct actions is bypassed completely by *"run this at 8am tomorrow."* Hence `L4-meta`, a
band a plain L0–L4 scale would have missed.

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

---

## Not in this repository

The OpenClaw v7 skill corpus itself is paid course material and is **not** included. Only
derived metadata about it — skill ids, action names, risk levels, dependency edges, and the
trigger phrase behind each edge — which is what the registry needs and all it needs.

---

## Licence

MIT. See [`LICENSE`](LICENSE).
