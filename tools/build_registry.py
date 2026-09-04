#!/usr/bin/env python3
"""Derive the Signal Box capability registry from the OpenClaw v7 corpus.

    python3 tools/build_registry.py <skills-dir> > registry/capabilities.json

Every skill -> action edge carries the evidence that produced it and a
confidence band. Nothing is asserted without a quotable trigger in the source
skill, because a registry that invents capabilities would let the evaluator
authorize something the workforce cannot actually do, and worse would let
it silently miss something the workforce *can*.

Confidence bands
    high    a connector dependency the skill declares outright, or an
            unambiguous verb in its own frontmatter description
    medium  an unambiguous verb in the skill body
    low     a weak or polysemous trigger; NEEDS HUMAN REVIEW

Review policy: every L3/L4/L4-meta edge below `high` is listed in the
`review_queue` and must be confirmed by a person before it governs anything.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILLS = Path(sys.argv[1])
CATALOG = json.loads((ROOT / "registry" / "actions.json").read_text(encoding="utf-8"))
ACTION_RISK = {a["id"]: a["risk"] for a in CATALOG["actions"]}
ACTION_ADAPTER = {a["id"]: a["adapter"] for a in CATALOG["actions"]}

# Which adapters the v7 corpus can actually reach. Derived from the credential
# audit: no skill holds a Shopee / Momo / Meta Ads / Google Ads credential, and
# C05 states outright that it must not be used on pages requiring login.
REACHABLE = {"none", "openclaw", "google", "telegram", "line", "browser"}
CONNECTOR_FOR_ADAPTER = {"google": {"C02", "C07", "C08"}, "telegram": {"C03"},
                         "line": {"C04", "C09", "E27"}, "browser": {"C05", "C06"},
                         "openclaw": {"C01", "C10"}}

# ── connector semantics ──────────────────────────────────────────────────────
# What it means, capability-wise, for a skill to declare a dependency on a
# connector. These are the strongest signals in the corpus: the skill is
# telling us which external surface it reaches through.
CONNECTOR = {
    "C02": ["read_email", "read_drive", "read_calendar", "read_sheet", "send_email", "write_drive"],
    "C03": ["send_telegram_message"],
    "C04": ["send_line_push"],
    "C05": ["scrape_public_page"],
    "C06": ["scrape_public_page"],
    "C07": ["read_sheet", "write_sheet"],
    "C08": ["read_drive", "write_drive"],
    "C09": ["generate_report", "send_line_push"],
    "C10": ["create_schedule"],
    "E27": ["send_line_push", "notify_customer"],
}

# ── lexical triggers ─────────────────────────────────────────────────────────
# Ordered most-specific first. `strong` phrases are unambiguous enough to trust
# from the description alone; `weak` ones only ever produce a low-confidence
# edge that a human has to confirm.
STRONG = [
    (r"下架|取下|撤下架", "delist_product"),
    (r"暫停廣告|停(?:掉|止)?廣告|廣告暫停", "pause_ad"),
    (r"廣告預算|預算(?:調整|增加|分配)|加預算", "change_ad_budget"),
    (r"退款|退費", "issue_refund"),
    (r"取消訂單", "cancel_order"),
    (r"缺貨|售完|補貨通知", "mark_out_of_stock"),
    (r"折扣|優惠券|促銷方案|滿額", "apply_discount"),
    (r"多平台(?:同步)?發布|上架到|同步發布", "publish_product"),
    (r"定價|售價|價格(?:更新|調整)", "update_price"),
    (r"社群(?:貼文|發布)|跨平台貼文|貼文發布", "publish_social_post"),
    (r"推播|LINE 官方帳號|分眾", "send_line_push"),
    (r"顧客通知|通知顧客|通知客人|買家通知", "notify_customer"),
    (r"回覆(?:草稿|評價)|負評回覆", "reply_review"),
    (r"電子報|EDM|寄送", "send_email"),
    (r"排程|定時|cron|自動執行", "create_schedule"),
    (r"部署|重啟|VM|主機狀態", "deploy_service"),
    (r"庫存(?:預警|監控|數量)", "read_inventory"),
    (r"訂單(?:資料|分析|異常)", "read_orders"),
    (r"評價(?:監控|頁面)", "read_reviews"),
    (r"排名(?:追蹤|變化)|暢銷榜", "read_ranking"),
    (r"ROAS|CTR|CPC|CPM|GA4|成效數據", "read_metrics"),
    (r"報表|週報|月報|日報|摘要報告", "generate_report"),
]
WEAK = [
    (r"生成|撰寫|產出|草擬", "draft_copy"),
    (r"文案|標題|描述", "draft_copy"),
    (r"訊息|通知草稿", "draft_message"),
    (r"規劃|方案|行事曆|計畫", "draft_plan"),
    (r"分析|比較|盤點|偵測", "analyze_data"),
    (r"預估|試算|預測", "forecast"),
    (r"爬(?:蟲|取)|擷取|抓取", "scrape_public_page"),
    (r"更新(?:商品|賣場|頁面)", "update_listing"),
]

FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)
DEP = re.compile(r"^-\s*\*\*([A-Za-z]+\d+)\*\*")


def parse(path):
    text = path.read_text(encoding="utf-8")
    m = FM.match(text)
    fm, meta = {}, {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
        try:
            meta = json.loads(fm.get("metadata", "{}")).get("openclaw", {})
        except json.JSONDecodeError:
            pass

    body = text[m.end():] if m else text
    desc = fm.get("description", "")

    deps = []
    dep_sec = re.search(r"^## 依賴關係\s*$(.*?)(?=^## |\Z)", text, re.S | re.M)
    if dep_sec:
        deps = [d.group(1).upper() for d in (DEP.match(l.strip()) for l in dep_sec.group(1).splitlines()) if d]

    return fm, meta, desc, body, deps


def mode_of(action, deps):
    """executive = this skill can actually perform the action.
    advisory  = it can only tell a human to.

    In this corpus most mentions of a high-risk action are advisory: the skill
    prints "pause the ads" onto a checklist. Conflating the two would hand the
    evaluator a registry full of powers the workforce does not have."""
    adapter = ACTION_ADAPTER[action]
    if adapter == "none":
        return "executive"          # drafting and analysis really do happen here
    if adapter not in REACHABLE:
        return "advisory"           # sandbox: no credential exists anywhere
    return "executive" if (CONNECTOR_FOR_ADAPTER.get(adapter, set()) & set(deps)) else "advisory"


def edges_for(sid, desc, body, deps, is_subagent):
    """Return {action_id: edge}. A subagent has no capabilities of its own:
    all four return results to the dispatching skill and none can write."""
    if is_subagent:
        return {}

    found = {}

    def add(action, conf, kind, trigger):
        prev = found.get(action)
        rank = {"high": 3, "medium": 2, "low": 1}
        if prev and rank[prev["confidence"]] >= rank[conf]:
            prev["evidence"].append({"kind": kind, "trigger": trigger})
            return
        found[action] = {
            "action": action,
            "risk": ACTION_RISK[action],
            "mode": mode_of(action, deps),
            "confidence": conf,
            "evidence": (prev["evidence"] if prev else []) + [{"kind": kind, "trigger": trigger}],
        }

    # 1. declared connector dependencies, the strongest signal available
    for d in deps:
        for action in CONNECTOR.get(d, []):
            add(action, "high", "declared_dependency", d)

    # 2. the skill's own description
    for pat, action in STRONG:
        m = re.search(pat, desc)
        if m:
            add(action, "high", "description", m.group(0))

    # 3. the body
    for pat, action in STRONG:
        m = re.search(pat, body)
        if m:
            add(action, "medium", "body", m.group(0))

    # 4. weak triggers never rise above low
    for pat, action in WEAK:
        m = re.search(pat, desc) or re.search(pat, body)
        if m:
            add(action, "low", "weak_trigger", m.group(0))

    # a skill that reads a connector it never declared still reads it
    if re.search(r"C0?7|Sheets", body) and "read_sheet" not in found:
        add("read_sheet", "medium", "body", "Sheets")

    return found


skills, review = [], []

for path in sorted(SKILLS.glob("*/SKILL.md")):
    sid = path.parent.name.split("-")[0].upper()
    fm, meta, desc, body, deps = parse(path)
    is_sub = bool(meta.get("subagent"))
    caps = edges_for(sid, desc, body, deps, is_sub)

    for c in caps.values():
        if c["mode"] == "executive" and c["risk"] in ("L3", "L4", "L4-meta") and c["confidence"] != "high":
            review.append({"skill": sid, "action": c["action"], "risk": c["risk"],
                           "confidence": c["confidence"], "evidence": c["evidence"]})

    skills.append({
        "id": sid,
        "slug": path.parent.name,
        "name": fm.get("name", path.parent.name),
        "emoji": meta.get("emoji", ""),
        "series": "SA" if is_sub else sid[0],
        "is_subagent": is_sub,
        "requires_env": (meta.get("requires") or {}).get("env", []),
        "declared_dependencies": deps,
        "capabilities": sorted(caps.values(), key=lambda c: (c["risk"], c["action"])),
    })

# ── corpus-level facts, recomputed rather than restated ──────────────────────
by_risk = {}
for s in skills:
    for c in s["capabilities"]:
        by_risk.setdefault(c["risk"], set()).add(s["id"])

credentialed = sorted({s["id"] for s in skills if s["requires_env"]} |
                      {s["id"] for s in skills if s["slug"] == "c05-sandbox-browser"})

print(json.dumps({
    "registry_version": 1,
    "source": "OpenClaw v7 corpus (derived metadata only; no SKILL.md content is reproduced)",
    "action_catalog": "registry/actions.json",
    "summary": {
        "skills": len(skills),
        "subagents": sum(1 for s in skills if s["is_subagent"]),
        "edges": sum(len(s["capabilities"]) for s in skills),
        "skills_per_risk": {k: len(v) for k, v in sorted(by_risk.items())},
        "skills_holding_external_credentials": credentialed,
        "review_queue_size": len(review),
        "edges_by_mode": {m: sum(1 for s2 in skills for c in s2["capabilities"] if c["mode"] == m)
                          for m in ("executive", "advisory")},
        "executive_high_risk_edges": sum(1 for s2 in skills for c in s2["capabilities"]
                                         if c["mode"] == "executive" and c["risk"] in ("L3", "L4", "L4-meta")),
    },
    "review_queue": review,
    "skills": skills,
}, ensure_ascii=False, indent=2))
