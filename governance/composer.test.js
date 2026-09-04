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


describe('a built agent beats a described one', () => {
  test('the one that will actually run is preferred when both would cover it', () => {
    // Content Gap claimed all three actions a rival-launch mission needs and had
    // no implementation, so it took the work from the agent built to do it.
    const needs = ['scrape_public_page', 'analyze_data', 'draft_plan'];
    const blind = compose(needs, agents);
    const sighted = compose(needs, agents, { live: ['A07'] });

    assert.ok(sighted.team.some((m) => m.agent.id === 'A07'),
      'the built agent should be picked once the composer is told which are built');
    assert.ok(!blind.team.some((m) => m.agent.id === 'A07') ||
              sighted.team[0].agent.id === 'A07',
      'and it should rank ahead of an equal claim that cannot run');
  });

  test('being built does not buy a place on work it cannot cover', () => {
    const r = compose(['issue_refund'], agents, { live: ['A07'] });
    assert.ok(!r.team.some((m) => m.agent.id === 'A07'));
  });
});

// ── what the agent is told it can do ────────────────────────────────────────
describe('the voice agent is told the truth about its reach', () => {
  test('the prompt names what is actually connected, and what is not', async () => {
    const { systemPrompt } = await import('../voice/tools.js');
    const prompt = systemPrompt({ skills: 110 });

    // It offered to read somebody's Gmail once. Nothing of the sort exists, and
    // they would have found out at the worst possible moment.
    for (const claim of ['Gmail', 'Google Drive', 'Shopify admin', 'ad account']) {
      assert.ok(prompt.includes(claim),
        `the prompt should name "${claim}" as something it cannot do`);
    }
    assert.match(prompt, /cannot read/);
    assert.match(prompt, /Telegram/);
    assert.match(prompt, /not connected yet/);
  });

  test('the prompt does not deny a reach the system has since gained', async () => {
    // It used to say plainly that it could not read spreadsheets, which was
    // true when written. Once a sheet reader existed, that sentence kept the
    // agent refusing work it could do: somebody asked it to watch their daily
    // takings and it said it had no way to. An honest denial that goes stale
    // reads exactly like a working feature that is switched off.
    const { systemPrompt } = await import('../voice/tools.js');
    const prompt = systemPrompt({ skills: 110 });

    assert.doesNotMatch(prompt, /cannot read[^.]*spreadsheet/i,
      'the prompt must not deny reading spreadsheets while a sheet reader exists');
    assert.match(prompt, /Google Sheet/,
      'the prompt should say a sheet can be read');
    assert.match(prompt, /read_sheet/,
      'and name the action, or the model has to guess which one covers takings');

    // The words people actually use for it. "Revenue" is the column heading;
    // nobody says it out loud.
    for (const word of ['takings', 'revenue', 'sales']) {
      assert.ok(prompt.includes(word), `the prompt should recognise "${word}"`);
    }
  });

  test('an agent exists for every reach the prompt claims', async () => {
    // The prompt naming read_sheet is worth nothing if no agent holds it: the
    // composer would answer "nothing in this workforce can read_sheet" after
    // the agent had just promised otherwise.
    const { readFileSync } = await import('node:fs');
    const workforce = JSON.parse(
      readFileSync(new URL('../agents/workforce.json', import.meta.url)));

    const holders = workforce.agents.filter((a) => a.actions.includes('read_sheet'));
    assert.ok(holders.length > 0, 'somebody must be able to read_sheet');

    // And it has to be one that will really go and do it, not one that only
    // describes the work.
    const { implementedAgents } = await import('../runtime/run.js');
    const live = new Set(implementedAgents());
    assert.ok(holders.some((a) => live.has(a.id)),
      'the agent that reads a sheet must be built, not described');
  });
});

describe('the prompt stays short enough to be followed', () => {
  test('it is nowhere near the length at which the model stopped calling tools', async () => {
    // Measured, not guessed. At 7,124 characters the model returned completed
    // but empty replies, one after another, and called no tool at all; the same
    // sentence spoken against a three-line prompt produced a tool call
    // immediately. The tools were identical in both runs.
    //
    // The ceiling here is not the failure point, it is well below it. This
    // failed by accretion, a true paragraph at a time, with no single commit
    // that looked wrong.
    const { systemPrompt } = await import('../voice/tools.js');
    const prompt = systemPrompt({ skills: 110 });

    assert.ok(prompt.length < 3500,
      `the prompt is ${prompt.length} characters. Past about 3,500 it starts ` +
      `competing with the conversation for the model's attention, and at 7,000 ` +
      `it stopped calling tools entirely. Explain a rule in a comment, not here.`);
  });
});
