/**
 * The evaluator: deterministic, total, and free of language models.
 *
 * This is the one place a verdict is decided. It takes an action request, a
 * policy, and the registry, and returns ALLOW / DENY / ASK. It never calls out,
 * never asks a model what it thinks the user meant, and never returns anything
 * other than one of those three words.
 *
 * The direction of every default is chosen deliberately, and always the same
 * way: an unanswered question resolves to ASK or DENY, never to ALLOW. Failing
 * closed costs a person one more sentence. Failing open costs them an action
 * they never authorized.
 */

export const ALLOW = 'ALLOW';
export const DENY = 'DENY';
export const ASK = 'ASK';

/** Risk bands whose default, absent any rule, is to come back and ask. */
const ASK_BY_DEFAULT = new Set(['L4', 'L4-meta']);

/**
 * @param {object} request  { actionId, action, skill, parameters }
 * @param {object} policy   from governance/policy.js
 * @param {object} registry { riskOf(action) -> string|null }
 * @returns {{verdict, reason, reasonCode, rule, risk}}
 */
export function evaluate(request, policy, registry) {
  const action = request.action;
  const risk = registry.riskOf(action);

  // 1 · An action nobody registered is an action nobody reasoned about. We do
  //     not know what it costs, so we do not decide it.
  if (risk === null || risk === undefined) {
    return verdict(ASK, 'unregistered_action',
      `${action} is not in the capability registry`, null, null);
  }

  const rule = policy ? policy.rules.find((r) => r.action === action) ?? null : null;

  // 2 · No policy at all. Reads and drafting proceed; anything that touches the
  //     outside world waits for a human to have said something about it.
  if (!policy) {
    return isAutonomous(risk)
      ? verdict(ALLOW, 'no_policy_low_risk', `${risk} needs no authorization`, null, risk)
      : verdict(ASK, 'no_policy', 'no policy has been compiled yet', null, risk);
  }

  // 3 · An explicit denial is final. Conditions are not consulted, because a
  //     condition can only ever narrow an allowance, never widen a refusal.
  if (rule && rule.effect === DENY) {
    return verdict(DENY, 'explicit_deny', 'explicitly denied by human authorization', rule, risk);
  }

  if (rule && rule.effect === ASK) {
    return verdict(ASK, 'explicit_ask', 'the human asked to be consulted on this', rule, risk);
  }

  // 4 · An allowance, possibly conditional.
  if (rule && rule.effect === ALLOW) {
    if (!rule.conditions) {
      return verdict(ALLOW, 'explicit_allow', `${action} is explicitly allowed`, rule, risk);
    }
    const failed = unmetConditions(rule.conditions, request.parameters ?? {});
    if (failed.length === 0) {
      return verdict(ALLOW, 'conditions_met',
        `allowed, conditions satisfied: ${describe(rule.conditions)}`, rule, risk);
    }
    // Conditions exist and are not met. `otherwise` defaults to ASK in
    // policy.js. An unmet condition is an open question, not a refusal, and
    // certainly not a pass.
    return verdict(rule.otherwise ?? ASK, 'conditions_unmet',
      `outside the authorized range: ${failed.join('; ')}`, rule, risk);
  }

  // 5 · Nothing in the policy speaks to this action.
  if (isAutonomous(risk)) {
    return verdict(ALLOW, 'below_policy_threshold', `${risk} needs no authorization`, null, risk);
  }
  if (ASK_BY_DEFAULT.has(risk)) {
    return verdict(ASK, 'unmatched_high_risk',
      `${risk} is never assumed; no rule covers ${action}`, null, risk);
  }
  return verdict(DENY, 'unmatched_default_deny',
    `no rule authorizes ${action}, and external writes are not assumed`, null, risk);
}

/** L0–L2 never needed authorization: reasoning, reading, and drafting. */
function isAutonomous(risk) {
  return risk === 'L0' || risk === 'L1' || risk === 'L2';
}

/**
 * Which conditions the request fails. Comparators are few on purpose: every
 * one of them is something a person can plausibly say out loud.
 */
function unmetConditions(conditions, params) {
  const failed = [];
  for (const [field, expected] of Object.entries(conditions)) {
    const actual = params[field];
    if (actual === undefined) {
      failed.push(`${field} not supplied`);
      continue;
    }
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [op, bound] of Object.entries(expected)) {
        if (!compare(op, actual, bound)) failed.push(`${field} ${op} ${bound} (got ${actual})`);
      }
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) failed.push(`${field} not one of ${expected.join('/')}`);
    } else if (actual !== expected) {
      failed.push(`${field} != ${expected} (got ${actual})`);
    }
  }
  return failed;
}

function compare(op, a, b) {
  switch (op) {
    case 'lte': return a <= b;
    case 'lt': return a < b;
    case 'gte': return a >= b;
    case 'gt': return a > b;
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'in': return Array.isArray(b) && b.includes(a);
    // An operator we do not implement is not a condition we can judge, and an
    // unjudged condition must not pass. Same direction as everything else here.
    default: return false;
  }
}

function describe(conditions) {
  return Object.entries(conditions)
    .map(([f, v]) => (typeof v === 'object' && !Array.isArray(v)
      ? Object.entries(v).map(([op, b]) => `${f} ${op} ${b}`).join(', ')
      : `${f}=${v}`))
    .join('; ');
}

function verdict(v, reasonCode, reason, rule, risk) {
  return { verdict: v, reasonCode, reason, rule, risk };
}
