/**
 * Signal Box server. No dependencies, by choice.
 *
 * It does three things:
 *
 *   1. Mints short-lived AssemblyAI tokens so the API key never leaves this
 *      process. The browser streams audio straight to AssemblyAI; audio never
 *      touches us, which means we cannot store anyone's voice even by accident.
 *   2. Holds the policy — the artifact the voice layer compiles, and the only
 *      thing the evaluator consults.
 *   3. Evaluates action requests and appends every verdict to an audit trail.
 *
 * The evaluator is imported, never reimplemented here. There is exactly one
 * place a verdict is decided, and it is `governance/evaluator.js`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { evaluate } from '../governance/evaluator.js';
import { compile, amend, fingerprint } from '../governance/policy.js';
import { load } from '../governance/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.ASSEMBLYAI_API_KEY ?? '';

const registry = load();

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
    const e = new Error('ASSEMBLYAI_API_KEY is not set — copy .env.example to .env and fill it in');
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
    // Whether the emitting skill is even capable of this. Not used to decide —
    // a forged call is refused on the policy alone — but worth recording.
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

  'GET /api/state': async () => ({
    policy: state.policy,
    fingerprint: state.policy ? fingerprint(state.policy) : null,
    audit: state.audit,
  }),

  'POST /api/policy/compile': async (body) => {
    state.policy = compile({
      missionId: body.missionId ?? state.missionId,
      scope: body.scope ?? 'mission',
      rules: body.rules ?? [],
      spokenIn: body.spokenIn ?? null,
      at: new Date().toISOString(),
    });
    return { policy: state.policy, fingerprint: fingerprint(state.policy) };
  },

  'POST /api/policy/amend': async (body) => {
    if (!state.policy) {
      const e = new Error('no policy to amend');
      e.status = 409;
      throw e;
    }
    state.policy = amend(state.policy, body.changes ?? [], { at: new Date().toISOString() });
    return { policy: state.policy, fingerprint: fingerprint(state.policy) };
  },

  /**
   * The chokepoint. Every consequential action arrives here, whatever emitted
   * it — a workforce skill, an MCP client, or a request forged by hand from the
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

  const rel = url.pathname === '/' ? '/console.html' : url.pathname;
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
    console.log('  connection still works — policy, evaluator and audit run offline.');
    console.log('  To enable voice:  cp .env.example .env  and fill in the key.\n');
  }
});
