/**
 * Agents that actually run.
 *
 * Until now the workforce was thirty-six entries in a JSON file describing work
 * that nobody did, and the governance layer was refusing actions that were never
 * going to happen. This is where an agent does its own work: really fetches a
 * page, really compares it to what it saw last time, really decides something
 * has changed, and really tries to tell somebody.
 *
 * The division that matters: an agent does its own reading and thinking
 * unsupervised, and the moment it wants to touch the outside world it asks. It
 * cannot call an adapter, and it does not decide whether it may. It returns
 * intents, and the caller puts each one through the evaluator.
 */

import { fetchPublicPage, extractPrice, extractTitle } from './web.js';

/**
 * @returns {{
 *   ran: boolean, agent: string, at: string,
 *   observed: string[],   what it saw, for the person to read
 *   intents: {action: string, parameters: object, why: string}[],
 * }}
 */
export async function runAgent(agentId, { session, workforce }) {
  const agent = workforce.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`no agent ${agentId}`);

  const runner = RUNNERS[agentId];
  if (!runner) {
    // Said plainly rather than faked. Most of this workforce is a description of
    // work, not an implementation of it, and a page that blurs the two would be
    // the same dishonesty the rest of this project is built to avoid.
    return {
      ran: false, agent: agentId, at: new Date().toISOString(),
      observed: [`${agent.name} is described but not implemented yet, so it did nothing.`],
      intents: [],
    };
  }

  session.pools ??= {};
  const result = await runner({ agent, pools: session.pools });
  return { ran: true, agent: agentId, at: new Date().toISOString(), ...result };
}

export const implementedAgents = () => Object.keys(RUNNERS);

// ── the ones that really work ───────────────────────────────────────────────

const RUNNERS = {
  /**
   * Price Watch. Fetches every watched page, reads the price the page states,
   * and compares it to the price it stated last time.
   *
   * A page that cannot be read is recorded as unreadable rather than as
   * unchanged. Those are different facts, and treating the first as the second
   * is how a watcher goes quiet without anybody noticing.
   */
  async A11({ pools }) {
    const watches = pools.listings ?? [];
    if (!watches.length) {
      return {
        observed: ['Nothing is being watched yet. Add a competitor URL to give it something to do.'],
        intents: [],
      };
    }

    const observed = [];
    const intents = [];

    for (const watch of watches) {
      let page;
      try {
        page = await fetchPublicPage(watch.url);
      } catch (err) {
        watch.lastError = err.message;
        watch.checkedAt = new Date().toISOString();
        observed.push(`${label(watch)}: could not be read (${err.message})`);
        continue;
      }

      const price = extractPrice(page.html);
      watch.title ??= extractTitle(page.html);
      watch.checkedAt = new Date().toISOString();
      delete watch.lastError;

      if (!price) {
        watch.readable = false;
        observed.push(`${label(watch)}: fetched, but the page states no price this fetcher can find`);
        continue;
      }

      watch.readable = true;
      const previous = watch.price ?? null;
      watch.price = price.amount;
      watch.via = price.via;
      watch.history = [...(watch.history ?? []).slice(-19),
        { at: watch.checkedAt, price: price.amount }];

      if (previous === null) {
        observed.push(`${label(watch)}: ${price.amount} (first reading, via ${price.via})`);
        continue;
      }

      if (previous === price.amount) {
        observed.push(`${label(watch)}: ${price.amount}, unchanged`);
        continue;
      }

      const direction = price.amount < previous ? 'down' : 'up';
      const percent = Math.round(Math.abs(price.amount - previous) / previous * 1000) / 10;
      observed.push(`${label(watch)}: ${previous} -> ${price.amount} (${direction} ${percent}%)`);

      // Something changed, so somebody should know. Whether they are told is
      // not this agent's decision.
      intents.push({
        action: 'send_telegram_message',
        parameters: {
          text: `Price ${direction} ${percent}%: ${label(watch)}\n` +
                `${previous} -> ${price.amount}\n${watch.url}`,
        },
        why: `${label(watch)} moved ${direction} by ${percent}%`,
      });
    }

    return { observed, intents };
  },
};

const label = (watch) => watch.title || new URL(watch.url).hostname;
