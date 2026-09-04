# Capability Registry v1

What the workforce can actually do, derived from the OpenClaw v7 corpus (110 skills).

```
tools/build_registry.py  ──reads──▶  <v7>/skills/*/SKILL.md
                         ──writes─▶  registry/capabilities.json
registry/actions.json    ──────────  canonical action catalog (risk lives here)
```

**No SKILL.md content is reproduced.** Only derived metadata: skill id, action name, risk
level, declared dependencies, and the trigger phrase that produced each edge.

---

## Two ideas the registry is built on

**1 · Risk belongs to the action, not the skill.** One skill routinely spans an L1 read and
an L4 financial write. Attaching a single risk level to `E87` would be wrong in both
directions at once.

**2 · Advisory is not executive.** Most mentions of a high-risk action in this corpus are
*advisory*: the skill prints "pause the ads" onto a checklist for a human. Only a skill wired
to a connector that actually holds a credential is *executive*. Conflating the two hands the
evaluator a registry full of powers the workforce does not have, and worse, hides the ones
it does.

An edge is `executive` when the action's adapter is reachable **and** the skill declares the
connector for it. Everything else is `advisory`.

---

## Confidence and review

| Band | Source |
|---|---|
| `high` | a connector dependency the skill declares outright, or an unambiguous verb in its own frontmatter description |
| `medium` | an unambiguous verb in the skill body |
| `low` | a weak or polysemous trigger |

Every **executive** edge at L3/L4/L4-meta below `high` lands in `review_queue` and must be
confirmed by a person before it governs anything. Currently 9 entries, all `send_email`
inferred from the word "EDM" in the body. The open question is whether the skill sends
the newsletter or merely drafts it.

---

## What the corpus actually holds

Credential audit across all 110 skills:

| Reachable | Through | Skills declaring it |
|---|---|---|
| Google (Sheets / Gmail / Drive / Calendar / GA4) | `GOOGLE_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_ID` | C02, C07, C08 |
| Telegram | `TELEGRAM_BOT_TOKEN` | C03 |
| LINE | LINE Messaging API | C04, C09, E27 |
| Public web (read-only) | `browser.enabled` | C05, C06 |
| The host itself | OpenClaw native cron / VM control | C01, C10 |

**Not reachable by anything in the corpus:** Shopee, Momo, PChome, Yahoo, Amazon, Meta Ads,
Google Ads, any payment processor. No skill holds a credential for any of them, and C05
states outright that it must not be used on pages requiring login.

So `pause_ad`, `delist_product`, `update_price`, `cancel_order`, `issue_refund` and
`apply_discount` are **sandbox adapters**. The evaluator governing them is real; the effect
at the far end is simulated, and the UI says so.

---

## Findings

```
110 skills · 723 edges · 498 executive / 225 advisory
81 executive edges at L3 or above  ← the real governance surface
```

**The largest real risk in this workforce is not what it can do. It is what it can schedule.**

| Executive high-risk action | Skills |
|---|---|
| `create_schedule` (L4-meta) | **47** |
| `send_line_push` (L3) | 12 |
| `notify_customer` (L3) | 11 |
| `send_email` (L3) | 11 |
| everything else | 0 |

Two things follow, and both shaped the product:

**Scheduling is the escape hatch.** 47 of 110 skills can register a cron entry through C10.
Scheduling causes no effect itself. It manufactures the capacity to act later, unattended,
after the human who set the policy has gone home. A governance layer that only evaluates
direct actions is bypassed completely by *"run this at 8am tomorrow."* This is why the risk
scale carries an `L4-meta` band that a plain L0-L4 scale would have missed.

**Everything else the workforce can really do is talk to your customers.** Thirty-four
executive edges, all of them customer contact, none of them reversible. It cannot pause an ad
or issue a refund, but it can message your entire customer list, and that is the capability
the Hero Demo blocks. The demo's blocked action is the workforce's most dangerous *real*
power, not a dramatic hypothetical.

---

## Honest limits

- **Lexical derivation.** Edges come from trigger phrases, not from executing anything. The
  advisory/executive split removes the systematic error; individual edges can still be wrong,
  which is what `review_queue` and the evidence trail are for.
- **`cancel_order` has zero edges.** Nothing in the corpus can cancel an order. A policy may
  still *deny* it, since people deny things pre-emptively, but no action request for it should
  ever appear in a demo, because no skill would emit one.
- **Corpus version.** Built against v7 (2026-04): 92 E, 12 C, 2 D, 4 SA. An earlier count of
  13 C / 3 D was mentioned during planning and does not match this tree; if another version
  exists it must be merged before these numbers are quoted.
