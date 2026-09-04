/**
 * The tools the voice agent is given, generated from the registry.
 *
 * This is where the LLM boundary is actually enforced. The model's job is to
 * understand a sentence; it is not to decide what is permitted. So the only
 * thing it can hand back is a `compile_policy` call whose `action` field is an
 * enum of the registry: every action the workforce has, and nothing else.
 *
 * A model that hallucinates `delete_everything` cannot express it here. Not
 * because we told it not to in a prompt, but because the schema has no member
 * for it. Generating the enum from the registry rather than writing it out by
 * hand is what keeps that true as the registry changes.
 */

const EFFECTS = ['ALLOW', 'DENY', 'ASK'];

/**
 * `type: 'function'` is mandatory. Measured, not read: the REST reference lists
 * tool fields without it, the events reference includes it, and sending a tool
 * without it is rejected as "Invalid session configuration" with a null `param`,
 * naming nothing. tools/probe_session.js is the experiment that settled it, and
 * a second round with the field present confirmed every parameter shape we use
 * is accepted, so the field was the whole story.
 */
const FUNCTION_TOOL = 'function';

const CONDITION_HINT =
  'Optional. Only include a condition the user actually stated out loud, e.g. ' +
  '"up to 20 percent" -> {"increase_percent": {"lte": 20}}, or "only the paid ' +
  'customers" -> {"customer_group": "paid_affected"}. Comparators: lte, lt, ' +
  'gte, gt, eq, ne, in. If the user stated no condition, omit this entirely.';

function ruleSchema(actionIds) {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: actionIds,
        description: 'Which capability the user is speaking about.',
      },
      effect: {
        type: 'string',
        enum: EFFECTS,
        description:
          'ALLOW if the user permitted it, DENY if they forbade it, ASK if they ' +
          'said they want to be consulted before it happens.',
      },
      conditions: { type: 'object', description: CONDITION_HINT },
    },
    required: ['action', 'effect'],
  };
}

export function toolsFor(registry) {
  const actionIds = registry.actionIds;

  return [
    {
      type: FUNCTION_TOOL,
      name: 'compile_policy',
      description:
        'Call this when the user states, for the first time in this mission, what ' +
        'the AI workforce is and is not allowed to do. Turn every permission and ' +
        'every prohibition they spoke into a rule. Rules you were not told are not ' +
        'rules: never add one to be helpful, and never soften or strengthen one. If ' +
        'you did not understand part of what they said, leave it out and ask them ' +
        'about it instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            description: 'One entry per permission or prohibition the user stated.',
            items: ruleSchema(actionIds),
          },
          scope: {
            type: 'string',
            enum: ['mission', 'session'],
            description:
              'session if they said something like "for the rest of today" or "from ' +
              'now on"; mission if they were speaking about this situation only. ' +
              'When unclear, use mission, the shorter-lived of the two.',
          },
        },
        required: ['rules'],
      },
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'amend_policy',
      description:
        'Call this when a policy already exists and the user changes their mind ' +
        'about part of it, typically after you have reported that something was ' +
        'blocked. Send only the rules that change. Everything you do not mention ' +
        'stays exactly as it was, so do not resend rules just to be safe.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: 'Only the rules whose effect or conditions the user just changed.',
            items: ruleSchema(actionIds),
          },
        },
        required: ['changes'],
      },
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'report_status',
      description:
        'Call this when the user asks what has happened, what was blocked, what is ' +
        'waiting, or what the current policy says. Returns the live state; read the ' +
        'result back to them in their own language.',
      parameters: { type: 'object', properties: {} },
      execution_mode: 'interactive',
    },
  ];
}

/**
 * Recognition settings for `session.input`.
 *
 * Two levers, and the docs treat them as complementary rather than alternatives:
 * `transcription_prompt` supplies the domain so the model knows which vocabulary
 * is likely, and `keyterms` names the exact strings that must come back right.
 *
 * This is not tuning for its own sake. In the first live run "delist" came back
 * as "delete": one letter, and the difference between taking a product off a
 * marketplace and destroying it. The agent recovered from context, which is
 * precisely the recovery a governance system should not have to rely on.
 */
export function inputConfig() {
  return {
    // Up to 100 strings. These are the words an operator says that a general
    // model has no reason to expect: marketplace names, ad metrics, and the
    // verbs that name an irreversible act.
    keyterms: [
      'Shopee', 'Momo', 'PChome', 'Yahoo Shopping', 'Amazon', 'LINE', 'LINE Shopping',
      'Meta Ads', 'Google Ads', 'Facebook Ads', 'campaign', 'ad set', 'ad group',
      'ROAS', 'ROI', 'CPC', 'CPM', 'CTR', 'AOV', 'LTV', 'CAC', 'GA4', 'UTM',
      'delist', 'relist', 'unlist', 'out of stock', 'restock', 'backorder',
      'pause', 'unpause', 'resume', 'budget', 'daily budget', 'bid',
      'refund', 'partial refund', 'chargeback', 'cancel order', 'paid order',
      'abandoned cart', 'retargeting', 'EDM', 'newsletter', 'push notification',
      'broadcast', 'segment', 'audience', 'SKU', 'listing', 'markdown', 'coupon',
      'flash sale', 'promo code', 'fulfilment', 'shipment', 'inventory',
    ],

    // Max 1750 characters. Describes the situation, not the desired output.
    transcription_prompt: [
      'This is an ecommerce operations conversation. A store owner is telling an',
      'automation system what its agents are and are not allowed to do: pausing',
      'advertising campaigns, delisting products from marketplaces, notifying',
      'customers, cancelling orders, issuing refunds, and changing ad budgets.',
      'Expect marketplace names such as Shopee, Momo, PChome and Amazon, ad',
      'platform names such as Meta and Google, and metrics such as ROAS and CTR.',
      'Expect amounts of money, percentages, and counts of orders or customers.',
      'The speaker may switch into English for platform and metric terms in the',
      'middle of a sentence in another language; that is normal in this domain.',
      'Distinguish carefully between similar-sounding operational verbs: delist,',
      'delete, and unlist are different acts, as are pause and cancel.',
    ].join(' '),
  };
}

/**
 * The agent's standing instructions.
 *
 * Written to keep it out of the decision. It transcribes intent into structure
 * and reports outcomes; it never adjudicates, never reassures the user that
 * something is safe, and never claims an action ran. Whether anything ran is
 * the evaluator's answer, and it arrives in the tool result.
 */
export function systemPrompt(corpus) {
  const n = corpus?.skills ?? 110;
  return [
    `You are the voice interface to Signal Box, a governance layer sitting in front`,
    `of an AI commerce workforce of ${n} skills that run on their own, without the`,
    `user watching.`,
    ``,
    `Your main job: when the user states what the workforce may or may not do, turn`,
    `it into policy by calling compile_policy or amend_policy.`,
    ``,
    `Around that, be a useful colleague. If they ask what a term means, what the`,
    `current policy says, what got blocked, or how any of this works, answer them`,
    `briefly and then carry on. Refusing to explain ROAS makes you look broken, not`,
    `careful. The line you must not cross is deciding permissions, not conversation.`,
    ``,
    `Hold to these:`,
    `- You do not decide what is allowed. A deterministic evaluator does. Never tell`,
    `  the user an action is safe, permitted, or done. You do not know, and the tool`,
    `  result will tell you.`,
    `- Capture only what they said. If they permitted two things and forbade one,`,
    `  that is three rules, not four. Do not round their intent up or down.`,
    `- If you did not catch something, or a phrase could mean two different rules,`,
    `  ask. A missed rule costs one more sentence; a guessed one is exactly the`,
    `  failure this system exists to prevent.`,
    `- Always speak English back, whatever language you were spoken to in. Speech`,
    `  recognition here covers eighteen languages, but the voices available to you`,
    `  do not include Mandarin or Japanese, so replying in those would produce`,
    `  something unintelligible. Understand any language; answer in English.`,
    `- Operators mix languages mid-sentence constantly, and platform and metric`,
    `  terms like ROAS, campaign, delist and pause usually arrive in English inside`,
    `  another language. That is normal speech, not an error to correct.`,
    `- Keep spoken replies to a sentence or two. This is a control surface, and`,
    `  someone is usually mid-task while you are talking.`,
  ].join('\n');
}

export function greeting() {
  return 'Signal Box ready. Tell me what the workforce may and may not do.';
}
