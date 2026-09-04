/**
 * The composer has to be right for a reason it can state.
 *
 * Anything can return a plausible team. What matters is that the same mission
 * always returns the same one, that a different mission returns a different
 * one, and that the answer can be traced to something other than taste. Those
 * are the properties tested here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compose } from './composer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workforce = JSON.parse(readFileSync(join(ROOT, 'agents', 'workforce.json'), 'utf8'));
const agents = workforce.agents;

const ids = (r) => r.team.map((m) => m.agent.id).sort();

const STOCK_OUT = ['read_inventory', 'pause_ad', 'delist_product', 'mark_out_of_stock',
                   'notify_customer', 'issue_refund'];
const REVENUE = ['read_metrics', 'read_orders', 'analyze_data', 'forecast', 'generate_report'];
const CAMPAIGN = ['draft_plan', 'draft_copy', 'apply_discount', 'update_price', 'publish_social_post'];

describe('who gets picked', () => {
  test('a mission gets a team, not the whole workforce', () => {
    const r = compose(STOCK_OUT, agents);
    assert.ok(r.team.length > 0);
    assert.ok(r.team.length < agents.length / 2,
      `picked ${r.team.length} of ${agents.length}; that is a roster, not a team`);
  });

  test('different missions get different teams', () => {
    // The point of a large pool is that it discriminates. If a stock-out and a
    // revenue investigation staff the same people, the pool is decoration.
    const a = ids(compose(STOCK_OUT, agents));
    const b = ids(compose(REVENUE, agents));
    const c = ids(compose(CAMPAIGN, agents));
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(b, c);
    assert.notDeepEqual(a, c);
  });

  test('the same mission always gets the same team', () => {
    // A team that varies between runs cannot be explained, and an explanation
    // is the only thing separating this from a guess.
    const first = ids(compose(STOCK_OUT, agents));
    for (let i = 0; i < 5; i++) assert.deepEqual(ids(compose(STOCK_OUT, agents)), first);
  });

  test('the desk that reaches customers is on a mission that reaches customers', () => {
    const r = compose(STOCK_OUT, agents);
    assert.ok(r.team.some((m) => m.agent.actions.includes('notify_customer')));
  });

  test('and is not on one that does not', () => {
    const r = compose(REVENUE, agents);
    assert.ok(!r.team.some((m) => m.agent.department === 'msg'),
      'a revenue investigation has no business staffing the desk that messages customers');
  });
});

describe('why, not just who', () => {
  test('every member carries a reason', () => {
    for (const m of compose(STOCK_OUT, agents).team) {
      assert.ok(m.reason && m.reason.length > 8, `${m.agent.id} has no reason`);
    }
  });

  test('a sole owner is described as one', () => {
    // Only the Order Desk can refund, so that is what its reason should say.
    const r = compose(['issue_refund', 'read_orders'], agents);
    const desk = r.team.find((m) => m.agent.actions.includes('issue_refund'));
    assert.match(desk.reason, /only one/);
  });

  test('an action nobody can do is reported, not silently dropped', () => {
    const r = compose(['read_metrics', 'launch_the_missiles'], agents);
    assert.deepEqual(r.uncovered, ['launch_the_missiles']);
    assert.match(r.why, /nothing in this workforce/);
  });

  test('the ones left out are named, with what made them redundant', () => {
    const r = compose(REVENUE, agents);
    assert.ok(r.considered.length > 0);
    for (const c of r.considered) assert.match(c.reason, /already covered/);
  });
});

describe('the team holds together', () => {
  test('an agent that only runs on a signal brings in what raises it', () => {
    // Emergency Response never wakes by itself. A picture of it working with no
    // upstream would be a picture of work starting from nowhere.
    const r = compose(['delist_product', 'mark_out_of_stock'], agents);
    const emergency = r.team.find((m) => m.agent.id === 'A03');
    assert.ok(emergency, 'Emergency Response should be picked for a delist');
    for (const upstream of emergency.agent.triggered_by ?? []) {
      assert.ok(r.team.some((m) => m.agent.id === upstream),
        `${upstream} wakes A03 and should be on the team`);
    }
  });

  test('nobody is added who adds nothing', () => {
    const r = compose(STOCK_OUT, agents);
    const working = r.team.filter((m) => m.covers.length);
    for (const m of working) {
      assert.ok(m.adds.length > 0, `${m.agent.id} covers nothing the others did not`);
    }
  });

  test('a bigger workforce does not mean a bigger team', () => {
    // Duplicating the workforce must not double the answer; the composer is
    // ranking capability, not counting bodies.
    const doubled = [...agents, ...agents.map((a) => ({ ...a, id: `${a.id}X` }))];
    const one = compose(STOCK_OUT, agents).team.length;
    const two = compose(STOCK_OUT, doubled).team.length;
    assert.ok(two <= one + 1, `${one} agents became ${two} when the pool doubled`);
  });

  test('no actions means no team, and it says so', () => {
    const r = compose([], agents);
    assert.deepEqual(r.team, []);
    assert.match(r.why, /no action/);
  });
});
