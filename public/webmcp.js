/**
 * WebMCP: the page offers itself to whatever agent is in the browser.
 *
 * Same idea as mcp/server.js, one layer closer in. An agent running inside the
 * browser can ask this page what is authorised and try to act, and it meets the
 * same evaluator over the same HTTP as everything else. There is no faster path
 * for being in the same tab.
 *
 * Registered through `navigator.modelContext.registerTool`. The earlier
 * `provideContext` / `clearContext` pair was removed in the March 2026 revision,
 * so code written against those does nothing at all now; this uses the register
 * form and feature-detects, so browsers without it are simply unaffected.
 */

const api = (path, body) => fetch(path, body
  ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  : undefined).then(async (r) => {
    const d = await r.json().catch(() => ({ error: `${r.status}` }));
    if (!r.ok) throw new Error(d.error ?? `${r.status}`);
    return d;
  });

const say = (text) => ({ content: [{ type: 'text', text }] });

/**
 * @param {string[]} actionIds  the governed actions, for the enum
 * @returns {boolean} whether the browser had anywhere to register them
 */
export function registerWebMCP(actionIds) {
  const ctx = globalThis.navigator?.modelContext;
  if (!ctx?.registerTool) return false;

  ctx.registerTool({
    name: 'standing_order_policy',
    description:
      'Read the policy currently in force over this commerce workforce: its version, every ' +
      'rule, and what has been held. Call this before trying anything, or to explain to a ' +
      'person why something did not go through.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const s = await api('/api/state');
      if (!s.policy) return say('No policy has been compiled. Nothing consequential is authorised.');
      const rules = s.policy.rules.map((r) =>
        `  ${r.action}: ${r.effect}` + (r.conditions
          ? ` when ${Object.entries(r.conditions).map(([k, v]) =>
              `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}`
          : '')).join('\n');
      const held = s.audit.filter((e) => e.verdict !== 'ALLOW').length;
      return say(`Policy ${s.policy.policyId} v${s.policy.version} (${s.policy.scope}):\n${rules}\n\n` +
        `${s.audit.length} decisions, ${held} held.`);
    },
  });

  ctx.registerTool({
    name: 'standing_order_would_allow',
    description:
      'Ask what would happen without it happening. Returns a verdict per action against the ' +
      'policy in force, and records nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'string', enum: actionIds } },
      },
      required: ['actions'],
    },
    async execute({ actions }) {
      const { results } = await api('/api/preview', { actions: actions ?? [] });
      return say(results.map((r) => `${r.action}: ${r.verdict} (${r.reason})`).join('\n'));
    },
  });

  ctx.registerTool({
    name: 'standing_order_perform',
    description:
      'Attempt an action against the workforce. This does not perform it: it asks the policy, ' +
      'and the policy decides. A refusal is final, and you cannot grant yourself permission. ' +
      'Relay the reason to the person and let them change the policy by voice if they mean to.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actionIds, description: 'The action to attempt.' },
        customer_group: { type: 'string', description: 'Optional. Which group, if it names one.' },
        platform: { type: 'string', description: 'Optional. Which platform, if it names one.' },
        amount: { type: 'number', description: 'Optional. Money, if any.' },
        increase_percent: { type: 'number', description: 'Optional. For budget changes.' },
      },
      required: ['action'],
    },
    async execute({ action, ...parameters }) {
      const cleaned = Object.fromEntries(
        Object.entries(parameters).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const r = await api('/api/evaluate', { action, skill: 'WEBMCP', parameters: cleaned });
      globalThis.dispatchEvent(new CustomEvent('standingorder:decision', { detail: r }));

      if (r.verdict !== 'ALLOW') {
        return say(`${r.verdict}: ${action} was not performed.\n${r.reason}\n\n` +
          `You cannot grant this. The person has to say so out loud.`);
      }
      return say(`ALLOW: ${action} performed against the ${r.audit.adapter} adapter` +
        `${r.audit.real ? '' : ' (simulated; no credential for this exists)'}.`);
    },
  });

  return true;
}
