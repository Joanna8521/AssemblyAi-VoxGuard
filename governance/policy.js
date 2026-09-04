/**
 * The policy: what a human authorized, as a structured artifact with a lifetime.
 *
 * A policy is deliberately *not* a transcript, a prompt, or anything a model
 * reads. It is data. The voice layer produces it; the evaluator consumes it;
 * nothing in between is asked to interpret intent again.
 */

/** Scopes, longest-lived last. */
export const SCOPES = ['mission', 'session', 'organization'];

export const EFFECTS = ['ALLOW', 'DENY', 'ASK'];

let seq = 0;

/**
 * Compile a fresh policy.
 *
 * `rules` arrive already structured, from a `compile_policy` tool call whose
 * JSON Schema is what guarantees the shape. Nothing here parses language.
 */
export function compile({ missionId, scope = 'mission', rules = [], spokenIn = null, at = null }) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  for (const r of rules) assertRule(r);

  return {
    policyId: `P-${String(++seq).padStart(4, '0')}`,
    missionId,
    scope,
    version: 1,
    /** Which language it happened to be spoken in. Recorded, never consulted. */
    spokenIn,
    createdAt: at,
    rules: rules.map(normalizeRule),
    history: [{ version: 1, change: 'compiled', at }],
  };
}

/**
 * Amend an existing policy rather than replacing it.
 *
 * This is the difference the whole product turns on. "Notify those 14 paid
 * customers" is an edit to a standing authorization, not a new mission, so the
 * version increments, the audit trail stays attached, and anything already
 * evaluated under v1 keeps its recorded verdict.
 */
export function amend(policy, changes = [], { at = null } = {}) {
  for (const c of changes) assertRule(c);

  const rules = policy.rules.map((r) => ({ ...r }));
  const applied = [];

  for (const change of changes.map(normalizeRule)) {
    const i = rules.findIndex((r) => r.action === change.action);
    if (i === -1) {
      rules.push(change);
      applied.push({ action: change.action, from: null, to: change.effect });
    } else {
      applied.push({ action: change.action, from: rules[i].effect, to: change.effect });
      rules[i] = change;
    }
  }

  return {
    ...policy,
    version: policy.version + 1,
    rules,
    history: [...policy.history, { version: policy.version + 1, change: 'amended', applied, at }],
  };
}

/**
 * A stable fingerprint of what the policy *authorizes*, ignoring everything
 * about how it was produced: id, version, timestamps, and the language it was
 * spoken in.
 *
 * Two people stating the same boundaries in Mandarin, English and Japanese
 * produce three different transcripts and one fingerprint. That is the claim
 * the trilingual demo makes, and this function is what makes it checkable
 * rather than asserted.
 */
export function fingerprint(policy) {
  const canonical = policy.rules
    .map((r) => `${r.action}:${r.effect}:${stableJson(r.conditions)}:${r.otherwise ?? ''}`)
    .sort()
    .join('\n');
  return fnv1a(canonical);
}

export function findRule(policy, action) {
  return policy.rules.find((r) => r.action === action) ?? null;
}

// ── internals ───────────────────────────────────────────────────────────────

function assertRule(r) {
  if (!r || typeof r.action !== 'string' || !r.action) throw new Error('rule needs an action');
  if (!EFFECTS.includes(r.effect)) throw new Error(`rule ${r.action}: bad effect ${r.effect}`);
  if (r.otherwise && !EFFECTS.includes(r.otherwise)) {
    throw new Error(`rule ${r.action}: bad otherwise ${r.otherwise}`);
  }
}

function normalizeRule(r) {
  return {
    action: r.action,
    effect: r.effect,
    conditions: r.conditions ?? null,
    // What to do when conditions exist but are not met. Defaults to ASK, never
    // to the effect itself: an unmet condition is an unanswered question.
    otherwise: r.otherwise ?? (r.conditions ? 'ASK' : null),
  };
}

function stableJson(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stableJson(v[k])}`).join(',')}}`;
  }
  return String(v);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
