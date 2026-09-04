/**
 * A mission: one thing to get done, and the two answers it needs.
 *
 * This is where the halves meet. A person says one sentence describing a
 * situation and the boundaries around it, and it becomes two different things
 * that a workforce needs before it can start:
 *
 *   who should work on this   the composer, from the capability pool
 *   how far may they go       the compiler, from what was said out loud
 *
 * Keeping them separate matters. A team assembled without boundaries is an
 * automation; boundaries with no team is a document. It is the pair, made at
 * the same moment from the same sentence, that is worth anything.
 *
 * A mission is also the unit that ends. Teams here are assembled for the work
 * and dissolve with it, which is why a stock-out staffs the order desk and a
 * revenue question does not, and why nobody has to maintain a permanent
 * department for something that happens twice a year.
 */

import { compose } from './composer.js';
import { compile, fingerprint } from './policy.js';

let sequence = 0;

/**
 * @param {object} spec
 *   brief   what the person said, in their words
 *   needs   the actions the work requires
 *   rules   the boundaries they stated
 * @param {object[]} agents   the workforce to draw from
 */
export function open(spec, agents, { at = null, live = null } = {}) {
  const id = `M-${String(++sequence).padStart(3, '0')}`;
  const needs = [...new Set(spec.needs ?? [])];

  const composition = compose(needs, agents, { live });
  const policy = compile({
    missionId: id,
    scope: spec.scope ?? 'mission',
    rules: spec.rules ?? [],
    spokenIn: spec.spokenIn ?? null,
    at,
  });

  return {
    id,
    brief: (spec.brief ?? '').slice(0, 400),
    openedAt: at,
    status: 'open',
    needs,

    team: composition.team.map((m) => ({
      id: m.agent.id,
      name: m.agent.name,
      emoji: m.agent.emoji,
      department: m.agent.department,
      reason: m.reason,
      covers: m.covers,
      support: m.covers.length === 0,
      runs: m.runs === true,
    })),
    passedOver: composition.considered,
    uncovered: composition.uncovered,
    composition: composition.why,

    policy,
    fingerprint: fingerprint(policy),

    runs: [],
  };
}

/**
 * What the mission looks like as a picture: sources, the team in the order work
 * flows through them, the evaluator, and the world.
 *
 * Derived rather than stored, so it cannot drift from the mission it draws.
 */
export function blueprint(mission, agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const members = mission.team.map((m) => byId.get(m.id)).filter(Boolean);

  // Work flows along the pools, so the order comes from them.
  //
  // Sorting on triggered_by alone was not enough: an agent can depend on
  // another without being woken by it, simply by reading a pool that one
  // writes. Order Desk declares no trigger and still cannot act before
  // Inventory Watch has said anything, and ordering it first got a truthful
  // report that nothing had happened, which was the wrong truth.
  const order = dependencyOrder(members);

  const pools = [...new Set(order.flatMap((a) => a.writes))];

  return {
    source: order.some((a) => a.schedule) ? 'Schedules and signals' : 'You',
    stages: order.map((agent) => {
      const member = mission.team.find((m) => m.id === agent.id);
      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        reason: member?.reason,
        support: member?.support ?? false,
        waitsFor: (agent.triggered_by ?? []).filter((t) => members.some((m) => m.id === t)),
        writes: agent.writes,
      };
    }),
    pools,
    // Named rather than implied. A picture of a workforce with no visible point
    // where it can be stopped is a picture of a different product.
    gate: {
      allows: mission.policy.rules.filter((r) => r.effect === 'ALLOW').map((r) => r.action),
      asks: mission.policy.rules.filter((r) => r.effect === 'ASK').map((r) => r.action),
      denies: mission.policy.rules.filter((r) => r.effect === 'DENY').map((r) => r.action),
    },
  };
}

/**
 * Members in an order where nobody runs before whatever it reads from.
 *
 * A plain topological sort over the pools, with triggers as extra edges. Cycles
 * are real in a workforce (two agents can feed each other) so this breaks them
 * by taking whoever is left rather than refusing to answer.
 */
/**
 * Actions that go and get something from outside this system.
 *
 * The distinction the ordering turns on. Several agents both read and write the
 * same pool, which makes a genuine cycle out of what is really a queue: one of
 * them fetches the numbers and the rest analyse them. Whoever fetches goes
 * first, or the analysts run against an empty pool and truthfully report that
 * there is nothing there.
 */
const FETCHES = new Set(['read_sheet', 'scrape_public_page', 'read_inventory']);
const isSource = (agent) => (agent.actions ?? []).some((a) => FETCHES.has(a));

/**
 * An agent that reads a pool and fills none is the end of the line.
 *
 * Ops Alerts gathers everything raised during a run into one message. Run in
 * the middle it gathers half a run, says so honestly, and the alert nobody
 * needed is the only one sent.
 */
const isSink = (agent) => (agent.reads ?? []).length > 0 && (agent.writes ?? []).length === 0;

function dependencyOrder(members) {
  const writers = new Map();
  for (const agent of members) {
    for (const pool of agent.writes ?? []) {
      if (!writers.has(pool)) writers.set(pool, []);
      writers.get(pool).push(agent.id);
    }
  }

  const needs = new Map(members.map((agent) => {
    const upstream = new Set();
    for (const pool of agent.reads ?? []) {
      for (const id of writers.get(pool) ?? []) if (id !== agent.id) upstream.add(id);
    }
    for (const id of agent.triggered_by ?? []) {
      if (members.some((m) => m.id === id)) upstream.add(id);
    }
    return [agent.id, upstream];
  }));

  // Whoever only reports is held back until everything that could give it
  // something to report has run. Ordering it among the others meant it became
  // ready early and summarised half a run.
  const reporters = members.filter(isSink);
  const workers = members.filter((m) => !isSink(m));

  const done = new Set();
  const out = [];
  while (out.length < workers.length) {
    const ready = workers
      .filter((m) => !done.has(m.id) && [...needs.get(m.id)].every((id) => done.has(id)))
      // Whoever fetches first, whoever only reports last.
      .sort((a, b) =>
        Number(isSource(b)) - Number(isSource(a)) ||
        Number(isSink(a)) - Number(isSink(b)));
    // Nothing ready means a cycle, and it has to be broken somewhere. Break it
    // at a node others are still waiting on, never at a leaf: the agent with
    // the fewest unmet dependencies is usually the one at the end of the queue,
    // and letting it go first put Customer Desk ahead of the agent that writes
    // the thing it reads. Among those, prefer whoever unblocks the most.
    let batch = ready;
    if (!batch.length) {
      const left = workers.filter((m) => !done.has(m.id));
      const unmet = (m) => [...needs.get(m.id)].filter((id) => !done.has(id));
      const dependents = (m) => left.filter((o) => needs.get(o.id).has(m.id)).length;
      // Only fall back to the leaves when there is nothing else left. Sorting
      // one concatenated list let a leaf win on having fewest dependencies,
      // which is exactly what a leaf always has, and put the agent that reports
      // on the run ahead of the agents whose findings it reports.
      const waited = left.filter((m) => dependents(m) > 0);
      batch = [(waited.length ? waited : left)
        .sort((a, b) =>
          // A cycle between an agent that fetches and agents that analyse is
          // broken at the one that fetches, every time.
          Number(isSource(b)) - Number(isSource(a)) ||
          Number(isSink(a)) - Number(isSink(b)) ||
          unmet(a).length - unmet(b).length ||
          dependents(b) - dependents(a) ||
          a.id.localeCompare(b.id))[0]];
    }
    for (const m of batch) { done.add(m.id); out.push(m); }
  }
  return [...out, ...reporters];
}

/** A one-line state of play, for a list where only the shape needs to read. */
export function digest(mission) {
  const decisions = mission.runs.flatMap((r) => r.decisions ?? []);
  const held = decisions.filter((d) => d.verdict !== 'ALLOW');
  return {
    id: mission.id,
    brief: mission.brief,
    status: mission.status,
    agents: mission.team.length,
    policyVersion: mission.policy.version,
    runs: mission.runs.length,
    cleared: decisions.length - held.length,
    held: held.length,
    waiting: held.filter((d) => d.verdict === 'ASK').length,
  };
}
