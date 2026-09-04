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
import { readSheet, findColumn, toNumber } from './sheets.js';

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
  session.settings ??= {};
  const result = await runner({ agent, pools: session.pools, settings: session.settings });
  return { ran: true, agent: agentId, at: new Date().toISOString(), ...result };
}

export const implementedAgents = () => Object.keys(RUNNERS);

// ── the ones that really work ───────────────────────────────────────────────

const RUNNERS = {
  /**
   * Daily Revenue, reading the operator's own spreadsheet.
   *
   * The first agent here that looks at the business rather than at its rivals.
   * It works out which columns hold the date and the money by the names people
   * actually use, says which ones it picked, and compares the most recent day
   * against the days before it.
   *
   * Where it cannot tell, it says so and stops. An agent that guesses a column
   * and reports a number is worse than one that reports nothing, because the
   * number is what somebody acts on.
   */
  async A30({ pools, settings = {} }) {
    // What counts as a fall worth waking somebody for. Somebody asked to be
    // told when takings fell off a cliff and was reasonably asked what a cliff
    // was; the number was hardcoded, so the answer had nowhere to go. Asking a
    // question the system cannot act on is worse than not asking.
    const drop = Number(settings.revenueDropPercent);
    const threshold = Number.isFinite(drop) && drop > 0 ? -Math.abs(drop) : -20;
    const sheets = pools.sheets ?? [];
    if (!sheets.length) {
      return {
        observed: ['No spreadsheet connected. Paste a Google Sheets link that is shared ' +
                   'as "anyone with the link can view".'],
        intents: [],
      };
    }

    const observed = [];
    const intents = [];

    for (const sheet of sheets) {
      let data;
      try {
        data = await readSheet(sheet.url);
      } catch (err) {
        sheet.lastError = err.message;
        observed.push(`${sheet.name ?? 'sheet'}: ${err.message}`);
        continue;
      }

      delete sheet.lastError;
      sheet.checkedAt = new Date().toISOString();
      sheet.rows = data.count;
      sheet.headers = data.headers;

      const dateCol = findColumn(data.headers, ['date', '日期', 'day', '訂單日期', '成立時間']);
      const moneyCol = findColumn(data.headers, ['revenue', 'total', 'amount', 'sales',
        '金額', '營收', '訂單金額', '銷售額', '合計']);

      if (!moneyCol) {
        observed.push(`${sheet.name ?? 'sheet'}: ${data.count} rows, ` +
          `but no column looks like money. Columns are ${data.headers.slice(0, 8).join(', ')}.`);
        continue;
      }

      const values = data.rows
        .map((r) => ({ when: dateCol ? r[dateCol] : null, value: toNumber(r[moneyCol]) }))
        .filter((v) => v.value !== null);

      if (!values.length) {
        observed.push(`${sheet.name ?? 'sheet'}: found "${moneyCol}" but no numbers in it.`);
        continue;
      }

      const total = values.reduce((s2, v) => s2 + v.value, 0);
      const latest = values.at(-1);
      const earlier = values.slice(0, -1);
      const average = earlier.length
        ? earlier.reduce((s2, v) => s2 + v.value, 0) / earlier.length
        : null;

      observed.push(
        `${sheet.name ?? 'sheet'}: ${values.length} rows of "${moneyCol}"` +
        `${dateCol ? ` by "${dateCol}"` : ''}, ${Math.round(total)} in total.`);

      if (average === null) continue;

      const change = Math.round((latest.value - average) / average * 1000) / 10;
      observed.push(
        `Latest ${latest.when ? `(${latest.when}) ` : ''}${Math.round(latest.value)} ` +
        `against an average of ${Math.round(average)}, ${change >= 0 ? 'up' : 'down'} ` +
        `${Math.abs(change)}%. Worth raising below ${Math.abs(threshold)}%.`);

      // A quiet day is not news. A drop somebody would want to know about is.
      if (change <= threshold) {
        intents.push({
          action: 'send_telegram_message',
          parameters: {
            text: `Revenue down ${Math.abs(change)}%\n` +
                  `${sheet.name ?? 'sheet'}: latest ${Math.round(latest.value)} ` +
                  `against an average of ${Math.round(average)}`,
          },
          why: `the latest figure is ${Math.abs(change)}% below the average`,
        });
      }
    }

    return { observed, intents };
  },

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

    // The signal is written down, not just announced. Whatever runs next needs
    // a cause it can point at, and a chain that starts from an announcement
    // nobody recorded is a chain that starts from nowhere.
    pools.signals = out.map((w) => ({
      kind: 'out_of_stock',
      product: label(w),
      url: w.url,
      price: w.price,
      at: new Date().toISOString(),
    }));

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
   * Emergency Response, picking up what Inventory Watch put down.
   *
   * Everything it wants comes from a signal somebody else raised about a real
   * product, so the chain has a cause at every link. None of it can be carried
   * out for real: no credential for a marketplace or an ad account exists
   * anywhere here, and each request says so when it is judged.
   */
  async A03({ pools }) {
    const signals = (pools.signals ?? []).filter((s) => s.kind === 'out_of_stock');
    if (!signals.length) {
      return { observed: ['Nothing has been raised, so there is nothing to respond to.'], intents: [] };
    }

    const observed = [];
    const intents = [];

    // Handed forward, not just acted on. Customer Desk reads `content`, and
    // reaching into `signals` behind its back would make the drawn graph a
    // decoration rather than a description of what happens.
    pools.content = signals.map((s) => ({
      kind: 'out_of_stock_notice',
      product: s.product,
      line: `We are sorry: ${s.product} sold out before we could ship yours.`,
      at: new Date().toISOString(),
    }));

    for (const signal of signals) {
      observed.push(`Acting on ${signal.product} being sold out.`);
      for (const [action, why] of [
        ['pause_ad', 'ads pointing at something nobody can buy are burning money'],
        ['delist_product', 'the listing should come down while it is unavailable'],
        ['mark_out_of_stock', 'the storefront should say so rather than take the order'],
      ]) {
        intents.push({
          action,
          parameters: { platform: 'shopee', product: signal.product },
          why: `${signal.product} is sold out and ${why}`,
        });
      }
    }
    return { observed, intents };
  },

  /**
   * Customer Desk. The only one here that reaches a person who is not the
   * operator, which is why it is usually the one that gets stopped.
   */
  async A23({ pools }) {
    const notices = (pools.content ?? []).filter((c) => c.kind === 'out_of_stock_notice');
    if (!notices.length) {
      return { observed: ['Nothing written for a customer to receive.'], intents: [] };
    }
    return {
      observed: notices.map((n) => `${n.product}: a line is ready for whoever ordered it.`),
      intents: notices.map((n) => ({
        action: 'notify_customer',
        parameters: { customer_group: 'paid_affected', text: n.line },
        why: `people have paid for ${n.product} and it is gone`,
      })),
    };
  },

  /**
   * Order Desk. Everything it can do to an order costs money and cannot be
   * undone, which is why it asks for the thing that is usually refused.
   */
  async A04({ pools }) {
    const signals = (pools.signals ?? []).filter((s) => s.kind === 'out_of_stock');
    if (!signals.length) {
      return { observed: ['No orders in question.'], intents: [] };
    }
    return {
      observed: signals.map((s) => `Orders for ${s.product} cannot be fulfilled.`),
      intents: signals.map((s) => ({
        action: 'issue_refund',
        parameters: { amount: s.price ?? 0, count: 14 },
        why: `nobody can be sent a ${s.product}`,
      })),
    };
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
