/**
 * What happens after ALLOW.
 *
 * Until now there was nothing here, and the interface said `real` on actions
 * that did not run, which was true about the class of action and misleading
 * about this deployment. An adapter is what makes the difference honest.
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. An adapter runs only on ALLOW. It is called from one place, after the
 *      evaluator, and never before.
 *   2. An adapter that is not configured degrades to the sandbox and says so in
 *      what it returns. It never half-succeeds and never implies it acted. A
 *      governance tool that overstates its own reach has failed at the thing it
 *      claims to be about.
 */

import { sendTelegram, telegramConfigured, telegramProblems } from './telegram.js';

/**
 * @returns {{performed: boolean, mode: 'real'|'sandbox', detail: string}}
 */
export async function perform(action, parameters, { registry }) {
  const handler = HANDLERS[action];

  if (handler && handler.available()) {
    try {
      const detail = await handler.run(action, parameters);
      return { performed: true, mode: 'real', detail };
    } catch (err) {
      // A failure downstream is not a governance decision and must not read
      // like one. The action was authorised; the world refused it.
      return {
        performed: false,
        mode: 'real',
        detail: `authorised, but the adapter failed: ${err.message}`,
      };
    }
  }

  const why = handler
    ? 'its adapter is not configured in this deployment'
    : `no credential for ${registry.adapterOf(action) ?? 'this'} exists anywhere in the corpus`;

  return { performed: false, mode: 'sandbox', detail: `simulated, because ${why}` };
}

/** Which actions have somewhere real to go, and how to tell if they do today. */
const HANDLERS = {
  send_telegram_message: {
    available: () => telegramConfigured('ops'),
    run: (_a, p) => sendTelegram('ops', p.text ?? 'Standing Order: an operations alert.'),
  },

  /**
   * The customer channel in this deployment is a Telegram chat standing in for
   * whatever a real store uses. That substitution is stated wherever the result
   * is shown, because a message that genuinely leaves the building is the point
   * of the demo and pretending about which building would spoil it.
   */
  notify_customer: {
    available: () => telegramConfigured('customer'),
    run: (_a, p) => sendTelegram('customer',
      p.text ?? `Standing Order: a notice intended for ${p.customer_group ?? 'customers'}.`),
  },
};

export function adapterStatus() {
  return {
    telegram_ops: telegramConfigured('ops'),
    telegram_customer: telegramConfigured('customer'),
    problems: telegramProblems(),
  };
}
