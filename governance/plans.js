/**
 * What a workspace is allowed to use, and what it costs.
 *
 * The reason this exists at all: a governance tool that cannot say what it did
 * for whom, over what period, against what allowance, is a demonstration. The
 * numbers here are the same numbers the ledger already keeps, counted per month
 * and held against a limit that actually refuses.
 *
 * Everything metered is something that genuinely costs: seconds of a voice
 * session, an agent going out and fetching, a decision recorded for good, a
 * message that really left the building. Nothing is metered because it makes a
 * pricing page look fuller.
 *
 * The limits refuse rather than degrade. A workspace over its voice allowance
 * cannot start a session and is told so; it does not get a quietly worse one.
 * Governance is never the thing that degrades: a decision is always evaluated
 * and always recorded, whatever the plan, because a refusal that did not happen
 * because of billing is the one failure this must never have.
 */

export const PLANS = {
  trial: {
    id: 'trial',
    name: 'Trial',
    price: 0,
    blurb: 'Enough to decide whether this belongs in your week.',
    limits: { voiceMinutes: 30, agentRuns: 200, sources: 3, sends: 50 },
  },
  shop: {
    id: 'shop',
    name: 'Shop',
    price: 29,
    blurb: 'One shop, watched daily, with the alerts actually going out.',
    limits: { voiceMinutes: 300, agentRuns: 5000, sources: 25, sends: 1000 },
  },
  chain: {
    id: 'chain',
    name: 'Chain',
    price: 99,
    blurb: 'Several shops, several people, and the record kept for the year.',
    limits: { voiceMinutes: 1500, agentRuns: 50000, sources: 200, sends: 10000 },
  },
};

/** What each meter counts, in the words somebody paying would use. */
export const METERS = {
  voiceMinutes: 'minutes spoken',
  agentRuns: 'times an agent went and looked',
  sends: 'messages that really went out',
  sources: 'spreadsheets and pages connected',
};

export const planOf = (id) => PLANS[id] ?? PLANS.trial;

/** Usage is per calendar month, because that is the unit an invoice uses. */
export const periodOf = (at = new Date()) => at.toISOString().slice(0, 7);

const blankUsage = (period) => ({
  period,
  voiceSeconds: 0,
  agentRuns: 0,
  sends: 0,
  decisions: 0,
  startedAt: new Date().toISOString(),
});

/**
 * The month's usage for a workspace, rolled over when the month turns.
 *
 * Rolling over rather than accumulating forever is the difference between a
 * meter and a total: nobody's allowance should be spent by what they did in
 * March.
 */
export function usageFor(workspace, at = new Date()) {
  const period = periodOf(at);
  if (!workspace.usage || workspace.usage.period !== period) {
    workspace.usage = blankUsage(period);
  }
  return workspace.usage;
}

export function record(workspace, meter, amount = 1, at = new Date()) {
  const usage = usageFor(workspace, at);
  usage[meter] = (usage[meter] ?? 0) + amount;
  return usage;
}

/**
 * Whether one more of something is within the allowance.
 *
 * Returns what it is refusing and by how much, because "limit reached" with no
 * number is a dead end for whoever hits it.
 */
export function allows(workspace, meter, { sources = 0 } = {}) {
  const plan = planOf(workspace.plan);
  const usage = usageFor(workspace);

  const used = {
    voiceMinutes: Math.ceil(usage.voiceSeconds / 60),
    agentRuns: usage.agentRuns,
    sends: usage.sends,
    sources,
  }[meter];

  const limit = plan.limits[meter];
  if (limit == null) return { ok: true };
  if (used < limit) return { ok: true, used, limit };

  return {
    ok: false,
    used,
    limit,
    meter,
    reason: `This workspace is on ${plan.name} and has used ${used} of ${limit} ` +
      `${METERS[meter]} this month. It resets on the first.`,
  };
}

/** Everything a person would want on a billing screen, counted rather than claimed. */
export function statement(workspace, { sources = 0 } = {}) {
  const plan = planOf(workspace.plan);
  const usage = usageFor(workspace);

  const lines = [
    ['voiceMinutes', Math.ceil(usage.voiceSeconds / 60)],
    ['agentRuns', usage.agentRuns],
    ['sends', usage.sends],
    ['sources', sources],
  ].map(([meter, used]) => {
    const limit = plan.limits[meter] ?? null;
    return {
      meter,
      label: METERS[meter],
      used,
      limit,
      // Rounded for a bar, not for a bill.
      share: limit ? Math.min(1, Math.round((used / limit) * 100) / 100) : null,
      over: limit != null && used >= limit,
    };
  });

  return {
    plan: { ...plan },
    period: usage.period,
    decisions: usage.decisions,
    lines,
    // Named so nobody has to infer it from four bars.
    headroom: lines.some((l) => l.over)
      ? lines.filter((l) => l.over).map((l) => l.label)
      : [],
  };
}
