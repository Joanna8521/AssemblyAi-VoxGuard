/**
 * The one agent that reads every source at once, and so the one that could most
 * easily overstate what it knows.
 *
 * Three things being true on the same day is not one of them causing the
 * others. An assistant that quietly upgrades coincidence to cause is worse than
 * one that says nothing, because somebody acts on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runAgent } from '../runtime/run.js';

const workforce = JSON.parse(readFileSync(new URL('../agents/workforce.json', import.meta.url)));

const days = (n, f) => Array.from({ length: n }, (_, i) => ({
  day: `2026-08-${String(i + 1).padStart(2, '0')}`,
  revenue: 4000, spend: 500, orders: 15, units: 20, returns: 1, product: 'Chilton Parka',
  ...f(i),
}));

const run = (pools) => runAgent('A37', { session: { pools }, workforce });

test('it names the day that fell, and by how much against what', async () => {
  const metrics = days(20, (i) => (i === 19 ? { revenue: 2000 } : {}));
  const r = await run({ metrics, orders: metrics, listings: [] });
  const text = r.observed.join(' ');

  assert.match(text, /2026-08-20/, 'the day itself');
  assert.match(text, /50%/, 'measured against the week before it, not against nothing');
});

test('it never presents things happening together as one causing the other', async () => {
  const metrics = days(20, (i) => (i === 19 ? { revenue: 2000, spend: 100 } : {}));
  const r = await run({
    metrics, orders: metrics,
    listings: [{ url: 'https://x.test/p', title: 'Chilton Parka', inStock: false }],
  });
  const text = r.observed.join(' ');

  for (const word of [/\bbecause\b/i, /\bcaused\b/i, /\bdue to\b/i, /\bexplains\b/i, /\bwhy\b/i]) {
    assert.doesNotMatch(text, word, `it must not claim cause (${word})`);
  }
  assert.match(text, /not the same as one of them causing another/,
    'and it must say so out loud rather than leaving it implied');
});

test('the join is reported as a coincidence in time, with what it cannot see', async () => {
  const metrics = days(20, (i) => (i === 19 ? { revenue: 2000 } : {}));
  const r = await run({
    metrics, orders: metrics,
    listings: [{ url: 'https://x.test/p', title: 'Chilton Parka', inStock: false }],
  });
  const text = r.observed.join(' ');

  assert.match(text, /Chilton Parka/);
  assert.match(text, /not something these readings can say/,
    'it cannot know whether the product was already gone on the day');
});

test('with no price history it says so rather than implying prices held steady', async () => {
  const metrics = days(20, (i) => (i === 19 ? { revenue: 2000 } : {}));
  const r = await run({
    metrics, orders: metrics,
    listings: [{ url: 'https://x.test/p', title: 'Something Else', price: 100, inStock: true }],
  });
  assert.match(r.observed.join(' '), /no price history/);
});

test('a sold-out product the sheet never credits is not quietly attached to the fall', async () => {
  const metrics = days(20, (i) => (i === 19 ? { revenue: 2000 } : {}));
  const r = await run({
    metrics, orders: metrics,
    listings: [{ url: 'https://x.test/p', title: 'Unrelated Hat', inStock: false }],
  });
  assert.match(r.observed.join(' '), /none of them is what the sheet credits/);
});

test('too few days and it declines rather than finding a pattern in four numbers', async () => {
  const metrics = days(4, () => ({}));
  const r = await run({ metrics, orders: metrics, listings: [] });
  assert.match(r.observed.join(' '), /at least eight days/);
  assert.deepEqual(r.intents, []);
});
