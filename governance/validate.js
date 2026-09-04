/**
 * Validate rules before they become policy.
 *
 * The tool schema is guidance, not a contract. Measured, not assumed: the API
 * stores whatever JSON Schema you send it, including keywords it does not
 * implement, and hands it to the model as advice. A live run produced
 * `customer_group: "floating pay"` from an enum of six values, and it arrived
 * without complaint.
 *
 * So the enum bounds what the model is *likely* to say. This bounds what is
 * allowed to become policy, and it is the only one of the two that holds.
 *
 * Rejected rules do not enter the policy and are handed back with a reason, so
 * the agent has to go and ask rather than quietly record something nobody said.
 * A rule we cannot read is not a rule, and the direction of that failure is the
 * same as every other one here: toward asking, never toward allowing.
 */

const EFFECTS = new Set(['ALLOW', 'DENY', 'ASK']);
const COMPARATORS = new Set(['lte', 'lt', 'gte', 'gt', 'eq', 'ne', 'in']);

/**
 * @returns {{accepted: object[], rejected: {rule: object, reason: string}[]}}
 */
export function validateRules(rules, registry) {
  const vocabulary = registry.conditionVocabulary;
  const accepted = [];
  const rejected = [];

  for (const rule of rules ?? []) {
    const reason = faultIn(rule, registry, vocabulary);
    if (reason) rejected.push({ rule, reason });
    else accepted.push(rule);
  }

  return { accepted, rejected };
}

function faultIn(rule, registry, vocabulary) {
  if (!rule || typeof rule !== 'object') return 'not an object';
  if (typeof rule.action !== 'string') return 'no action named';

  if (registry.riskOf(rule.action) === null) {
    return `"${rule.action}" is not a capability this workforce has`;
  }
  if (!EFFECTS.has(rule.effect)) {
    return `effect must be ALLOW, DENY or ASK, not "${rule.effect}"`;
  }
  if (rule.otherwise !== undefined && rule.otherwise !== null && !EFFECTS.has(rule.otherwise)) {
    return `otherwise must be ALLOW, DENY or ASK, not "${rule.otherwise}"`;
  }

  if (rule.conditions === undefined || rule.conditions === null) return null;
  if (typeof rule.conditions !== 'object' || Array.isArray(rule.conditions)) {
    return 'conditions must be an object';
  }

  for (const [field, value] of Object.entries(rule.conditions)) {
    const spec = vocabulary[field];
    if (!spec) {
      return `"${field}" is not a condition anything here understands ` +
             `(known: ${Object.keys(vocabulary).join(', ')})`;
    }

    // A comparator object narrows a range: {lte: 20}.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, bound] of Object.entries(value)) {
        if (!COMPARATORS.has(op)) {
          return `"${op}" is not a comparator (known: ${[...COMPARATORS].join(', ')})`;
        }
        const boundFault = valueFault(field, spec, bound, { insideComparator: true });
        if (boundFault) return boundFault;
      }
      continue;
    }

    const fault = valueFault(field, spec, value, {});
    if (fault) return fault;
  }

  return null;
}

function valueFault(field, spec, value, { insideComparator }) {
  if (spec.enum) {
    // `in` takes a list; everything else takes one of the declared values.
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (!spec.enum.includes(v)) {
        return `${field} cannot be "${v}" (it is one of: ${spec.enum.join(', ')})`;
      }
    }
    return null;
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return `${field} must be a number, not ${JSON.stringify(value)}`;
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      return `${field} must be a whole number, not ${value}`;
    }
    return null;
  }

  if (spec.type === 'string' && typeof value !== 'string') {
    return `${field} must be text, not ${JSON.stringify(value)}`;
  }

  return insideComparator ? null : null;
}
