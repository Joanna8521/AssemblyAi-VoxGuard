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

      // Published where the rest of the workforce already says it reads from.
      // Nine agents declare `metrics` and nobody was writing it, so the graph
      // described a business whose numbers never arrived anywhere.
      const col = (names) => findColumn(data.headers, names);
      const cols = {
        date: dateCol,
        revenue: moneyCol,
        spend: col(['ad spend', 'adspend', 'spend', 'ad cost', '廣告花費']),
        orders: col(['orders', 'order count', '訂單數', '訂單']),
        units: col(['units sold', 'units', 'quantity', 'qty', '件數']),
        returns: col(['returns', 'refunds', 'returned', '退貨']),
      };

      const daily = data.rows.map((r) => ({
        day: cols.date ? r[cols.date] : null,
        revenue: toNumber(r[cols.revenue]),
        spend: cols.spend ? toNumber(r[cols.spend]) : null,
        orders: cols.orders ? toNumber(r[cols.orders]) : null,
        units: cols.units ? toNumber(r[cols.units]) : null,
        returns: cols.returns ? toNumber(r[cols.returns]) : null,
        source: sheet.name ?? 'sheet',
      })).filter((d) => d.revenue !== null);

      pools.metrics = daily;
      pools.orders = daily;
      observed.push(`Columns found: ${Object.entries(cols)
        .filter(([, v]) => v).map(([k, v]) => `${k}="${v}"`).join(', ')}.`);

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
   * The analysts.
   *
   * None of these fetches anything. Daily Revenue publishes the rows it read
   * into `metrics`, and these read them from there, which is what the workforce
   * graph has claimed all along and what nobody was doing. It also means one
   * fetch serves the whole team instead of six agents pulling the same sheet.
   *
   * Each says what it cannot see rather than working around it: a shop whose
   * sheet has no ad spend column gets told that, not a made-up ROAS.
   */

  /** Ad Performance: what the spending bought, by the only measure available. */
  async A06({ pools }) {
    const rows = withBoth(pools, 'spend');
    if (!rows.length) return missing('metrics', 'an ad spend column');

    const roas = (r) => r.spend > 0 ? r.revenue / r.spend : null;
    const recent = rows.slice(-7);
    const earlier = rows.slice(0, -7);
    const avg = (list) => {
      const vals = list.map(roas).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const now = avg(recent), before = avg(earlier);
    const observed = [`Return on ad spend over the last ${recent.length} days: ` +
      `${now === null ? 'not calculable' : now.toFixed(2)}x` +
      `${before === null ? '' : `, against ${before.toFixed(2)}x before that`}.`];

    const intents = [];
    if (now !== null && before !== null && now < before * 0.7) {
      const drop = Math.round((1 - now / before) * 100);
      pools.signals = [...(pools.signals ?? []), {
        kind: 'roas_drop', percent: drop, at: new Date().toISOString(),
      }];
      observed.push(`That is ${drop}% worse, which is a real change rather than a quiet week.`);
      intents.push({
        action: 'pause_ad',
        parameters: { platform: 'meta' },
        why: `return on ad spend fell ${drop}%, from ${before.toFixed(2)}x to ${now.toFixed(2)}x`,
      });
    }
    return { observed, intents };
  },

  /** Budget Pacing: whether the month's spending is on course or ahead of it. */
  async A08({ pools }) {
    const rows = withBoth(pools, 'spend');
    if (!rows.length) return missing('metrics', 'an ad spend column');

    const perDay = rows.reduce((a, r) => a + r.spend, 0) / rows.length;
    const last = rows.at(-1).spend;
    const projected = perDay * 30;
    const observed = [
      `Spending averages ${Math.round(perDay)} a day over ${rows.length} days, ` +
      `which is ${Math.round(projected)} across a month.`,
    ];

    const intents = [];
    if (last > perDay * 1.5) {
      observed.push(`The latest day is ${Math.round(last)}, well above that pace.`);
      intents.push({
        action: 'change_ad_budget',
        parameters: { platform: 'meta', daily_total: Math.round(perDay) },
        why: `the last day spent ${Math.round(last)} against an average of ${Math.round(perDay)}`,
      });
    }
    return { observed, intents };
  },

  /** Returns Analysis: how much of what was sold came back. */
  async A21({ pools }) {
    const rows = (pools.orders ?? []).filter(
      (r) => r.returns !== null && r.orders !== null && r.orders > 0);
    if (!rows.length) return missing('orders', 'a returns column and an order count');

    const rate = (list) => {
      const o = list.reduce((a, r) => a + r.orders, 0);
      return o ? list.reduce((a, r) => a + r.returns, 0) / o : 0;
    };
    const recent = rate(rows.slice(-7));
    const before = rate(rows.slice(0, -7));

    const observed = [`Returns are running at ${(recent * 100).toFixed(1)}% of orders` +
      `${rows.length > 7 ? `, against ${(before * 100).toFixed(1)}% before` : ''}.`];

    if (recent > 0.1 && recent > before * 1.5) {
      pools.signals = [...(pools.signals ?? []), {
        kind: 'returns_spike', rate: recent, at: new Date().toISOString(),
      }];
      observed.push('That is high enough and sudden enough to be worth a look.');
    }
    return { observed, intents: [] };
  },

  /**
   * Anomaly Watch: days that do not belong with the others.
   *
   * Three standard deviations from the mean, on each column that exists. Not
   * clever, and deliberately so: a threshold somebody can check beats a score
   * they have to trust.
   */
  async A31({ pools }) {
    const rows = pools.metrics ?? [];
    if (rows.length < 8) return missing('metrics', 'at least eight days to compare');

    const observed = [];
    const found = [];
    for (const field of ['revenue', 'spend', 'orders', 'returns']) {
      const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
      if (vals.length < 8) continue;

      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      if (sd === 0) continue;

      for (const r of rows) {
        const v = r[field];
        if (v === null || v === undefined) continue;
        const z = (v - mean) / sd;
        if (Math.abs(z) >= 3) {
          found.push({ field, day: r.day, value: v, z: Math.round(z * 10) / 10 });
        }
      }
    }

    if (!found.length) {
      observed.push(`Nothing unusual across ${rows.length} days: every figure sits ` +
        'within three standard deviations of its own average.');
    } else {
      for (const f of found) {
        observed.push(`${f.day ?? 'a day'}: ${f.field} ${Math.round(f.value)} is ` +
          `${Math.abs(f.z)} standard deviations ${f.z > 0 ? 'above' : 'below'} normal.`);
      }
      pools.signals = [...(pools.signals ?? []),
        ...found.map((f) => ({ kind: 'anomaly', ...f, at: new Date().toISOString() }))];
    }
    return { observed, intents: [] };
  },

  /** Unit Economics: what is left per order once the advertising is paid for. */
  async A33({ pools }) {
    const rows = (pools.metrics ?? []).filter(
      (r) => r.orders !== null && r.orders > 0 && r.spend !== null);
    if (!rows.length) return missing('metrics', 'order counts and ad spend');

    const per = rows.map((r) => ({ day: r.day, value: (r.revenue - r.spend) / r.orders }));
    const mean = per.reduce((a, b) => a + b.value, 0) / per.length;
    const latest = per.at(-1);

    const observed = [
      `After advertising, each order leaves ${Math.round(mean)} on average across ` +
      `${per.length} days.`,
      `The latest day is ${Math.round(latest.value)}${latest.day ? ` (${latest.day})` : ''}.`,
    ];
    if (latest.value < mean * 0.6) {
      observed.push('Well below the average, so the last day cost more to sell than it usually does.');
    }
    return { observed, intents: [] };
  },

  /** Stock Forecast: how long what is on the shelf lasts at the current rate. */
  async A02({ pools }) {
    const rows = (pools.orders ?? []).filter((r) => r.units !== null);
    const listings = (pools.listings ?? []).filter((w) => w.variantsInStock != null);

    if (!rows.length) return missing('orders', 'a units sold column');
    const perDay = rows.slice(-14).reduce((a, r) => a + r.units, 0) /
      Math.min(14, rows.length);

    const observed = [`Selling ${perDay.toFixed(1)} units a day over the last ` +
      `${Math.min(14, rows.length)} days.`];

    if (!listings.length) {
      observed.push('No stock figure is being read, so days of cover cannot be worked out.');
      return { observed, intents: [] };
    }

    for (const w of listings) {
      // Variants in stock is not a unit count, and saying otherwise would be
      // inventing a number. What it does support is the ratio between shops.
      observed.push(`${label(w)}: ${w.variantsInStock} variants still available.`);
    }
    return { observed, intents: [] };
  },

  /** Keyword Research: the words the shops being watched actually use. */
  async A26({ pools }) {
    const titles = (pools.listings ?? []).map((w) => w.title).filter(Boolean);
    if (titles.length < 2) {
      return { observed: ['Fewer than two listings are being watched, so there is ' +
        'nothing to find a pattern in.'], intents: [] };
    }

    const stop = new Set(['the', 'and', 'for', 'with', 'a', 'in', 'of', 'to', 's']);
    const counts = new Map();
    for (const t of titles) {
      for (const word of t.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
        if (word.length < 3 || stop.has(word)) continue;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
    const top = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);

    return {
      observed: top.length
        ? [`Across ${titles.length} listings, the words that repeat are ` +
           `${top.map(([w, n]) => `${w} (${n})`).join(', ')}.`]
        : [`Across ${titles.length} listings no word repeats, so there is no ` +
           'shared vocabulary to report.'],
      intents: [],
    };
  },

  /** Listing Audit: what the pages being watched are missing. */
  async A13({ pools }) {
    const listings = pools.listings ?? [];
    if (!listings.length) return missing('listings', 'a product page to look at');

    const observed = [];
    const faults = [];
    for (const w of listings) {
      const problems = [];
      if (!w.title) problems.push('no readable title');
      else if (w.title.length < 15) problems.push(`a ${w.title.length}-character title`);
      if (w.price == null) problems.push('no price the page publishes');
      if (w.inStock === null || w.inStock === undefined) problems.push('no stock state');
      if (w.lastError) problems.push(w.lastError);

      if (problems.length) {
        faults.push({ url: w.url, problems });
        observed.push(`${label(w)}: ${problems.join('; ')}.`);
      }
    }
    if (!faults.length) {
      observed.push(`All ${listings.length} pages publish a title, a price and a stock state.`);
    } else {
      pools.content = [...(pools.content ?? []),
        ...faults.map((f) => ({ kind: 'listing_fault', ...f, at: new Date().toISOString() }))];
    }
    return { observed, intents: [] };
  },

  /** Repricer: where this shop sits against the ones being watched. */
  async A12({ pools }) {
    const priced = (pools.listings ?? []).filter((w) => typeof w.price === 'number');
    if (priced.length < 2) {
      return missing('listings', 'at least two pages publishing a price');
    }

    const sorted = [...priced].sort((a, b) => a.price - b.price);
    const mid = sorted[Math.floor(sorted.length / 2)].price;
    const observed = [
      `Across ${priced.length} watched products the middle price is ${mid}, ` +
      `from ${sorted[0].price} (${label(sorted[0])}) to ` +
      `${sorted.at(-1).price} (${label(sorted.at(-1))}).`,
    ];

    const intents = [];
    const dear = sorted.at(-1);
    if (dear.price > mid * 1.4) {
      observed.push(`${label(dear)} sits well above the rest.`);
      intents.push({
        action: 'update_price',
        parameters: { platform: 'website', decrease_percent: 10 },
        why: `${label(dear)} is priced ${Math.round((dear.price / mid - 1) * 100)}% above the middle of the market`,
      });
    }
    return { observed, intents };
  },

  /**
   * Ops Alerts: one message instead of six.
   *
   * Everything raised during a run, gathered and sent once. Six agents each
   * messaging separately is how a useful alert becomes something people mute.
   */
  async A25({ pools }) {
    const signals = pools.signals ?? [];
    if (!signals.length) {
      return { observed: ['Nothing was raised this run, so there is nothing to send.'], intents: [] };
    }

    const lines = signals.map((s) => {
      if (s.kind === 'out_of_stock') return `Sold out: ${s.product}`;
      if (s.kind === 'roas_drop') return `Return on ad spend down ${s.percent}%`;
      if (s.kind === 'returns_spike') return `Returns at ${(s.rate * 100).toFixed(1)}% of orders`;
      if (s.kind === 'anomaly') return `${s.day ?? 'A day'}: ${s.field} ${Math.round(s.value)} (${s.z} sd)`;
      return s.kind;
    });

    return {
      observed: [`${signals.length} raised this run, gathered into one message.`],
      intents: [{
        action: 'send_telegram_message',
        parameters: { text: `${signals.length} things worth knowing\n${lines.join('\n')}` },
        why: `${signals.length} signals were raised and nobody has been told`,
      }],
    };
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

/** Rows that carry both revenue and the named field, since a ratio needs both. */
function withBoth(pools, field) {
  return (pools.metrics ?? []).filter(
    (r) => r.revenue !== null && r[field] !== null && r[field] !== undefined);
}

/**
 * Said plainly when the numbers are not there.
 *
 * An agent that cannot see what it needs should say which pool and which column,
 * not return nothing and let the page imply it looked and found peace.
 */
const missing = (pool, what) => ({
  observed: [`Nothing in ${pool} has ${what}, so there is nothing to work out.`],
  intents: [],
});

const label = (watch) => watch.title || new URL(watch.url).hostname;
const host = (url) => new URL(url).hostname.replace(/^www\./, '');
