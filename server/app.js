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
import { MemoryLedger, KVLedger, entryFrom, report } from '../governance/ledger.js';
import { perform, adapterStatus } from '../adapters/index.js';
import { runAgent, implementedAgents } from '../runtime/run.js';
import { open as openMission, blueprint, digest } from '../governance/mission.js';
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

/**
 * The commit this process was built from.
 *
 * Vercel puts it in the environment. Locally there is no build, so it says so
 * rather than inventing a number that would then be wrong in the one situation
 * this exists to settle.
 */
export const buildVersion = () =>
  (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'dev';
export const describeState = () => (process.env.KV_REST_API_URL ? 'shared KV' : 'in this process only');

const kv = process.env.KV_REST_API_URL ? makeKV() : null;
const store = kv ? new KVStore(kv) : new MemoryStore();

/**
 * What has been decided, kept apart from the session that decided it.
 *
 * Separate store, separate lifetime. A session is a conversation and may end;
 * the record of what was authorised is the thing a business comes back for.
 */
const ledger = kv ? new KVLedger(kv) : new MemoryLedger();

function makeKV() {
  const url = process.env.KV_REST_API_URL.replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;

  // Commands go in the body, not the path. Putting them in the path meant a
  // whole session JSON travelled as a URL segment, which works until a policy
  // gets long enough to hit a URL limit and then fails as an opaque 4xx.
  const call = async (cmd) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd.map(String)),
    });
    if (!res.ok) throw new Error(`kv ${res.status} on ${cmd[0]}`);
    return (await res.json()).result;
  };

  return {
    get: (k) => call(['GET', k]),
    set: (k, v, o) => call(o?.ex ? ['SET', k, v, 'EX', o.ex] : ['SET', k, v]),
    rpush: (k, values) => call(['RPUSH', k, ...values]),
    ltrim: (k, start, stop) => call(['LTRIM', k, start, stop]),
    expire: (k, seconds) => call(['EXPIRE', k, seconds]),
    lrange: (k, start, stop) => call(['LRANGE', k, start, stop]),
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
  // Ten minutes ended a conversation mid-sentence and, worse, would end a
  // recording mid-take. This is still a bound rather than no bound.
  url.searchParams.set('max_session_duration_seconds', '1800');

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
async function decide(session, request, context = {}) {
  const result = evaluate(request, session.policy, registry);

  const outcome = result.verdict === 'ALLOW'
    ? await perform(request.action, request.parameters, { registry })
    : null;

  const audit = record(session, request, result, outcome);

  // Kept for good, and awaited rather than fired off. A serverless invocation
  // ends when the response does, so an un-awaited append is an append that
  // sometimes does not happen. A ledger with sometimes in it is not a ledger.
  //
  // A failure here must not turn a decision into a 500: the decision was made
  // correctly and telling the caller otherwise would be the worse lie. It is
  // reported to the log and the response says the entry was not kept.
  let recorded = true;
  try {
    await ledger.append(session.tenant, [entryFrom(audit, context)]);
  } catch (err) {
    recorded = false;
    console.error('ledger append failed:', err.message);
  }

  return { ...result, outcome, audit, recorded };
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
    // Which build this is. Without it, "I changed that and nothing happened"
    // costs a round of testing to work out that the browser was holding an
    // older bundle. With it, the answer takes three seconds.
    version: buildVersion(),
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

  /**
   * What this workforce has done over time, counted.
   *
   * The point of keeping a ledger rather than a screen of recent lines: an
   * operator can ask what their agents attempted last month, how often somebody
   * had to step in, and how much of it left the building. Every figure is a
   * count over rows that can be fetched from /api/ledger and checked.
   */
  'GET /api/report': async (_body, { session }) => {
    const entries = await ledger.read(session.tenant);
    return {
      tenant: 'this browser',
      kept: describeState() === 'shared KV' ? 'shared store, 90 days' : 'this process only',
      entries: entries.length,
      report: report(entries, { days: 30 }),
      allTime: report(entries, { days: 36500 }),
    };
  },

  /** The rows themselves, newest last, so a figure in the report can be traced. */
  'GET /api/ledger': async (_body, { session }) => {
    const entries = await ledger.read(session.tenant);
    return { entries: entries.length, rows: entries.slice(-200) };
  },

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
  /**
   * Real shops, watched by default.
   *
   * The three worked examples on the front page composed a team and set
   * boundaries and then ran into nothing, because the agents that do real work
   * had nothing to look at. Offering somebody three things to try where two do
   * nothing is worse than offering none.
   *
   * These are public storefronts that publish their own catalogue, chosen
   * because they read cleanly rather than because they are anybody's rival.
   * Anything here can be removed, and adding your own is the point.
   */
  /**
   * Connect a spreadsheet the operator already keeps.
   *
   * Link-shared only, and said plainly at the point of connecting: anybody with
   * the link can read it, which is fine for a tab of totals and wrong for
   * anything with a customer's name in it.
   */
  'POST /api/sheets': async (body, { session, save }) => {
    const url = (body.url ?? '').trim();
    let parsed;
    try {
      const { parseSheetUrl } = await import('../runtime/sheets.js');
      parsed = parseSheetUrl(url);
    } catch (err) {
      const e = new Error(err.message);
      e.status = 400;
      throw e;
    }

    session.pools ??= {};
    session.pools.sheets ??= [];
    if (!session.pools.sheets.some((s2) => s2.url === url)) {
      session.pools.sheets.push({
        url, id: parsed.id, name: body.name ?? 'spreadsheet',
        addedAt: new Date().toISOString(),
      });
    }
    await save();
    return { sheets: session.pools.sheets };
  },

  'POST /api/sheets/remove': async (body, { session, save }) => {
    session.pools ??= {};
    session.pools.sheets = (session.pools.sheets ?? []).filter((s2) => s2.url !== body.url);
    await save();
    return { sheets: session.pools.sheets };
  },

  'POST /api/watch/seed': async (_body, { session, save }) => {
    session.pools ??= {};
    session.pools.listings ??= [];
    session.pools.shops ??= [];

    const products = [
      'https://www.tentree.com/products/parka-puffer-jacket-meteorite-black',
      'https://www.marinelayer.com/products/lacey-slip-skirt',
      'https://rothys.com/products/the-point-iii',
    ];
    const shops = ['https://www.tentree.com', 'https://www.marinelayer.com'];

    for (const url of products) {
      if (!session.pools.listings.some((w) => w.url === url)) {
        session.pools.listings.push({ url, addedAt: new Date().toISOString(), seeded: true });
      }
    }
    for (const url of shops) {
      if (!session.pools.shops.some((w) => w.url === url)) {
        session.pools.shops.push({ url, addedAt: new Date().toISOString(), seeded: true });
      }
    }
    await save();
    return { watching: session.pools.listings, shops: session.pools.shops };
  },

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

  /**
   * What counts as worth raising. Not a permission, so it does not go through
   * the evaluator: it changes what an agent bothers to ask about, never what it
   * is allowed to do once it asks.
   */
  'POST /api/settings': async (body, { session, save }) => {
    session.settings ??= {};
    const n = Number(body.dropPercent);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      const e = new Error('a drop threshold has to be a percentage between 0 and 100');
      e.status = 400;
      throw e;
    }
    session.settings.revenueDropPercent = n;
    await save();
    return { settings: session.settings };
  },

  'GET /api/pools': async (_body, { session }) => ({
    pools: session.pools ?? {},
    implemented: implementedAgents(),
  }),

  /**
   * Which agents on a team will actually do something, said before anybody
   * presses run. A team half of which is a description should look like one.
   */
  'POST /api/missions/readiness': async (body, { session }) => {
    const mission = (session.missions ?? []).find((m) => m.id === body.id) ?? (session.missions ?? [])[0];
    if (!mission) return { runs: [], describes: [] };
    const live = new Set(implementedAgents());
    return {
      runs: mission.team.filter((m) => live.has(m.id)).map((m) => m.name),
      describes: mission.team.filter((m) => !live.has(m.id)).map((m) => m.name),
    };
  },

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

  /**
   * Open a mission: compose a team and compile its boundaries from one
   * description, at the same moment, from the same sentence.
   */
  'POST /api/missions': async (body, { session, save }) => {
    const { accepted, rejected } = validateRules(body.rules, registry);
    const known = new Set(registry.actionIds);
    const needs = (body.needs ?? []).filter((a) => known.has(a));
    const unknownNeeds = (body.needs ?? []).filter((a) => !known.has(a));

    // Whatever is already standing comes with it.
    //
    // Opening a mission used to replace session.policy outright, which threw
    // away rules spoken moments earlier: the agent recorded one, said so, and
    // then opened the mission that deleted it. The workforce went on to be
    // refused an action the person had just authorised, for want of a rule that
    // had been there. Rules spoken with this mission win where they collide.
    const standing = session.policy?.rules ?? [];
    const spoken = new Set(accepted.map((r) => r.action));
    const carried = standing.filter((r) => !spoken.has(r.action));

    const mission = openMission(
      {
        brief: body.brief,
        needs,
        rules: [...carried, ...accepted],
        scope: body.scope,
        spokenIn: body.spokenIn,
      },
      workforce.agents,
      { at: new Date().toISOString(), live: implementedAgents() },
    );

    session.missions ??= [];
    session.missions.unshift(mission);
    session.missions = session.missions.slice(0, 10);
    // The newest mission is the one a bare policy question is about.
    session.policy = mission.policy;
    await save();

    return {
      mission,
      blueprint: blueprint(mission, workforce.agents),
      rejected,
      unknownNeeds,
    };
  },

  'GET /api/missions': async (_body, { session }) => ({
    missions: (session.missions ?? []).map(digest),
  }),

  'POST /api/missions/get': async (body, { session }) => {
    const mission = (session.missions ?? []).find((m) => m.id === body.id);
    if (!mission) {
      const e = new Error(`no mission ${body.id}`);
      e.status = 404;
      throw e;
    }
    return { mission, blueprint: blueprint(mission, workforce.agents) };
  },

  /**
   * Run every agent on a mission's team that has an implementation, and put
   * each intent through the same evaluator as everything else. The ones that
   * are only described say so rather than pretending to have worked.
   */
  'POST /api/missions/run': async (body, { session, save }) => {
    const mission = (session.missions ?? []).find((m) => m.id === body.id)
      ?? (session.missions ?? [])[0];
    if (!mission) {
      const e = new Error('no mission to run');
      e.status = 404;
      throw e;
    }

    const previousPolicy = session.policy;
    session.policy = mission.policy;    // judged against its own boundaries

    const observed = [];
    const decisions = [];

    // In the order the work actually flows, not the order the composer ranked
    // them. Emergency Response reads what Inventory Watch writes, so running it
    // first finds an empty signal pool and reports, quite correctly, that
    // nothing has happened. The blueprint already sorts upstream first; the run
    // was simply not using it.
    const order = blueprint(mission, workforce.agents).stages.map((s2) => s2.id);
    const team = [...mission.team].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    for (const member of team) {
      const run = await runAgent(member.id, { session, workforce });
      observed.push(...run.observed.map((o) => `${member.name}: ${o}`));
      for (const intent of run.intents) {
        const request = {
          actionId: `A-${1000 + session.audit.length}`,
          action: intent.action,
          skill: member.id,
          parameters: intent.parameters ?? {},
        };
        const decision = await decide(session, request,
          { missionId: mission.id, brief: mission.brief, agent: member.name });
        decisions.push({
          agent: member.name, why: intent.why, action: request.action,
          verdict: decision.verdict, reason: decision.reason, audit: decision.audit,
        });
      }
    }

    mission.runs.push({ at: new Date().toISOString(), observed, decisions });
    mission.policy = session.policy;    // an amendment mid-run belongs to it
    session.policy = mission.policy;
    if (previousPolicy && previousPolicy.missionId !== mission.id) { /* kept above */ }
    await save();

    return { mission: digest(mission), observed, decisions };
  },

  /**
   * Start again, without throwing away the setup.
   *
   * This used to clear the whole session, which took the connected spreadsheet
   * and the watched storefronts with it. Those are not state: somebody pasted
   * them once and expects them to still be there. Reset means the work and the
   * permissions, not the sources.
   */
  'POST /api/reset': async (_body, { id, session, save }) => {
    const pools = session.pools ?? {};
    const settings = session.settings ?? {};

    await store.clear(id);

    const fresh = await store.get(id);
    fresh.pools = pools;
    fresh.settings = settings;
    await store.put(id, fresh);

    return {
      ok: true,
      kept: {
        sheets: (pools.sheets ?? []).length,
        watching: (pools.listings ?? []).length,
      },
    };
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
      session.tenant = id;   // whose ledger this decision belongs in
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
    const type = MIME[extname(path)] ?? 'application/octet-stream';

    // Every local script reference carries the build.
    //
    // A stamp that reports the server build answers a different question from
    // the one being asked. Twice now a fix was live on the server while the
    // browser ran the previous bundle, and the page said the new number both
    // times, so the evidence pointed at the code rather than at the cache.
    // Stamping the URLs means a new build cannot be served old scripts, and
    // the page can say which bundle it is actually running.
    if (type.startsWith('text/html') || type.includes('javascript')) {
      const v = buildVersion();
      const stamped = file.toString('utf8')
        .replace(/(src|href)="(\.\/[^"?]+\.(?:js|css))"/g, `$1="$2?v=${v}"`)
        .replace(/from '(\.\/[^']+\.js)'/g, `from '$1?v=${v}'`)
        .replace('<title>', `<meta name="build" content="${v}"><title>`);
      return send(res, 200, Buffer.from(stamped, 'utf8'), {
        'content-type': type,
        'cache-control': 'no-cache, must-revalidate',
      });
    }

    send(res, 200, file, { 'content-type': type });
  } catch {
    send(res, 404, { error: 'not found' });
  }
}
