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

import { readProduct } from './web.js';

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
      let product;
      try {
        product = await readProduct(watch.url);
      } catch (err) {
        watch.lastError = err.message;
        watch.checkedAt = new Date().toISOString();
        observed.push(`${label(watch)}: could not be read (${err.message})`);
        continue;
      }

      const was = { price: watch.price ?? null, inStock: watch.inStock ?? null };

      watch.title ??= product.title;
      watch.via = product.via;
      watch.checkedAt = new Date().toISOString();
      delete watch.lastError;

      if (product.price === null) {
        watch.readable = false;
        observed.push(`${label(watch)}: fetched, but states no price this reader can find`);
        continue;
      }

      watch.readable = true;
      watch.price = product.price;
      watch.inStock = product.inStock;
      watch.variantsInStock = product.variantsInStock;
      watch.history = [...(watch.history ?? []).slice(-19),
        { at: watch.checkedAt, price: product.price, inStock: product.inStock }];

      const stock = product.inStock === null ? ''
        : product.inStock ? `, ${product.variantsInStock}/${product.variants} in stock`
        : ', sold out';

      if (was.price === null) {
        observed.push(`${label(watch)}: ${product.price}${stock} (first reading, via ${product.via})`);
        continue;
      }

      // Price and stock are separate facts and are reported separately. A shop
      // that sells out is news even when the price never moved.
      if (was.price !== product.price) {
        const direction = product.price < was.price ? 'down' : 'up';
        const percent = Math.round(Math.abs(product.price - was.price) / was.price * 1000) / 10;
        observed.push(`${label(watch)}: ${was.price} -> ${product.price} (${direction} ${percent}%)${stock}`);
        intents.push({
          action: 'send_telegram_message',
          parameters: {
            text: `Price ${direction} ${percent}%\n${label(watch)}\n` +
                  `${was.price} -> ${product.price}\n${watch.url}`,
          },
          why: `${label(watch)} moved ${direction} by ${percent}%`,
        });
      } else if (was.inStock !== null && was.inStock !== product.inStock) {
        observed.push(`${label(watch)}: ${product.inStock ? 'back in stock' : 'sold out'} at ${product.price}`);
        intents.push({
          action: 'send_telegram_message',
          parameters: {
            text: `${product.inStock ? 'Back in stock' : 'Sold out'}\n${label(watch)}\n${watch.url}`,
          },
          why: `${label(watch)} went ${product.inStock ? 'back in stock' : 'out of stock'}`,
        });
      } else {
        observed.push(`${label(watch)}: ${product.price}${stock}, unchanged`);
      }
    }

    return { observed, intents };
  },
};

const label = (watch) => watch.title || new URL(watch.url).hostname;
