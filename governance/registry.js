/**
 * The registry: what the workforce can do, and what each of those things costs.
 *
 * Deliberately framework-neutral. OpenClaw and Hermes Agent are both populated
 * by skills that emit actions; the evaluator only ever needs to know an action's
 * name, its risk band, and whether an adapter for it actually exists. Nothing
 * here knows which runtime the caller came from, and nothing should.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export function load({
  actionsPath = join(ROOT, 'registry', 'actions.json'),
  capabilitiesPath = join(ROOT, 'registry', 'capabilities.json'),
} = {}) {
  const catalog = JSON.parse(readFileSync(actionsPath, 'utf8'));
  const actions = new Map(catalog.actions.map((a) => [a.id, a]));

  let capabilities = null;
  try {
    capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
  } catch {
    // The evaluator works without it. Only `canPerform` needs the corpus.
  }

  /** skill -> Set(action) it can *execute*, as opposed to merely recommend. */
  const executable = new Map();
  if (capabilities) {
    for (const skill of capabilities.skills) {
      const set = new Set();
      for (const c of skill.capabilities) if (c.mode === 'executive') set.add(c.action);
      executable.set(skill.id, set);
    }
  }

  return {
    riskOf(action) {
      return actions.get(action)?.risk ?? null;
    },

    adapterOf(action) {
      return actions.get(action)?.adapter ?? null;
    },

    /**
     * Whether an adapter that could really perform this exists at all.
     * Everything else runs against a sandbox, and says so on its face.
     */
    isReal(action) {
      const a = actions.get(action)?.adapter;
      return a !== undefined && a !== 'sandbox' && a !== 'none';
    },

    meta(action) {
      return actions.get(action) ?? null;
    },

    label(action, lang = 'en') {
      const a = actions.get(action);
      return a?.label?.[lang] ?? a?.label?.en ?? action;
    },

    /**
     * Whether a given skill can actually emit this action.
     *
     * Not consulted by the evaluator, since a forged request is refused on the
     * policy alone, and refusing it for the *wrong* reason would teach an
     * attacker which claims are believed. This exists so the console can label
     * a request as coming from outside the known workforce.
     */
    canPerform(skill, action) {
      return executable.get(skill)?.has(action) ?? false;
    },

    get actionIds() {
      return [...actions.keys()];
    },

    /**
     * Declared vocabulary for condition values.
     *
     * The action enum stops the model inventing a capability. This stops it
     * inventing a *value*: without it a policy can authorize "paid" while the
     * workforce asks about "paid_affected", the evaluator correctly refuses,
     * and the person sees a refusal they cannot account for.
     *
     * Enumerated for strings, open for numbers, because a person can say any
     * number but only ever means one of a few groups.
     */
    get conditionVocabulary() {
      const v = { ...(catalog.condition_vocabulary ?? {}) };
      delete v.$comment;
      return v;
    },

    get corpus() {
      return capabilities?.summary ?? null;
    },
  };
}
