#!/usr/bin/env python3
"""Survey every industry corpus at once and write the derived index.

    python3 tools/build_corpus.py > registry/corpus.json

Four separate OpenClaw skill packs exist, one per industry, and they do not
share a directory shape: two are flat, one nests packs two deep, one groups by
discipline. So this walks recursively and de-duplicates on the declared name
rather than on where the file happened to sit, because the same skill appears in
several versioned copies of the same pack.

Only derived metadata leaves this script. The packs are paid course material and
their contents never enter the repository; what does is the id, the one-line
description, the declared dependencies and which connectors a skill asks for.
That is what a registry needs and all it needs.
"""
import io, json, re, sys, collections
from pathlib import Path

BASE = Path.home() / 'Desktop' / '大龍蝦'

SOURCES = {
    'commerce':      BASE / '電商/202604版本/openclaw_ecom_v7/skills',
    'media':         BASE / '自媒體/Code/openclaw_media_repo_final/skills',
    'manufacturing': BASE / '製造外貿/openclaw_mfg_repo/skills',
    'construction':  BASE / '營建業-機電工程/Code/openclaw_715_FINAL',
}

FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)
DEP = re.compile(r"^-\s*\*\*([A-Za-z]+\d+)\*\*")


def frontmatter(text):
    m = FM.match(text)
    if not m:
        return {}, {}
    fields = {}
    for line in m.group(1).splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            fields[k.strip()] = v.strip()
    try:
        meta = json.loads(fields.get('metadata', '{}')).get('openclaw', {})
    except json.JSONDecodeError:
        meta = {}
    return fields, meta


def dependencies(text):
    section = re.search(r"^## 依賴關係\s*$(.*?)(?=^## |\Z)", text, re.S | re.M)
    if not section:
        return []
    out = []
    for line in section.group(1).splitlines():
        m = DEP.match(line.strip())
        if m:
            out.append(m.group(1).upper())
    return out


industries = {}
everything = {}

for industry, root in SOURCES.items():
    if not root.exists():
        print(f"missing: {root}", file=sys.stderr)
        continue

    skills, groups = {}, collections.Counter()

    for path in sorted(root.rglob('SKILL.md')):
        text = path.read_text(encoding='utf-8', errors='replace')
        fields, meta = frontmatter(text)

        sid = fields.get('name') or path.parent.name
        if sid in skills:
            continue                      # a second copy of the same pack

        # The folder above the skill is its discipline in the packs that group,
        # and simply "skills" in the packs that do not.
        group = path.parent.parent.name
        groups[group] += 1

        requires = (meta.get('requires') or {})
        skills[sid] = {
            'id': sid,
            'industry': industry,
            'group': group,
            'description': fields.get('description', '')[:400],
            'emoji': meta.get('emoji', ''),
            'always_on': bool(meta.get('always')),
            'is_subagent': bool(meta.get('subagent')),
            'requires_env': requires.get('env', []),
            'requires_config': requires.get('config', []),
            'dependencies': dependencies(text),
        }

    industries[industry] = {
        'skills': len(skills),
        'groups': dict(groups.most_common()),
        'credentialed': sorted({s['id'] for s in skills.values() if s['requires_env'] or s['requires_config']}),
    }
    everything.update({f'{industry}/{k}': v for k, v in skills.items()})

print(json.dumps({
    'source': 'OpenClaw industry skill packs (derived metadata only; no SKILL.md content)',
    'summary': {
        'industries': len(industries),
        'capabilities': len(everything),
        'per_industry': {k: v['skills'] for k, v in industries.items()},
    },
    'industries': industries,
    'capabilities': everything,
}, ensure_ascii=False, indent=2))
