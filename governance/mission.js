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
export function open(spec, agents, { at = null } = {}) {
  const id = `M-${String(++sequence).padStart(3, '0')}`;
  const needs = [...new Set(spec.needs ?? [])];

  const composition = compose(needs, agents);
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

  // Anything that only runs on a signal comes after whatever raises it.
  const order = [...members].sort((a, b) => {
    const aWaits = (a.triggered_by ?? []).some((t) => members.some((m) => m.id === t));
    const bWaits = (b.triggered_by ?? []).some((t) => members.some((m) => m.id === t));
    return Number(aWaits) - Number(bWaits);
  });

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
