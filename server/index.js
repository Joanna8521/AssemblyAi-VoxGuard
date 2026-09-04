/**
 * Signal Box server. No dependencies, by choice.
 *
 * It does three things:
 *
 *   1. Mints short-lived AssemblyAI tokens so the API key never leaves this
 *      process. The browser streams audio straight to AssemblyAI; audio never
 *      touches us, which means we cannot store anyone's voice even by accident.
 *   2. Holds the policy, the artifact the voice layer compiles and the only
 *      thing the evaluator consults.
 *   3. Evaluates action requests and appends every verdict to an audit trail.
 *
 * The evaluator is imported, never reimplemented here. There is exactly one
 * place a verdict is decided, and it is `governance/evaluator.js`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { evaluate } from '../governance/evaluator.js';
import { compile, amend, fingerprint } from '../governance/policy.js';
import { load } from '../governance/registry.js';
import { validateRules } from '../governance/validate.js';
import { toolsFor, systemPrompt, greeting, inputConfig } from '../voice/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.ASSEMBLYAI_API_KEY ?? '';

const RISK_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L4-meta'];
const byRisk = (a, b) => RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b);

const registry = load();

/**
 * The built-in workforce, annotated with what each of its actions costs.
 *
 * Loaded once and checked once: an agent that names an action the registry does
 * not know would be an agent whose requests the evaluator cannot weigh, and it
 * would fail as an ASK at runtime rather than as an error here, which is far
 * too late to notice.
 */
const workforce = (() => {
  const raw = JSON.parse(readFileSync(join(HERE, '..', 'agents', 'workforce.json'), 'utf8'));
  const unknown = [];

  const agents = raw.agents.map((a) => ({
    ...a,
    capabilities: a.actions.map((id) => {
      const risk = registry.riskOf(id);
      if (risk === null) unknown.push(`${a.id} -> ${id}`);
      return {
        action: id,
        risk,
        label: registry.label(id, 'en'),
        adapter: registry.adapterOf(id),
        real: registry.isReal(id),
      };
    }),
    highestRisk: a.actions
      .map((id) => registry.riskOf(id))
      .filter(Boolean)
      .sort(byRisk)
      .at(-1) ?? null,
  }));

  if (unknown.length) {
    throw new Error(`workforce.json names actions the registry does not have: ${unknown.join(', ')}`);
  }
  return { ...raw, agents };
})();


/** In-memory for now. A hackathon does not need Postgres to prove a point. */
const state = {
  policy: null,
  audit: [],
  missionId: 'M-100',
};

// ── AssemblyAI token minting ────────────────────────────────────────────────

/**
 * Tokens are single-use: a fresh one per connection, including reconnects.
 * `max_session_duration_seconds` is the only half of the cost bound we control,
 * so it is set here rather than left to default.
 */
async function mintToken() {
  if (!API_KEY) {
    const e = new Error('ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and fill it in');
    e.status = 503;
    throw e;
  }

  const url = new URL('https://agents.assemblyai.com/v1/token');
  url.searchParams.set('expires_in_seconds', '120');
  url.searchParams.set('max_session_duration_seconds', '600');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`AssemblyAI token request failed: ${res.status} ${body.slice(0, 200)}`);
    e.status = 502;
    throw e;
  }
  return res.json();
}

// ── audit ───────────────────────────────────────────────────────────────────

function record(request, result) {
  const entry = {
    at: new Date().toISOString(),
    actionId: request.actionId,
    skill: request.skill ?? null,
    action: request.action,
    parameters: request.parameters ?? {},
    verdict: result.verdict,
    reasonCode: result.reasonCode,
    reason: result.reason,
    risk: result.risk,
    adapter: registry.adapterOf(request.action),
    real: registry.isReal(request.action),
    // Whether the emitting skill is even capable of this. Not used to decide,
    // since a forged call is refused on the policy alone, but worth recording.
    knownEmitter: request.skill ? registry.canPerform(request.skill, request.action) : null,
    policyId: state.policy?.policyId ?? null,
    policyVersion: state.policy?.version ?? null,
  };
  state.audit.push(entry);
  return entry;
}

// ── routes ──────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    keyConfigured: Boolean(API_KEY),
    corpus: registry.corpus,
  }),

  'GET /api/token': async () => mintToken(),

  /**
   * The session config the browser sends verbatim as `session.update`.
   * Built here, from the registry, so the action enum the model is allowed to
   * emit can never drift from the actions the workforce actually has.
   */
  'GET /api/session-config': async () => ({
    system_prompt: systemPrompt(registry.corpus),
    greeting: greeting(),
    input: inputConfig(),
    // Immutable once the session is established, so it is set here rather than
    // adjusted later. Only six languages have voices; none of them is Mandarin.
    output: { voice: 'jane' },
    tools: toolsFor(registry),
  }),

  /**
   * The workforce graph the canvas draws: agents, the pools they read and write,
   * and what each agent is capable of costing.
   */
  'GET /api/workforce': async () => ({
    platforms: workforce.platforms,
    departments: workforce.departments,
    pools: workforce.pools,
    agents: workforce.agents,
  }),

  'GET /api/state': async () => ({
    policy: state.policy,
    fingerprint: state.policy ? fingerprint(state.policy) : null,
    audit: state.audit,
  }),

  /**
   * A second compile_policy inside a live mission merges rather than replaces.
   *
   * The agent is told compile_policy is for the first statement of a mission,
   * and it calls it twice anyway when a person keeps talking. Replacing on the
   * second call silently drops whatever the first one authorized. Losing an
   * authorization without telling anyone is the exact failure this system
   * exists to prevent, so it must not be the failure the system itself has.
   *
   * Merging keeps every rule, increments the version, and records the overlap,
   * so the audit trail shows a rule was restated rather than hiding that it
   * changed.
   */
  'POST /api/policy/compile': async (body) => {
    const at = new Date().toISOString();
    const { accepted: rules, rejected } = validateRules(body.rules, registry);

    if (state.policy) {
      const before = new Map(state.policy.rules.map((r) => [r.action, r.effect]));
      state.policy = amend(state.policy, rules, { at });
      const restated = rules.filter((r) => before.has(r.action) && before.get(r.action) === r.effect);
      return {
        policy: state.policy,
        fingerprint: fingerprint(state.policy),
        merged: true,
        kept: [...before.keys()].filter((a) => !rules.some((r) => r.action === a)),
        restated: restated.map((r) => r.action),
        rejected,
      };
    }

    state.policy = compile({
      missionId: body.missionId ?? state.missionId,
      scope: body.scope ?? 'mission',
      rules,
      spokenIn: body.spokenIn ?? null,
      at,
    });
    return { policy: state.policy, fingerprint: fingerprint(state.policy), merged: false, rejected };
  },

  'POST /api/policy/amend': async (body) => {
    if (!state.policy) {
      const e = new Error('no policy to amend');
      e.status = 409;
      throw e;
    }
    const { accepted, rejected } = validateRules(body.changes, registry);
    state.policy = amend(state.policy, accepted, { at: new Date().toISOString() });
    return { policy: state.policy, fingerprint: fingerprint(state.policy), rejected };
  },

  /**
   * The chokepoint. Every consequential action arrives here, whatever emitted
   * it: a workforce skill, an MCP client, or a request forged by hand from the
   * console. The evaluator does not care which, and that is the point.
   */
  'POST /api/evaluate': async (body) => {
    const request = {
      actionId: body.actionId ?? `A-${1000 + state.audit.length}`,
      action: body.action,
      skill: body.skill ?? null,
      parameters: body.parameters ?? {},
    };
    if (!request.action) {
      const e = new Error('action is required');
      e.status = 400;
      throw e;
    }
    const result = evaluate(request, state.policy, registry);
    return { request, ...result, audit: record(request, result) };
  },

  'POST /api/reset': async () => {
    state.policy = null;
    state.audit = [];
    return { ok: true };
  },
};

// ── plumbing ────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function readBody(req) {
  const chunks = [];
  // Read the request to completion before deciding anything about it. A reply
  // that lands before the sender has finished is what makes a proxy sever the
  // stream, and the resulting error names neither side.
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const e = new Error('body is not valid JSON');
    e.status = 400;
    throw e;
  }
}

function send(res, status, payload, headers = {}) {
  const data = typeof payload === 'string' || Buffer.isBuffer(payload)
    ? payload
    : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    let body = {};
    try {
      if (req.method !== 'GET') body = await readBody(req);
      send(res, 200, await routes[key](body));
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message, code: err.code ?? null });
    }
    return;
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = join(WEB, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(WEB)) return send(res, 403, { error: 'forbidden' });

  try {
    const file = await readFile(path);
    send(res, 200, file, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  } catch {
    send(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, () => {
  console.log(`Signal Box  →  http://localhost:${PORT}`);
  if (!API_KEY) {
    console.log('\n  ASSEMBLYAI_API_KEY is not set. Everything except the voice');
    console.log('  connection still works. Policy, evaluator and audit run offline.');
    console.log('  To enable voice:  cp .env.example .env  and fill in the key.\n');
  }
});
