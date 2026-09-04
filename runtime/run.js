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

import { readProduct, readCatalogue } from './web.js';

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
   * Inventory Watch. Looks at the same watched products as Price Watch, but for
   * a different fact: whether anything can still be bought.
   *
   * This is a real stock-out detector, not a simulated one. A Shopify storefront
   * publishes per-variant availability, so "sold out" here is the shop saying so
   * rather than us inferring it. Where a page will not say, it says nothing:
   * a guessed stock level is the number somebody would act on.
   */
  async A01({ pools }) {
    const watches = pools.listings ?? [];
    if (!watches.length) {
      return { observed: ['Nothing is being watched, so there is no stock to watch.'], intents: [] };
    }

    // It goes and looks itself. Depending on another agent having run first
    // makes a watcher that is quietly blind whenever it happens to run alone,
    // and a watcher nobody can tell is blind is worse than no watcher.
    for (const w of watches) {
      if (w.inStock !== undefined && w.checkedAt &&
          Date.now() - Date.parse(w.checkedAt) < 60_000) continue;
      try {
        const product = await readProduct(w.url);
        w.title ??= product.title;
        w.price = product.price ?? w.price;
        w.inStock = product.inStock;
        w.variantsInStock = product.variantsInStock;
        w.variants = product.variants;
        w.via = product.via;
        w.checkedAt = new Date().toISOString();
        delete w.lastError;
      } catch (err) {
        w.lastError = err.message;
      }
    }

    const readable = watches.filter((w) => w.inStock !== null && w.inStock !== undefined);
    if (!readable.length) {
      return {
        observed: [`${watches.length} watched, none of which publishes availability.`],
        intents: [],
      };
    }

    const out = readable.filter((w) => w.inStock === false);
    const thin = readable.filter((w) => w.inStock && w.variantsInStock === 1);

    const observed = [
      `${readable.length} products readable, ${out.length} sold out, ${thin.length} down to a last variant.`,
      ...out.map((w) => `${label(w)}: sold out at ${w.price}`),
      ...thin.map((w) => `${label(w)}: one variant left at ${w.price}`),
    ];

    const intents = [];
    for (const w of out) {
      // Raising the signal is this agent's whole job. Whether anybody hears it,
      // and what anybody does about it, is not.
      if (w.reportedOut) continue;
      w.reportedOut = true;
      intents.push({
        action: 'send_telegram_message',
        parameters: { text: `Out of stock\n${label(w)}\nlast seen at ${w.price}\n${w.url}` },
        why: `${label(w)} is sold out`,
      });
    }
    for (const w of readable.filter((x) => x.inStock)) delete w.reportedOut;

    return { observed, intents };
  },

  /**
   * Creative Review, doing the job its name implies: noticing what rivals have
   * put out that we have not seen before.
   *
   * The first look at a shop is not news, it is a baseline, and reporting it as
   * forty new arrivals would train somebody to ignore the alerts. So the first
   * read is recorded silently and only what appears afterwards is worth saying.
   */
  async A07({ pools }) {
    const shops = pools.shops ?? [];
    if (!shops.length) {
      return {
        observed: ['No shops to keep an eye on yet. Add a rival storefront to give it something to do.'],
        intents: [],
      };
    }

    const observed = [];
    const intents = [];

    for (const shop of shops) {
      let catalogue;
      try {
        catalogue = await readCatalogue(shop.url);
      } catch (err) {
        shop.lastError = err.message;
        observed.push(`${host(shop.url)}: ${err.message}`);
        continue;
      }

      delete shop.lastError;
      shop.checkedAt = new Date().toISOString();
      const seen = new Set(shop.seen ?? []);
      const fresh = catalogue.filter((p) => !seen.has(p.handle));
      shop.seen = catalogue.map((p) => p.handle);

      if (!shop.baselined) {
        shop.baselined = true;
        observed.push(`${host(shop.url)}: ${catalogue.length} products noted as the baseline.`);
        continue;
      }

      if (!fresh.length) {
        observed.push(`${host(shop.url)}: ${catalogue.length} products, nothing new.`);
        continue;
      }

      observed.push(`${host(shop.url)}: ${fresh.length} new since last look — ` +
        fresh.slice(0, 4).map((p) => `${p.title}${p.price ? ` at ${p.price}` : ''}`).join('; '));

      intents.push({
        action: 'send_telegram_message',
        parameters: {
          text: `${fresh.length} new at ${host(shop.url)}\n` +
                fresh.slice(0, 5).map((p) => `${p.title}${p.price ? ` — ${p.price}` : ''}\n${p.url}`).join('\n'),
        },
        why: `${host(shop.url)} put out ${fresh.length} ${fresh.length === 1 ? 'product' : 'products'} we had not seen`,
      });
    }

    return { observed, intents };
  },

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
const host = (url) => new URL(url).hostname.replace(/^www\./, '');
