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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('nothing reaches an adapter except through the evaluator', () => {
  const server = read('server/app.js');

  test('the adapter is called from exactly one place, anywhere', () => {
    // Counting only inside app.js would miss a second call site added beside
    // it, which is exactly how this guarantee would be lost.
    let calls = 0;
    const seen = [];
    for (const file of readdirSync(join(ROOT, 'server'))) {
      if (!file.endsWith('.js')) continue;
      const found = (read(join('server', file)).match(/(?<![\w.])perform\(/g) ?? []).length;
      if (found) seen.push(`server/${file} (${found})`);
      calls += found;
    }
    assert.equal(calls, 1,
      `perform() is called ${calls} times across server/: ${seen.join(', ')}. ` +
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

  test('no adapter is imported anywhere but the server', () => {
    // A route, a tool, or the MCP server reaching an adapter directly would
    // bypass everything above without touching any of it.
    //
    // The whole tree is walked rather than a list of directories, because a
    // hardcoded list stops covering the thing it was written for the moment
    // somebody adds a directory, which is exactly the mistake this exists to
    // catch. It has already happened once: web/ became public/ and the check
    // silently pointed at nothing.
    // Only two files may touch an adapter: app.js, which calls it behind the
    // evaluator, and index.js, which reads its configuration to warn at startup.
    // Skipping all of server/ would have been easier and would have let a new
    // file in there bypass everything above without failing anything.
    const allowed = new Set(['server/app.js', 'server/index.js']);
    const skip = new Set(['node_modules', '.git', 'adapters', '電商Skills+Subagents']);
    const offenders = [];

    (function walk(dir) {
      for (const name of readdirSync(join(ROOT, dir || '.'))) {
        if (skip.has(name) || name.startsWith('.')) continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
        if (!name.endsWith('.js')) continue;
        if (allowed.has(rel)) continue;
        if (/from\s+['"][^'"]*adapters\//.test(read(rel))) offenders.push(rel);
      }
    })('');

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

/**
 * Nothing in the browser code may be assigned twice.
 *
 * Two `$('watch-url').onkeydown = ...` lines sat next to each other and the
 * second silently replaced the first. JavaScript gives no warning for this, in
 * either form it takes: a handler property assigned twice, or two functions
 * declared with the same name. Both read as working code and one of them is
 * simply not there, which is the worst kind of bug to look for by eye.
 */
test('no handler property and no function name is defined twice in the browser code', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const problems = [];

  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8');

    const handlers = new Map();
    for (const m of src.matchAll(/\$\(\s*['"]([\w-]+)['"]\s*\)\s*\.\s*(on\w+)\s*=/g)) {
      const key = `${m[1]}.${m[2]}`;
      handlers.set(key, (handlers.get(key) ?? 0) + 1);
    }
    for (const [key, n] of handlers) {
      if (n > 1) problems.push(`${file}: ${key} assigned ${n} times`);
    }

    const names = new Map();
    for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)) {
      names.set(m[1], (names.get(m[1]) ?? 0) + 1);
    }
    for (const [name, n] of names) {
      if (n > 1) problems.push(`${file}: function ${name} declared ${n} times`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
