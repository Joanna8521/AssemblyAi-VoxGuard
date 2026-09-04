/**
 * The invariant, held by a test rather than by good intentions.
 *
 *   No consequential action reaches an adapter except through the evaluator.
 *
 * That sentence is the whole product. It is also the kind of thing that stays
 * true right up until someone adds a second call site in a hurry, at which
 * point nothing fails, nothing logs, and the guarantee is quietly gone. So it
 * is checked here by reading the source: one call site, and that call site
 * downstream of a verdict.
 *
 * This is deliberately a crude check on text rather than a clever one on
 * behaviour. A cleverer test would be easier to satisfy accidentally.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('nothing reaches an adapter except through the evaluator', () => {
  const server = read('server/index.js');

  test('the adapter is called from exactly one place', () => {
    // `perform(` with a preceding word character would be a different symbol.
    const calls = server.match(/(?<![\w.])perform\(/g) ?? [];
    assert.equal(calls.length, 1,
      `perform() is called ${calls.length} times in server/index.js. ` +
      'A second call site is a second way for something to reach the world.');
  });

  test('that call site sits behind an ALLOW', () => {
    const at = server.search(/(?<![\w.])perform\(/);
    const before = server.slice(Math.max(0, at - 400), at);
    assert.match(before, /verdict === 'ALLOW'/,
      'the adapter call is not guarded by a verdict check');
  });

  test('the evaluator runs before it, not after', () => {
    const evaluated = server.search(/const result = evaluate\(/);
    const performed = server.search(/(?<![\w.])perform\(/);
    assert.ok(evaluated !== -1 && evaluated < performed,
      'evaluate() must run before perform(), or the check is decoration');
  });

  test('no adapter module is imported anywhere but the server', () => {
    // A route, a tool, or the MCP server reaching an adapter directly would
    // bypass everything above without touching any of it.
    const offenders = [];
    for (const dir of ['governance', 'voice', 'mcp', 'web']) {
      for (const file of readdirSync(join(ROOT, dir))) {
        if (!file.endsWith('.js')) continue;
        const src = read(join(dir, file));
        if (/from\s+['"][^'"]*adapters\//.test(src)) offenders.push(`${dir}/${file}`);
      }
    }
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} imports an adapter directly, going around the evaluator`);
  });
});

describe('the adapter tells the truth about what it did', () => {
  const adapters = read('adapters/index.js');

  test('an unconfigured adapter reports sandbox rather than success', () => {
    assert.match(adapters, /mode: 'sandbox'/);
    assert.match(adapters, /performed: false/);
  });

  test('a downstream failure is not reported as a refusal', () => {
    // "The world said no" and "the policy said no" are different facts, and
    // conflating them would teach an operator to distrust their own policy.
    assert.match(adapters, /authorised, but the adapter failed/);
  });
});
