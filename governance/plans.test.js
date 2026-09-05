/**
 * Metering, and the one thing it must never touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PLANS, planOf, allows, record, statement, usageFor, periodOf } from './plans.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = (over = {}) => ({ plan: 'trial', ...over });

test('a fresh workspace is on the free plan, not on nothing', () => {
  assert.equal(planOf(undefined).id, 'trial');
  assert.equal(planOf('nonsense').id, 'trial');
});

test('usage rolls over with the month rather than accumulating for ever', () => {
  const w = ws();
  record(w, 'sends', 5, new Date('2026-08-20T00:00:00Z'));
  assert.equal(usageFor(w, new Date('2026-08-21T00:00:00Z')).sends, 5);

  // Nobody's September allowance should be spent by what they did in August.
  assert.equal(usageFor(w, new Date('2026-09-01T00:00:00Z')).sends, 0);
  assert.equal(usageFor(w, new Date('2026-09-01T00:00:00Z')).period, periodOf(new Date('2026-09-01T00:00:00Z')));
});

test('an allowance refuses at the limit, and says by how much', () => {
  const w = ws();
  w.usage = { period: periodOf(), voiceSeconds: 0, agentRuns: 200, sends: 0, decisions: 0 };

  const room = allows(w, 'agentRuns');
  assert.equal(room.ok, false);
  assert.equal(room.used, 200);
  assert.equal(room.limit, 200);
  // A refusal with no number is a dead end for whoever hits it.
  assert.match(room.reason, /200 of 200/);
  assert.match(room.reason, /resets/);
});

test('a bigger plan lifts the same usage clear of the limit', () => {
  const usage = { period: periodOf(), voiceSeconds: 0, agentRuns: 400, sends: 0, decisions: 0 };
  assert.equal(allows(ws({ usage }), 'agentRuns').ok, false);
  assert.equal(allows(ws({ plan: 'shop', usage }), 'agentRuns').ok, true);
});

test('voice is billed by the minute it was open, rounded up', () => {
  const w = ws();
  record(w, 'voiceSeconds', 61);
  assert.equal(statement(w).lines.find((l) => l.meter === 'voiceMinutes').used, 2);
});

test('the statement names what has run out rather than leaving it in the bars', () => {
  const w = ws({ usage: { period: periodOf(), voiceSeconds: 60 * 30, agentRuns: 0, sends: 0, decisions: 0 } });
  assert.deepEqual(statement(w).headroom, ['minutes spoken']);
});

test('nothing bills or blocks before a decision is made', () => {
  // The line that matters most here. An allowance may stop an agent going out
  // and may stop a message leaving, but it must never stop a request being
  // judged or recorded: a refusal that failed to happen because of billing is
  // the one failure this system must not have.
  const src = readFileSync(join(ROOT, 'server', 'app.js'), 'utf8');
  const decide = src.slice(src.indexOf('async function decide('));
  const body = decide.slice(0, decide.indexOf('\n}\n'));

  const evaluateAt = body.indexOf('evaluate(');
  const recordAt = body.indexOf('record(session');
  const meterAt = body.search(/\busageFor\(session\)|\bmeter\(session/);

  assert.ok(evaluateAt !== -1 && recordAt !== -1 && meterAt !== -1);
  assert.ok(evaluateAt < meterAt, 'the verdict is reached before anything is metered');
  assert.ok(recordAt < meterAt, 'and written down before anything is metered');
  assert.doesNotMatch(body, /allows\(/, 'decide() must not consult an allowance at all');
});

test('every plan states a price, even when it is nothing', () => {
  for (const p of Object.values(PLANS)) {
    assert.equal(typeof p.price, 'number', `${p.id} needs a price`);
    assert.ok(p.blurb, `${p.id} needs to say what it is for`);
    for (const meter of ['voiceMinutes', 'agentRuns', 'sources', 'sends']) {
      assert.equal(typeof p.limits[meter], 'number', `${p.id} needs a ${meter} limit`);
    }
  }
});
