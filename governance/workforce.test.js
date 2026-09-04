/**
 * The built-in workforce has to line up with the registry exactly.
 *
 * An agent naming an action nobody registered would fail as an ASK at runtime,
 * which is far too late and looks like a governance decision rather than the
 * typo it is. Same for a pool nobody defined, or a trigger from an agent that
 * does not exist: each would be a hole in a picture people are meant to trust.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { load } from './registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workforce = JSON.parse(readFileSync(join(ROOT, 'agents', 'workforce.json'), 'utf8'));
const registry = load();

const ids = new Set(workforce.agents.map((a) => a.id));
const pools = new Set(workforce.pools.map((p) => p.id));
const departments = new Set(workforce.departments.map((d) => d.id));

describe('the workforce lines up with the registry', () => {
  test('every action an agent claims is one the registry knows', () => {
    for (const agent of workforce.agents) {
      for (const action of agent.actions) {
        assert.notEqual(registry.riskOf(action), null,
          `${agent.id} ${agent.name} claims "${action}", which is not in the catalogue`);
      }
    }
  });

  test('every pool read or written is a pool that exists', () => {
    for (const agent of workforce.agents) {
      for (const pool of [...agent.reads, ...agent.writes]) {
        assert.ok(pools.has(pool), `${agent.id} touches pool "${pool}", which is not defined`);
      }
    }
  });

  test('every agent belongs to a department that exists', () => {
    for (const agent of workforce.agents) {
      assert.ok(departments.has(agent.department),
        `${agent.id} is in department "${agent.department}", which is not defined`);
    }
  });

  test('every trigger names an agent that exists', () => {
    for (const agent of workforce.agents) {
      for (const upstream of agent.triggered_by ?? []) {
        assert.ok(ids.has(upstream), `${agent.id} is triggered by "${upstream}", which does not exist`);
      }
    }
  });

  test('agent ids are unique', () => {
    assert.equal(ids.size, workforce.agents.length);
  });

  test('every department has at least one agent', () => {
    for (const d of workforce.departments) {
      assert.ok(workforce.agents.some((a) => a.department === d.id),
        `department "${d.id}" is empty`);
    }
  });
});

describe('what this workforce is actually dangerous for', () => {
  const can = (action) => workforce.agents.filter((a) => a.actions.includes(action));

  test('the irreversible customer-facing actions are concentrated, not scattered', () => {
    // Anyone can draft. Reaching a real person is meant to be one desk's job,
    // so that governing it is governing one edge rather than thirty.
    const senders = can('notify_customer');
    assert.ok(senders.length <= 3, `${senders.length} agents can message customers directly`);
    for (const a of senders) assert.equal(a.department, 'msg');
  });

  test('money moves in exactly one place', () => {
    const refunders = can('issue_refund');
    const cancellers = can('cancel_order');
    assert.deepEqual(refunders.map((a) => a.id), cancellers.map((a) => a.id));
    assert.equal(refunders.length, 1, 'refunds should live at a single desk');
  });

  test('scheduling is its own agent, because it is its own kind of risk', () => {
    const schedulers = can('create_schedule');
    assert.equal(schedulers.length, 1);
    assert.equal(registry.riskOf('create_schedule'), 'L4-meta');
  });

  test('a writing agent cannot also publish what it wrote', () => {
    // Drafting is free; publishing is not. Keeping them apart means the
    // governed edge sits between the two, where a person can stand.
    for (const agent of workforce.agents.filter((a) => a.department === 'content')) {
      const publishes = agent.actions.filter((x) => registry.riskOf(x) === 'L3');
      assert.deepEqual(publishes, [],
        `${agent.name} both writes and reaches the outside world; that edge should sit between two desks`);
    }
  });
});
