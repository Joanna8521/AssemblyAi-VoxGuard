/**
 * The Workforce Composer: who should do this.
 *
 * The other half of the product. The policy compiler answers what a workforce
 * may do; this answers which of it should be involved at all, and it is the
 * half that makes a large capability pool worth having rather than a number in
 * a pitch.
 *
 * Deterministic on purpose. Handing the mission to a model and asking it to
 * pick agents would produce a plausible team from any pool, which means the
 * pool would not matter and neither would the answer. This ranks the actual
 * workforce against the actions a mission needs, and can say why each agent is
 * on the team and why the others are not.
 *
 * The ranking rests on one idea: an agent is worth calling for what only it can
 * do. Everybody analyses data; almost nobody can take a product off a
 * marketplace. So each action is weighted by how few agents hold it, the way a
 * rare word tells you more about a document than a common one.
 */

/**
 * @param {string[]} actions   what the mission needs doing
 * @param {object[]} agents    the workforce to draw from
 * @param {object}   options   { limit, includeUpstream }
 */
export function compose(actions, agents, { limit = 8, includeUpstream = true, live = null } = {}) {
  // Who can actually go and do it, where that is known. Claiming an action and
  // being able to perform it are different, and a team picked purely on claims
  // will hand the work to somebody who will only describe it.
  const canRun = live ? new Set(live) : null;
  const needed = [...new Set(actions)].filter(Boolean);
  if (!needed.length) {
    return { team: [], uncovered: [], considered: [], why: 'The mission names no action to do.' };
  }

  // How many agents hold each needed action. One is a specialist; twenty is
  // a room full of people who could all take the message.
  const holders = new Map(needed.map((a) => [a, agents.filter((g) => g.actions.includes(a))]));
  const weightOf = (action) => {
    const n = holders.get(action)?.length ?? 0;
    return n === 0 ? 0 : 1 / n;
  };

  const scored = agents
    .map((agent) => {
      const covers = needed.filter((a) => agent.actions.includes(a));
      const score = covers.reduce((sum, a) => sum + weightOf(a), 0);
      // What it brings that nobody else on the shortlist could.
      const rare = covers.filter((a) => (holders.get(a)?.length ?? 0) <= 2);
      const runs = canRun ? canRun.has(agent.id) : null;
      return { agent, covers, rare, score, runs };
    })
    .filter((c) => c.covers.length > 0)
    .sort((a, b) =>
      // A built agent outranks a described one that offers the same, because
      // the point of assembling a team is that the work happens.
      (Number(b.runs === true) - Number(a.runs === true)) ||
      b.score - a.score ||
      b.rare.length - a.rare.length ||
      a.agent.actions.length - b.agent.actions.length ||   // narrower beats broader
      a.agent.id.localeCompare(b.agent.id));               // and then stable

  // Take agents until every action a workforce can do is covered, then stop.
  // A second agent who adds nothing is a longer list, not a better team.
  const team = [];
  const covered = new Set();
  for (const candidate of scored) {
    if (team.length >= limit) break;
    const adds = candidate.covers.filter((a) => !covered.has(a));
    if (!adds.length) continue;
    adds.forEach((a) => covered.add(a));
    team.push({ ...candidate, adds, reason: reasonFor(candidate, adds, holders) });
  }

  // Whatever wakes a selected agent belongs on the team, or the picture shows
  // work beginning from nowhere.
  if (includeUpstream) {
    for (let pass = 0; pass < 2; pass++) {
      for (const member of [...team]) {
        for (const upstreamId of member.agent.triggered_by ?? []) {
          if (team.some((m) => m.agent.id === upstreamId)) continue;
          const upstream = agents.find((a) => a.id === upstreamId);
          if (!upstream) continue;
          team.push({
            agent: upstream, covers: [], rare: [], score: 0, adds: [],
            reason: `brought in because ${member.agent.name} runs when it raises a signal`,
          });
        }
      }
    }
  }

  const uncovered = needed.filter((a) => (holders.get(a)?.length ?? 0) === 0);
  const chosen = new Set(team.map((m) => m.agent.id));

  return {
    team,
    uncovered,
    considered: scored
      .filter((c) => !chosen.has(c.agent.id))
      .slice(0, 12)
      .map((c) => ({
        id: c.agent.id,
        name: c.agent.name,
        reason: `everything it offers here (${c.covers.join(', ')}) is already covered`,
      })),
    why: summarise(team, needed, uncovered),
  };
}

function reasonFor(candidate, adds, holders) {
  const soleOwner = adds.filter((a) => (holders.get(a)?.length ?? 0) === 1);
  if (soleOwner.length) {
    return `the only one that can ${soleOwner.join(' or ')}`;
  }
  if (adds.length > 1) {
    return `covers ${adds.length} of what this needs: ${adds.join(', ')}`;
  }
  return `covers ${adds[0]}`;
}

function summarise(team, needed, uncovered) {
  const working = team.filter((m) => m.covers.length).length;
  const support = team.length - working;

  const parts = [
    `${needed.length} ${needed.length === 1 ? 'action' : 'actions'} to cover, ` +
    `${working} ${working === 1 ? 'agent' : 'agents'} between them`,
  ];
  if (support) parts.push(`${support} more brought in as the ones that wake them`);
  if (uncovered.length) {
    parts.push(`nothing in this workforce can ${uncovered.join(' or ')}, so nobody was assigned to it`);
  }
  return `${parts.join('; ')}.`;
}
