#!/usr/bin/env node
/**
 * Signal Box as an MCP server.
 *
 * This is the interception point the architecture actually rests on. Every
 * agent framework worth governing reaches its tools through MCP now, so putting
 * the evaluator here means the invariant holds for all of them at once rather
 * than for whichever one we integrated with: OpenClaw, Hermes Agent, Claude
 * Code, anything that speaks the protocol.
 *
 * What an agent gets is the workforce's consequential surface, one tool per
 * action. Calling one does not perform it. It asks the policy, and the policy
 * answers with the same evaluator that answers everywhere else. A refusal comes
 * back as a tool error carrying the reason, which is a thing the calling model
 * can read and relay rather than a silence it has to guess at.
 *
 * Configure a client to run this over stdio:
 *
 *   { "mcpServers": { "signal-box": { "command": "node",
 *       "args": ["<repo>/mcp/server.js"],
 *       "env": { "SIGNAL_BOX_URL": "http://localhost:8787" } } } }
 *
 * No dependencies. MCP is JSON-RPC 2.0 over a pair of pipes, and the whole of
 * what a tools-only server needs is below.
 */

import { createInterface } from 'node:readline';

const BASE = (process.env.SIGNAL_BOX_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const PROTOCOL = '2025-06-18';

const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({ error: `${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
};

// ── the tools an agent sees ─────────────────────────────────────────────────

/**
 * Only actions at L3 and above are exposed.
 *
 * Reading and drafting need no authorisation, so routing them through here
 * would add two dozen tools that always say yes and bury the ones that matter.
 * What an agent sees is exactly the surface a person would want to govern.
 */
async function buildTools() {
  const [catalog, workforce] = await Promise.all([
    api('/api/actions'),
    api('/api/workforce'),
  ]);

  const vocabulary = catalog.condition_vocabulary ?? {};
  const byAction = new Map();
  for (const agent of workforce.agents) {
    for (const action of agent.actions) {
      if (!byAction.has(action)) byAction.set(action, []);
      byAction.get(action).push(`${agent.name}`);
    }
  }

  const governed = catalog.actions.filter((a) => a.risk.startsWith('L3') || a.risk.startsWith('L4'));

  const tools = governed.map((a) => {
    const owners = byAction.get(a.id) ?? [];
    return {
      name: a.id,
      description:
        `${a.label.en}. Risk ${a.risk}${a.reversible ? '' : ', irreversible'}` +
        `${a.financial ? ', moves money' : ''}${a.customer ? ', reaches customers' : ''}. ` +
        (owners.length ? `Normally performed by ${owners.join(', ')}. ` : '') +
        `Every call is judged against the policy the operator spoke; a refusal explains itself.`,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(vocabulary).map(([field, spec]) => [
            field,
            spec.enum
              ? { type: 'string', enum: spec.enum, description: `Optional. One of the declared groups.` }
              : { type: spec.type, description: 'Optional.' },
          ]),
        ),
      },
    };
  });

  tools.push({
    name: 'signalbox_policy',
    description:
      'Read the policy currently in force: its version, every rule, and what has been ' +
      'held so far. Call this when you want to know what you are allowed to do before ' +
      'trying, or to explain to a person why something did not go through.',
    inputSchema: { type: 'object', properties: {} },
  });

  tools.push({
    name: 'signalbox_would_allow',
    description:
      'Ask what would happen without it happening. Returns the verdict for each action ' +
      'named, judged against the current policy, and records nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'string' }, description: 'Action names to test.' },
      },
      required: ['actions'],
    },
  });

  return tools;
}

// ── calling one ─────────────────────────────────────────────────────────────

const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], isError });

async function callTool(name, args = {}) {
  if (name === 'signalbox_policy') {
    const s = await api('/api/state');
    if (!s.policy) return text('No policy has been compiled. Nothing consequential is authorised.');
    const rules = s.policy.rules
      .map((r) => `  ${r.action}: ${r.effect}` +
        (r.conditions ? ` when ${Object.entries(r.conditions).map(([k, v]) =>
          `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}` : ''))
      .join('\n');
    const held = s.audit.filter((e) => e.verdict !== 'ALLOW');
    return text(
      `Policy ${s.policy.policyId} version ${s.policy.version}, scope ${s.policy.scope}.\n${rules}\n\n` +
      `${s.audit.length} decisions so far, ${held.length} of them held.`);
  }

  if (name === 'signalbox_would_allow') {
    const { results } = await api('/api/preview', { actions: args.actions ?? [] });
    return text(results.map((r) => `${r.action}: ${r.verdict} (${r.reason})`).join('\n'));
  }

  // Everything else is an action. Asking for it is not doing it.
  const r = await api('/api/evaluate', { action: name, skill: 'MCP', parameters: args });

  if (r.verdict !== 'ALLOW') {
    // A refusal is an error the calling model can read and pass on, not a
    // silence it has to interpret. It names the policy so a person can argue
    // with the right thing.
    return text(
      `${r.verdict}: ${name} was not performed.\n${r.reason}` +
      (r.audit.policyVersion ? `\nPolicy ${r.audit.policyId} version ${r.audit.policyVersion}.` : '') +
      `\n\nIf this should be allowed, the operator has to say so out loud. You cannot grant it.`,
      true);
  }

  return text(
    `ALLOW: ${name} performed against the ${r.audit.adapter} adapter` +
    `${r.audit.real ? '' : ' (simulated; no credential for this exists)'}.\n${r.reason}`);
}

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let tools = null;

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no reply.
  if (id === undefined) return;

  try {
    switch (method) {
      case 'initialize':
        // Echo the client's version when we support it, which we do for this
        // one; otherwise state ours and let the client decide to disconnect.
        return ok(id, {
          protocolVersion: params?.protocolVersion === PROTOCOL ? PROTOCOL : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'signal-box', title: 'Signal Box', version: '0.1.0' },
          instructions:
            'Every tool here is an action against a real commerce workforce, and every call ' +
            'is judged against a policy a person spoke aloud. A refusal is final: you cannot ' +
            'grant yourself permission, and retrying will not change the answer. Relay the ' +
            'reason to the person and let them decide.',
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        tools ??= await buildTools();
        return ok(id, { tools });

      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return ok(id, result);
      }

      default:
        return fail(id, -32601, `unknown method: ${method}`);
    }
  } catch (err) {
    // A server that cannot reach the policy must not answer as though it could.
    return fail(id, -32603, `${err.message} (is Signal Box running at ${BASE}?)`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  handle(msg);
});
