/**
 * Standing Order, as a request handler.
 *
 * Deliberately not a server. A serverless deployment cannot have a module that
 * listens on load, and a local one should not have a second copy of the routing
 * to drift away from this one. So this exports a handler, and both entry points
 * are three lines each.
 *
 * No dependencies, by choice.
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

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { evaluate } from '../governance/evaluator.js';
import { compile, amend, fingerprint } from '../governance/policy.js';
import { load } from '../governance/registry.js';
import { validateRules } from '../governance/validate.js';
import { MemoryStore, KVStore, sessionIdFrom } from '../governance/store.js';
import { perform, adapterStatus } from '../adapters/index.js';
import { runAgent, implementedAgents } from '../runtime/run.js';
import { toolsFor, systemPrompt, greeting, inputConfig } from '../voice/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'public');
export const PORT = Number(process.env.PORT ?? 8787);
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


/**
 * One store, many sessions.
 *
 * Memory is right when this is a single long-lived process. It is wrong the
 * moment there are two, and a serverless deployment is always two, so the choice
 * is made here from configuration rather than inherited by accident. Announced
 * at startup, because deploying with the wrong one looks fine until a second
 * person opens the page.
 */
export const keyConfigured = () => Boolean(API_KEY);
export const describeState = () => (process.env.KV_REST_API_URL ? 'shared KV' : 'in this process only');

const store = process.env.KV_REST_API_URL
  ? new KVStore(await makeKV())
  : new MemoryStore();

async function makeKV() {
  const url = process.env.KV_REST_API_URL.replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  const call = async (cmd) => {
    const res = await fetch(`${url}/${cmd.map(encodeURIComponent).join('/')}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`kv ${res.status}`);
    return (await res.json()).result;
  };
  return {
    get: (k) => call(['get', k]),
    set: (k, v, o) => call(o?.ex ? ['set', k, v, 'EX', String(o.ex)] : ['set', k, v]),
  };
}

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

function record(session, request, result, outcome) {
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
    // `real` used to mean "a credential for this class of action exists
    // somewhere in the corpus", which said nothing about whether this
    // deployment would do it. It now means it ran.
    real: outcome?.mode === 'real' && outcome.performed === true,
    performed: outcome?.performed ?? false,
    outcome: outcome?.detail ?? 'not authorised, so nothing was attempted',
    // Whether the emitting skill is even capable of this. Not used to decide,
    // since a forged call is refused on the policy alone, but worth recording.
    knownEmitter: request.skill ? registry.canPerform(request.skill, request.action) : null,
    policyId: session.policy?.policyId ?? null,
    policyVersion: session.policy?.version ?? null,
  };
  session.audit.push(entry);
  return entry;
}

/**
 * Decide, and if allowed, do.
 *
 * The single place where an action becomes a consequence. Both the console and
 * the agent runtime come through here, and the invariant test counts on there
 * being exactly one of these: two copies of evaluate-then-perform would drift,
 * and the one that drifted would be the one nobody was reading.
 */
async function decide(session, request) {
  const result = evaluate(request, session.policy, registry);

  const outcome = result.verdict === 'ALLOW'
    ? await perform(request.action, request.parameters, { registry })
    : null;

  return { ...result, outcome, audit: record(session, request, result, outcome) };
}

// ── routes ──────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    keyConfigured: Boolean(API_KEY),
    corpus: registry.corpus,
    adapters: adapterStatus(),
    // Worth surfacing rather than inferring. On serverless the memory store
    // looks like it works, because consecutive requests often land on the same
    // warm instance, so "is state shared" is a question you want answered by
    // the deployment rather than by a test that happened to pass.
    state: describeState(),
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
  /** The action catalogue, so the MCP server can build its tool list from it. */
  'GET /api/actions': async () => JSON.parse(
    readFileSync(join(HERE, '..', 'registry', 'actions.json'), 'utf8')),

  'GET /api/workforce': async () => ({
    platforms: workforce.platforms,
    departments: workforce.departments,
    pools: workforce.pools,
    agents: workforce.agents,
  }),

  'GET /api/state': async (_body, { session }) => ({
    policy: session.policy,
    fingerprint: session.policy ? fingerprint(session.policy) : null,
    audit: session.audit,
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
  'POST /api/policy/compile': async (body, { session, save }) => {
    const at = new Date().toISOString();
    const { accepted: rules, rejected } = validateRules(body.rules, registry);

    if (session.policy) {
      const before = new Map(session.policy.rules.map((r) => [r.action, r.effect]));
      session.policy = amend(session.policy, rules, { at });
      const restated = rules.filter((r) => before.has(r.action) && before.get(r.action) === r.effect);
      await save();
      return {
        policy: session.policy,
        fingerprint: fingerprint(session.policy),
        merged: true,
        kept: [...before.keys()].filter((a) => !rules.some((r) => r.action === a)),
        restated: restated.map((r) => r.action),
        rejected,
      };
    }

    session.policy = compile({
      missionId: body.missionId ?? session.missionId,
      scope: body.scope ?? 'mission',
      rules,
      spokenIn: body.spokenIn ?? null,
      at,
    });
    await save();
    return { policy: session.policy, fingerprint: fingerprint(session.policy), merged: false, rejected };
  },

  'POST /api/policy/amend': async (body, { session, save }) => {
    if (!session.policy) {
      const e = new Error('no policy to amend');
      e.status = 409;
      throw e;
    }
    const { accepted, rejected } = validateRules(body.changes, registry);
    session.policy = amend(session.policy, accepted, { at: new Date().toISOString() });
    await save();
    return { policy: session.policy, fingerprint: fingerprint(session.policy), rejected };
  },

  /**
   * The chokepoint. Every consequential action arrives here, whatever emitted
   * it: a workforce skill, an MCP client, or a request forged by hand from the
   * console. The evaluator does not care which, and that is the point.
   */
  'POST /api/evaluate': async (body, { session, save }) => {
    const request = {
      actionId: body.actionId ?? `A-${1000 + session.audit.length}`,
      action: body.action,
      skill: body.skill ?? null,
      parameters: body.parameters ?? {},
    };
    if (!request.action) {
      const e = new Error('action is required');
      e.status = 400;
      throw e;
    }
    const decision = await decide(session, request);
    await save();
    return { request, ...decision };
  },

  /**
   * What would happen, without it having happened.
   *
   * Opening an agent asks the same question of every action it has, and those
   * are questions, not decisions: recording them would bury the real verdicts
   * under dozens of hypotheticals and make the audit trail useless for the one
   * thing it is for. So this runs the evaluator and writes nothing.
   */
  'POST /api/preview': async (body, { session }) => {
    const results = (body.actions ?? []).map((a) => {
      const request = {
        actionId: 'preview',
        action: typeof a === 'string' ? a : a.action,
        skill: body.skill ?? null,
        parameters: (typeof a === 'string' ? {} : a.parameters) ?? {},
      };
      const { verdict, reason, reasonCode, risk } = evaluate(request, session.policy, registry);
      return {
        action: request.action,
        verdict, reason, reasonCode, risk,
        adapter: registry.adapterOf(request.action),
        real: registry.isReal(request.action),
        label: registry.label(request.action, 'en'),
      };
    });
    return { policyVersion: session.policy?.version ?? null, results };
  },

  /**
   * What this session is watching. A list of public URLs, nothing more.
   *
   * Validated on the way in rather than at fetch time, so a bad address is
   * refused while somebody is still looking at the field they typed it into.
   */
  'POST /api/watch': async (body, { session, save }) => {
    const raw = (body.url ?? '').trim();
    let url;
    try {
      url = new URL(raw);
    } catch {
      const e = new Error(`"${raw}" is not a URL`);
      e.status = 400;
      throw e;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const e = new Error('only http and https addresses can be watched');
      e.status = 400;
      throw e;
    }

    session.pools ??= {};
    session.pools.listings ??= [];
    if (session.pools.listings.some((w) => w.url === url.toString())) {
      return { watching: session.pools.listings, added: false };
    }
    if (session.pools.listings.length >= 12) {
      const e = new Error('twelve is enough to prove the point');
      e.status = 400;
      throw e;
    }

    session.pools.listings.push({ url: url.toString(), addedAt: new Date().toISOString() });
    await save();
    return { watching: session.pools.listings, added: true };
  },

  'POST /api/watch/remove': async (body, { session, save }) => {
    session.pools ??= {};
    session.pools.listings = (session.pools.listings ?? []).filter((w) => w.url !== body.url);
    await save();
    return { watching: session.pools.listings };
  },

  'GET /api/pools': async (_body, { session }) => ({
    pools: session.pools ?? {},
    implemented: implementedAgents(),
  }),

  /**
   * Run an agent for real.
   *
   * The agent does its own reading and thinking without asking anyone. What it
   * cannot do is act: it returns intents, and each one goes through the
   * evaluator here, in the same place and by the same rules as a request from
   * anywhere else. An agent that could reach an adapter directly would make the
   * rest of this decorative.
   */
  'POST /api/agents/run': async (body, { session, save }) => {
    const run = await runAgent(body.agent, { session, workforce });

    const decisions = [];
    for (const intent of run.intents) {
      const request = {
        actionId: `A-${1000 + session.audit.length}`,
        action: intent.action,
        skill: body.agent,
        parameters: intent.parameters ?? {},
      };
      const decision = await decide(session, request);
      decisions.push({
        why: intent.why,
        action: request.action,
        verdict: decision.verdict,
        reason: decision.reason,
        audit: decision.audit,
      });
    }

    await save();
    return { ...run, decisions };
  },

  'POST /api/reset': async (_body, { id }) => {
    await store.clear(id);
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

export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    let body = {};
    try {
      if (req.method !== 'GET') body = await readBody(req);
      const id = sessionIdFrom(req, res);
      const session = await store.get(id);
      const ctx = { id, session, save: () => store.put(id, session) };
      send(res, 200, await routes[key](body, ctx));
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
}
