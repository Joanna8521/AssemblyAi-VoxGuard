/**
 * The ledger exists so a question about last month has an answer, so the tests
 * are about surviving and counting rather than about shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MemoryLedger, KVLedger, entryFrom, report } from './ledger.js';
import { blueprint } from './mission.js';

const workforce = JSON.parse(readFileSync(new URL('../agents/workforce.json', import.meta.url)));

const at = (day) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
const row = (over = {}) => ({
  at: at(3), missionId: 'M-001', agent: 'Order Desk', action: 'issue_refund',
  verdict: 'DENY', reasonCode: 'explicit_deny', risk: 'L4', adapter: 'shopify',
  performed: false, real: false, policyId: 'P1', policyVersion: 1, ...over,
});

test('a tenant only ever sees its own decisions', async () => {
  const l = new MemoryLedger();
  await l.append('alice', [row()]);
  await l.append('bob', [row({ agent: 'Customer Desk' }), row()]);

  assert.equal((await l.read('alice')).length, 1);
  assert.equal((await l.read('bob')).length, 2);
  assert.equal((await l.read('nobody')).length, 0);
});

test('appends accumulate rather than replace', async () => {
  const l = new MemoryLedger();
  for (let i = 0; i < 5; i++) await l.append('t', [row()]);
  assert.equal((await l.read('t')).length, 5);
});

test('the KV ledger appends with RPUSH, never a read-modify-write', async () => {
  // The distinction is the whole reason for the class. A get-then-set loses one
  // of two concurrent appends, silently, under exactly the load worth auditing.
  const calls = [];
  const kv = {
    rpush: (...a) => { calls.push(['rpush', ...a]); return 1; },
    ltrim: () => 'OK', expire: () => 1,
    lrange: () => [JSON.stringify(row())],
    get: () => { throw new Error('the ledger must not read before it writes'); },
    set: () => { throw new Error('the ledger must not overwrite'); },
  };
  const l = new KVLedger(kv);
  await l.append('t', [row(), row()]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'rpush');
  assert.equal(calls[0][2].length, 2, 'both entries in one push');
  assert.equal((await l.read('t')).length, 1);
});

test('a corrupt row does not take the report down with it', async () => {
  const kv = {
    lrange: () => ['{not json', JSON.stringify(row())],
    rpush: () => 1, ltrim: () => 'OK', expire: () => 1,
  };
  assert.equal((await new KVLedger(kv).read('t')).length, 1);
});

test('the report counts what an operator asks about', () => {
  const r = report([
    row({ verdict: 'ALLOW', action: 'pause_ad', performed: true, real: true, agent: 'Emergency Response' }),
    row({ verdict: 'ALLOW', action: 'delist_product', performed: true, real: false, agent: 'Emergency Response' }),
    row({ verdict: 'ASK', action: 'notify_customer', agent: 'Customer Desk' }),
    row({ verdict: 'DENY', action: 'issue_refund' }),
  ], { days: 36500 });

  assert.deepEqual(r.verdicts, { ALLOW: 2, ASK: 1, DENY: 1 });
  assert.equal(r.interventionRate, 0.5);
  // Reached the world for real, versus authorised but sandboxed. Conflating
  // these is how a governance tool starts overstating its own reach.
  assert.equal(r.reached.real, 1);
  assert.equal(r.reached.sandboxed, 1);
  assert.equal(r.stoppedByAction.length, 2);
  assert.equal(r.byAgent[0].name, 'Emergency Response');
});

test('the window actually excludes what falls outside it', () => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  const rows = [row({ at: old }), row({ at: new Date().toISOString() })];
  assert.equal(report(rows, { days: 30 }).window.decisions, 1);
  assert.equal(report(rows, { days: 36500 }).window.decisions, 2);
});

test('an empty ledger reports zero rather than dividing by it', () => {
  const r = report([], { days: 30 });
  assert.equal(r.interventionRate, 0);
  assert.equal(r.window.decisions, 0);
});

test('nobody runs before the agent that writes what it reads', () => {
  // The regression this pins: Customer Desk reads `content`, which Emergency
  // Response writes. Ordering on triggers alone, and then breaking a dependency
  // cycle at whichever agent had fewest dependencies, both put Customer Desk
  // first, where it truthfully reported that nothing had happened yet.
  const team = ['A01', 'A02', 'A03', 'A04', 'A23', 'A31'];
  const mission = {
    team: team.map((id) => ({ id })),
    policy: { rules: [] },
  };
  const order = blueprint(mission, workforce.agents).stages.map((s) => s.id);

  assert.equal(order.length, team.length, 'a cycle must not drop anybody');
  assert.ok(order.indexOf('A01') < order.indexOf('A03'),
    'Emergency Response reads the signals Inventory Watch raises');
  assert.ok(order.indexOf('A03') < order.indexOf('A23'),
    'Customer Desk reads the notice Emergency Response writes');
});

test('starting again does not throw away what was connected', async () => {
  // Reset cleared the whole session, which took the spreadsheet somebody had
  // pasted and the storefronts they were watching with it. Those are setup,
  // not state: the point of reset is to drop the work and the permissions.
  const { MemoryStore } = await import('./store.js');
  const store = new MemoryStore();

  const session = await store.get('t');
  session.pools = { sheets: [{ url: 'x' }], listings: [{ url: 'y' }] };
  session.settings = { revenueDropPercent: 35 };
  session.policy = { rules: [{ action: 'issue_refund', effect: 'DENY' }] };
  session.audit = [{ action: 'issue_refund' }];
  await store.put('t', session);

  // What the route does: keep the sources, clear everything else.
  const pools = session.pools, settings = session.settings;
  await store.clear('t');
  const fresh = await store.get('t');
  fresh.pools = pools;
  fresh.settings = settings;
  await store.put('t', fresh);

  const after = await store.get('t');
  assert.equal(after.pools.sheets.length, 1, 'the sheet survives');
  assert.equal(after.pools.listings.length, 1, 'the watched pages survive');
  assert.equal(after.settings.revenueDropPercent, 35, 'and the threshold');
  assert.equal(after.policy, null, 'but the permissions do not');
  assert.deepEqual(after.audit, [], 'nor the decisions');
});

test('nothing in force is a state the page has to be able to show', async () => {
  // The rule bands were drawn only when a policy existed, so a reset that
  // cleared one left its prohibitions on screen. The failure is not a gap; it
  // is the page stating that two actions are forbidden when nothing forbids
  // them, which is the wrong direction for this tool to be wrong in.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  const refresh = src.slice(src.indexOf('async function refresh()'));
  const body = refresh.slice(0, refresh.indexOf('\n}\n') + 3);

  assert.match(body, /renderBands\(\{ rules: \[\] \}\)/,
    'refresh must clear the bands when the server reports no policy');
  assert.ok(body.includes('} else {'),
    'and it must have the branch that does it');
});

test('opening a mission keeps the rules already in force', async () => {
  // A rule was spoken, recorded, and confirmed out loud, and then the mission
  // that followed replaced the policy and deleted it. The workforce was refused
  // the very action the person had just authorised, with the honest reason that
  // no rule authorised it, which was true and appalling.
  const { compile } = await import('./policy.js');
  const standing = compile({ rules: [
    { action: 'send_telegram_message', effect: 'ALLOW' },
    { action: 'update_price', effect: 'DENY' },
  ] });

  // What the route does when a mission opens on top of it.
  const spokenNow = [{ action: 'update_price', effect: 'ASK' }];
  const spoken = new Set(spokenNow.map((r) => r.action));
  const carried = standing.rules.filter((r) => !spoken.has(r.action));
  const merged = [...carried, ...spokenNow];

  const byAction = new Map(merged.map((r) => [r.action, r.effect]));
  assert.equal(byAction.get('send_telegram_message'), 'ALLOW', 'the untouched rule survives');
  assert.equal(byAction.get('update_price'), 'ASK', 'and the one restated now wins');
  assert.equal(merged.length, 2, 'without leaving a duplicate behind');
});
