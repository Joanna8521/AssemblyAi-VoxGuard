/**
 * The ledger: what this workforce has actually done, kept.
 *
 * The audit trail used to live inside the session blob, which meant it shared
 * the session's six-hour life. That is fine for showing the last few decisions
 * on screen and useless for anything a business would want: nobody can ask what
 * their agents tried to do last month if the answer expires before lunch.
 *
 * So the record is separate from the session and outlives it. Two properties
 * matter and neither is optional:
 *
 *   append-only   a decision is a fact about the past. Nothing here edits or
 *                 deletes an entry, and the store is driven with RPUSH rather
 *                 than read-modify-write, so two writes at once cannot lose one.
 *
 *   per tenant    entries are keyed by the same id that owns the policy. A
 *                 shared ledger on a public URL would mix strangers' decisions
 *                 into each other's reports, which is worse than having none.
 *
 * What it is not: this is a record of decisions, not an accounting system, and
 * it holds no personal data beyond the parameters an action was called with.
 */

const NINETY_DAYS = 60 * 60 * 24 * 90;
const CAP = 5000;   // Per tenant. Beyond this the oldest go; a report does not
                    // need the sixth thousand decision and a KV value has limits.

/** One decision, flattened to the shape a report can count without parsing. */
export function entryFrom(record, context = {}) {
  return {
    at: record.at,
    missionId: context.missionId ?? null,
    mission: context.brief ?? null,
    agent: context.agent ?? null,
    action: record.action,
    verdict: record.verdict,
    reasonCode: record.reasonCode,
    risk: record.risk,
    adapter: record.adapter,
    performed: record.performed === true,
    real: record.real === true,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
  };
}

export class MemoryLedger {
  #books = new Map();

  async append(tenant, entries) {
    const book = this.#books.get(tenant) ?? [];
    book.push(...entries);
    this.#books.set(tenant, book.slice(-CAP));
  }

  async read(tenant, { limit = CAP } = {}) {
    return (this.#books.get(tenant) ?? []).slice(-limit);
  }
}

/**
 * Redis lists over the same REST shape the session store uses. RPUSH is the
 * point: appends from two requests at once both land, which a get-modify-set
 * cannot promise and would silently get wrong under exactly the load that
 * makes a ledger worth keeping.
 */
export class KVLedger {
  constructor(kv, { prefix = 'standingorder:ledger:' } = {}) {
    this.kv = kv;
    this.prefix = prefix;
  }

  #key(tenant) { return `${this.prefix}${tenant}`; }

  async append(tenant, entries) {
    if (!entries.length) return;
    const key = this.#key(tenant);
    await this.kv.rpush(key, entries.map((e) => JSON.stringify(e)));
    await this.kv.ltrim(key, -CAP, -1);
    await this.kv.expire(key, NINETY_DAYS);
  }

  async read(tenant, { limit = CAP } = {}) {
    const raw = await this.kv.lrange(this.#key(tenant), -limit, -1);
    return (raw ?? []).map((r) => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
  }
}

/**
 * The report.
 *
 * Written to answer the questions an operator actually asks at the end of a
 * month, in the order they ask them: how much did this thing do, what did it
 * want to do that I stopped, and did anything reach the outside world.
 *
 * Counted rather than summarised by a model, so two runs over the same ledger
 * give the same numbers and a figure can be traced to the rows behind it.
 */
export function report(entries, { days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = entries.filter((e) => Date.parse(e.at) >= since);

  const tally = (key, filter = () => true) => {
    const counts = new Map();
    for (const e of rows) {
      if (!filter(e)) continue;
      const k = e[key] ?? 'unattributed';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };

  const verdicts = { ALLOW: 0, ASK: 0, DENY: 0 };
  for (const e of rows) if (e.verdict in verdicts) verdicts[e.verdict]++;

  // Per day, so a chart has something to draw and a quiet week is visible as a
  // quiet week rather than as an absence of data.
  const byDay = new Map();
  for (const e of rows) {
    const day = (e.at ?? '').slice(0, 10);
    if (!day) continue;
    const d = byDay.get(day) ?? { day, ALLOW: 0, ASK: 0, DENY: 0 };
    if (e.verdict in d) d[e.verdict]++;
    byDay.set(day, d);
  }

  const held = rows.filter((e) => e.verdict !== 'ALLOW');

  return {
    window: { days, from: new Date(since).toISOString(), decisions: rows.length },
    verdicts,
    // The number worth putting on a slide: how often a person had to be in it.
    interventionRate: rows.length ? +(held.length / rows.length).toFixed(3) : 0,
    reached: {
      // Authorised and carried out for real, as against authorised and sandboxed.
      // Conflating them is how a governance tool starts lying about its reach.
      performed: rows.filter((e) => e.performed).length,
      real: rows.filter((e) => e.real).length,
      sandboxed: rows.filter((e) => e.performed && !e.real).length,
    },
    byAction: tally('action'),
    byAgent: tally('agent'),
    byRisk: tally('risk'),
    stoppedByAction: tally('action', (e) => e.verdict !== 'ALLOW'),
    whyStopped: tally('reasonCode', (e) => e.verdict !== 'ALLOW'),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    missions: [...new Set(rows.map((e) => e.missionId).filter(Boolean))].length,
  };
}
