/**
 * The evaluator's test suite.
 *
 * Two kinds of test live here. The ordinary kind checks that an allowance
 * allows and a denial denies. The kind that matters checks the *direction of
 * every default*: that everything unknown, unmatched, unmet or unimplemented
 * resolves away from ALLOW. Those are the tests that would catch the failure
 * that costs somebody real money, so they are written as their own group and
 * they are the ones to read first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, ALLOW, DENY, ASK } from './evaluator.js';
import { compile, amend, fingerprint } from './policy.js';
import { load } from './registry.js';
import { toolsFor } from '../voice/tools.js';
import { validateRules } from './validate.js';

const registry = load();

const req = (action, parameters = {}, skill = 'E87') => ({
  actionId: 'A-test', action, skill, parameters,
});

// ── the emergency policy, as spoken in the hero demo ────────────────────────
const emergency = () => compile({
  missionId: 'M-100',
  scope: 'mission',
  rules: [
    { action: 'pause_ad', effect: 'ALLOW' },
    { action: 'delist_product', effect: 'ALLOW' },
    { action: 'mark_out_of_stock', effect: 'ALLOW' },
    { action: 'read_orders', effect: 'ALLOW' },
    { action: 'notify_customer', effect: 'DENY' },
    { action: 'send_email', effect: 'DENY' },
    { action: 'issue_refund', effect: 'DENY' },
    { action: 'cancel_order', effect: 'DENY' },
  ],
});

describe('the ordinary cases', () => {
  test('an explicit allowance allows', () => {
    const r = evaluate(req('pause_ad'), emergency(), registry);
    assert.equal(r.verdict, ALLOW);
    assert.equal(r.reasonCode, 'explicit_allow');
  });

  test('an explicit denial denies, and says who denied it', () => {
    const r = evaluate(req('notify_customer'), emergency(), registry);
    assert.equal(r.verdict, DENY);
    assert.match(r.reason, /human authorization/);
  });

  test('reads run without anyone authorizing them', () => {
    const r = evaluate(req('read_metrics'), null, registry);
    assert.equal(r.verdict, ALLOW);
    assert.equal(r.risk, 'L1');
  });

  test('drafting runs without anyone authorizing it', () => {
    assert.equal(evaluate(req('draft_copy'), null, registry).verdict, ALLOW);
  });
});

describe('conditions', () => {
  const budget = () => compile({
    missionId: 'M-200',
    rules: [{
      action: 'change_ad_budget',
      effect: 'ALLOW',
      conditions: { increase_percent: { lte: 20 }, daily_total: { lte: 5000 } },
    }],
  });

  test('inside the range, it goes', () => {
    const r = evaluate(req('change_ad_budget', { increase_percent: 15, daily_total: 4200 }), budget(), registry);
    assert.equal(r.verdict, ALLOW);
  });

  test('at the boundary, it goes: lte means lte', () => {
    const r = evaluate(req('change_ad_budget', { increase_percent: 20, daily_total: 5000 }), budget(), registry);
    assert.equal(r.verdict, ALLOW);
  });

  test('over the range it asks, and names the number it tripped on', () => {
    const r = evaluate(req('change_ad_budget', { increase_percent: 35, daily_total: 4200 }), budget(), registry);
    assert.equal(r.verdict, ASK);
    assert.match(r.reason, /increase_percent lte 20 \(got 35\)/);
  });

  test('one condition passing does not carry the other', () => {
    const r = evaluate(req('change_ad_budget', { increase_percent: 10, daily_total: 9000 }), budget(), registry);
    assert.equal(r.verdict, ASK);
  });
});

// ── the group that matters ──────────────────────────────────────────────────
describe('every default points away from ALLOW', () => {
  test('an action nobody registered is never allowed', () => {
    const r = evaluate(req('launch_the_missiles'), emergency(), registry);
    assert.equal(r.verdict, ASK);
    assert.equal(r.reasonCode, 'unregistered_action');
  });

  test('with no policy at all, an external write is never allowed', () => {
    const r = evaluate(req('notify_customer'), null, registry);
    assert.equal(r.verdict, ASK);
  });

  test('an L3 nobody mentioned is denied, not assumed', () => {
    const r = evaluate(req('publish_social_post'), emergency(), registry);
    assert.equal(r.verdict, DENY);
    assert.equal(r.reasonCode, 'unmatched_default_deny');
  });

  test('an L4 nobody mentioned is asked about, never guessed', () => {
    const r = evaluate(req('apply_discount'), emergency(), registry);
    assert.equal(r.verdict, ASK);
    assert.equal(r.reasonCode, 'unmatched_high_risk');
  });

  test('a missing parameter fails the condition rather than skipping it', () => {
    const p = compile({
      missionId: 'M-300',
      rules: [{ action: 'change_ad_budget', effect: 'ALLOW', conditions: { daily_total: { lte: 5000 } } }],
    });
    const r = evaluate(req('change_ad_budget', {}), p, registry);
    assert.equal(r.verdict, ASK);
    assert.match(r.reason, /not supplied/);
  });

  test('a comparator we do not implement fails closed', () => {
    const p = compile({
      missionId: 'M-301',
      rules: [{ action: 'change_ad_budget', effect: 'ALLOW', conditions: { daily_total: { approximately: 5000 } } }],
    });
    assert.equal(evaluate(req('change_ad_budget', { daily_total: 5000 }), p, registry).verdict, ASK);
  });

  test('conditions cannot widen a denial', () => {
    const p = compile({
      missionId: 'M-302',
      rules: [{ action: 'issue_refund', effect: 'DENY', conditions: { amount: { lte: 10 } } }],
    });
    const r = evaluate(req('issue_refund', { amount: 5 }), p, registry);
    assert.equal(r.verdict, DENY, 'a satisfied condition must not turn DENY into ALLOW');
  });

  test('every verdict is one of exactly three words', () => {
    const seen = new Set();
    for (const action of [...registry.actionIds, 'not_a_real_action']) {
      for (const policy of [null, emergency()]) {
        seen.add(evaluate(req(action), policy, registry).verdict);
      }
    }
    assert.deepEqual([...seen].sort(), [ALLOW, ASK, DENY].sort());
  });
});

// ── the escape hatch the corpus surfaced ────────────────────────────────────
describe('scheduling cannot outlive the policy that denied it', () => {
  test('an L4-meta nobody authorized is refused', () => {
    const r = evaluate(req('create_schedule', { action: 'notify_customer', at: '08:00' }, 'C10'), emergency(), registry);
    assert.notEqual(r.verdict, ALLOW);
    assert.equal(r.risk, 'L4-meta');
  });

  test('47 skills can schedule, so this is not a hypothetical', () => {
    const scheduling = registry.corpus;
    assert.ok(scheduling, 'capabilities.json should be present');
    assert.ok(scheduling.executive_high_risk_edges > 0);
  });
});

// ── amendment: the difference the product turns on ──────────────────────────
describe('amending a live policy', () => {
  test('a denial becomes a conditional allowance, and the version moves', () => {
    const v1 = emergency();
    assert.equal(evaluate(req('notify_customer'), v1, registry).verdict, DENY);

    const v2 = amend(v1, [{
      action: 'notify_customer', effect: 'ALLOW',
      conditions: { customer_group: 'paid_affected' },
    }]);

    assert.equal(v2.version, 2);
    assert.equal(evaluate(req('notify_customer', { customer_group: 'paid_affected' }), v2, registry).verdict, ALLOW);
  });

  test('the amendment does not leak past its condition', () => {
    const v2 = amend(emergency(), [{
      action: 'notify_customer', effect: 'ALLOW',
      conditions: { customer_group: 'paid_affected' },
    }]);
    const r = evaluate(req('notify_customer', { customer_group: 'everyone' }), v2, registry);
    assert.notEqual(r.verdict, ALLOW, 'permission for 14 people is not permission for the list');
  });

  test('amending one rule leaves the others exactly as they were', () => {
    const v2 = amend(emergency(), [{ action: 'notify_customer', effect: 'ALLOW' }]);
    assert.equal(evaluate(req('issue_refund'), v2, registry).verdict, DENY);
    assert.equal(evaluate(req('cancel_order'), v2, registry).verdict, DENY);
  });

  test('v1 keeps its own history after v2 exists', () => {
    const v1 = emergency();
    const v2 = amend(v1, [{ action: 'notify_customer', effect: 'ALLOW' }]);
    assert.equal(v1.version, 1);
    assert.equal(evaluate(req('notify_customer'), v1, registry).verdict, DENY);
    assert.equal(v2.history.at(-1).applied[0].from, 'DENY');
  });
});

// ── the trilingual claim, checked rather than asserted ──────────────────────
describe('policy is language-neutral', () => {
  const rules = [
    { action: 'pause_ad', effect: 'ALLOW' },
    { action: 'notify_customer', effect: 'DENY' },
  ];

  test('three languages, one fingerprint', () => {
    const zh = compile({ missionId: 'M-1', rules, spokenIn: 'zh' });
    const en = compile({ missionId: 'M-1', rules: [...rules].reverse(), spokenIn: 'en' });
    const ja = compile({ missionId: 'M-1', rules, spokenIn: 'ja' });

    assert.equal(fingerprint(zh), fingerprint(en), 'rule order must not matter');
    assert.equal(fingerprint(zh), fingerprint(ja));
    assert.notEqual(zh.policyId, en.policyId, 'but they are still distinct policies');
  });

  test('a different authorization is a different fingerprint', () => {
    const a = compile({ missionId: 'M-1', rules });
    const b = compile({
      missionId: 'M-1',
      rules: [{ action: 'pause_ad', effect: 'ALLOW' }, { action: 'notify_customer', effect: 'ALLOW' }],
    });
    assert.notEqual(fingerprint(a), fingerprint(b));
  });
});


// ── the model's output space is bounded by the registry, structurally ───────
describe('what the model is allowed to say', () => {
  const tools = toolsFor(registry);
  const byName = new Map(tools.map((t) => [t.name, t]));

  test('every tool declares type function, which the API requires', () => {
    for (const t of tools) assert.equal(t.type, 'function', `${t.name} needs type: function`);
  });

  test('no tool takes more than two parameters, because three are never called', () => {
    // Measured against a live session, speaking the same sentence roughly eighty
    // times. { brief } was called 3 of 3, { brief, needs } 5 of 5, and every
    // three-parameter shape 0 of 11 - with no error: the reply completes, empty,
    // and the agent carries on talking as though it had acted. A rule therefore
    // cannot be an object with an action, an effect and conditions; the effect
    // is the name of the tool instead.
    for (const t of tools) {
      const n = Object.keys(t.parameters?.properties ?? {}).length;
      assert.ok(n <= 2, `${t.name} takes ${n} parameters; at three the API stops calling it`);
    }
  });

  test('the three effects each have a tool, so nothing spoken has nowhere to go', () => {
    for (const name of ['forbid', 'ask_first', 'permit']) {
      assert.ok(byName.has(name), `${name} is missing, so that effect cannot be recorded`);
    }
  });

  test('actions are an enum of the registry, so a hallucinated one cannot be expressed', () => {
    const enums = [
      byName.get('start_mission').parameters.properties.needs.items.enum,
      ...['forbid', 'ask_first', 'permit'].map(
        (n) => byName.get(n).parameters.properties.actions.items.enum),
    ];
    for (const e of enums) {
      assert.deepEqual([...e].sort(), [...registry.actionIds].sort());
    }
  });

  test('every enumerated parameter is constrained, since free text makes it stop and ask', () => {
    // A free-form parameter changed the behaviour, not just the output: the
    // agent asked the user what to put in it instead of calling anything.
    // Constrained ones it simply filled.
    for (const t of tools) {
      for (const [key, spec] of Object.entries(t.parameters?.properties ?? {})) {
        if (key === 'brief' || spec.type === 'number') continue;
        const items = spec.items ?? spec;
        assert.ok(Array.isArray(items.enum),
          `${t.name}.${key} is free-form; the agent will ask rather than call`);
      }
    }
  });

  test('the schema is guidance, so validation is what actually holds', () => {
    // Measured: the API stores whatever schema it is sent, including keywords it
    // does not implement, and a live run produced customer_group "floating pay"
    // from an enum of six values. The enum shapes what the model tends to say.
    // Only this rejects what it must not be allowed to have said.
    const { accepted, rejected } = validateRules([
      { action: 'notify_customer', effect: 'ALLOW', conditions: { customer_group: 'floating pay' } },
      { action: 'pause_ad', effect: 'ALLOW' },
    ], registry);
    assert.deepEqual(accepted.map((r) => r.action), ['pause_ad']);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /paid_affected/);
  });

  test('a condition nobody declared is refused, whatever route it arrives by', () => {
    // Conditions are no longer spoken - there is no parameter for them - so the
    // schema cannot be what stops an invented one. This always was the thing
    // that stopped it.
    const { rejected } = validateRules(
      [{ action: 'pause_ad', effect: 'ALLOW', conditions: { whatever_i_like: 1 } }], registry);
    assert.equal(rejected.length, 1);
  });
});

// ── nothing unreadable becomes policy ───────────────────────────────────────
describe('validation, the boundary that actually holds', () => {
  const only = (rules) => validateRules(rules, registry);

  test('an action the workforce does not have is refused', () => {
    const { rejected } = only([{ action: 'teleport', effect: 'ALLOW' }]);
    assert.match(rejected[0].reason, /not a capability/);
  });

  test('a condition nobody declared is refused, and the message names the real ones', () => {
    const { rejected } = only([
      { action: 'notify_customer', effect: 'ALLOW', conditions: { vibe: 'good' } },
    ]);
    assert.match(rejected[0].reason, /customer_group/);
  });

  test('a comparator we never implemented is refused rather than ignored', () => {
    const { rejected } = only([
      { action: 'change_ad_budget', effect: 'ALLOW', conditions: { amount: { under: 50 } } },
    ]);
    assert.match(rejected[0].reason, /not a comparator/);
  });

  test('a number field will not take a sentence', () => {
    const { rejected } = only([
      { action: 'change_ad_budget', effect: 'ALLOW', conditions: { daily_total: 'about five thousand' } },
    ]);
    assert.match(rejected[0].reason, /must be a number/);
  });

  test('a real conditional rule passes untouched', () => {
    const rule = {
      action: 'change_ad_budget', effect: 'ALLOW',
      conditions: { increase_percent: { lte: 20 }, daily_total: { lte: 5000 } },
    };
    const { accepted, rejected } = only([rule]);
    assert.equal(rejected.length, 0);
    assert.deepEqual(accepted, [rule]);
  });

  test('`in` may carry a list, and every member must be declared', () => {
    const ok = only([{ action: 'notify_customer', effect: 'ALLOW',
      conditions: { customer_group: { in: ['paid_affected', 'vip'] } } }]);
    assert.equal(ok.rejected.length, 0);

    const bad = only([{ action: 'notify_customer', effect: 'ALLOW',
      conditions: { customer_group: { in: ['paid_affected', 'whoever'] } } }]);
    assert.equal(bad.rejected.length, 1);
  });

  test('one bad rule does not take the good ones down with it', () => {
    const { accepted, rejected } = only([
      { action: 'pause_ad', effect: 'ALLOW' },
      { action: 'nonsense', effect: 'ALLOW' },
      { action: 'issue_refund', effect: 'DENY' },
    ]);
    assert.deepEqual(accepted.map((r) => r.action), ['pause_ad', 'issue_refund']);
    assert.equal(rejected.length, 1);
  });
});
