#!/usr/bin/env python3
"""Parse the OpenClaw v7 skill corpus into a structured capability graph.

Input : a directory of <skill-id>/SKILL.md files
Output: registry JSON on stdout

This reads the legacy Chinese corpus purely as *evidence*: it extracts the
declared dependency graph and connector usage so we can see which skills can
actually reach the outside world, and through what.
"""
import json, re, sys
from pathlib import Path

SKILLS = Path(sys.argv[1])

FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)
DEP = re.compile(r"^-\s*\*\*([A-Za-z]+\d+)\*\*\s*(.+?)\s*(?:—|--|-)\s*(.*)$")
REF = re.compile(r"\b([CDE])(\d{2})\b")


def frontmatter(text):
    m = FM.match(text)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def section(text, heading):
    """Return the body of a '## <heading>' section."""
    pat = re.compile(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", re.S | re.M)
    m = pat.search(text)
    return m.group(1) if m else ""


def parse(path):
    text = path.read_text(encoding="utf-8")
    fm = frontmatter(text)

    meta = {}
    if "metadata" in fm:
        try:
            meta = json.loads(fm["metadata"]).get("openclaw", {})
        except json.JSONDecodeError:
            pass

    deps = []
    for line in section(text, "依賴關係").splitlines():
        m = DEP.match(line.strip())
        if m:
            deps.append({"ref": m.group(1).upper(), "name": m.group(2), "why": m.group(3)})

    # every skill id mentioned anywhere in the body, minus self
    sid = path.parent.name
    prefix = sid.split("-")[0].upper()
    mentions = sorted({f"{a}{b}" for a, b in REF.findall(text)} - {prefix})

    requires = meta.get("requires", {}) or {}

    return {
        "id": prefix,
        "slug": sid,
        "name": fm.get("name", sid),
        "description": fm.get("description", ""),
        "emoji": meta.get("emoji", ""),
        "user_invocable": fm.get("user-invocable") == "true",
        "always_on": bool(meta.get("always")),
        "is_subagent": bool(meta.get("subagent")),
        "subagent_type": meta.get("type"),
        "requires_env": requires.get("env", []),
        "requires_config": requires.get("config", []),
        "declared_dependencies": deps,
        "mentions": mentions,
        "bytes": len(text.encode("utf-8")),
    }


skills = sorted((parse(p) for p in SKILLS.glob("*/SKILL.md")), key=lambda s: s["id"])
print(json.dumps({"skills": skills}, ensure_ascii=False, indent=2))
