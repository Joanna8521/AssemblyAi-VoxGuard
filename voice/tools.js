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
  'Optional. Only include a condition the user actually stated out loud. A bare ' +
  'value means it must equal that exactly ("only the paid customers" -> ' +
  '{"customer_group": "paid_affected"}). For a range, use a comparator object ' +
  '("up to 20 percent" -> {"increase_percent": {"lte": 20}}). Comparators: lte, ' +
  'lt, gte, gt, eq, ne, in. If the user stated no condition, omit this entirely.';

/**
 * Condition values come from a declared vocabulary, not from free text.
 *
 * The action enum stops the model inventing a capability. This stops it
 * inventing a value for one. Left open, the model writes "paid" where the
 * workforce asks about "paid_affected"; the evaluator refuses, correctly, and
 * the person sees a refusal with no cause they can see. Matching those two
 * loosely would be worse: a normalizer generous enough to reconcile them is
 * generous enough to reconcile things a person never authorized.
 */
function conditionSchema(vocabulary) {
  const properties = {};
  for (const [field, spec] of Object.entries(vocabulary)) {
    properties[field] = spec.enum
      ? { oneOf: [{ type: 'string', enum: spec.enum }, { type: 'object' }] }
      : { oneOf: [{ type: spec.type }, { type: 'object' }] };
  }
  return { type: 'object', description: CONDITION_HINT, properties };
}

function ruleSchema(actionIds, vocabulary, catalogue) {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: actionIds,
        description:
          'Which capability the user is speaking about. Read the list before ' +
          'choosing: several names are close together and mean opposite things. ' +
          catalogue,
      },
      effect: {
        type: 'string',
        enum: EFFECTS,
        description:
          'ALLOW if the user permitted it, DENY if they forbade it, ASK if they ' +
          'said they want to be consulted before it happens.',
      },
      conditions: conditionSchema(vocabulary),
    },
    required: ['action', 'effect'],
  };
}

/**
 * The tools, shaped by what this API will actually call.
 *
 * Measured, not assumed. Speaking the same sentence into a live session across
 * about eighty runs gives one hard constraint:
 *
 *     { brief }                     called, 3 of 3
 *     { brief, needs }              called, 5 of 5
 *     { brief, needs, anything }    never called, 0 of 11
 *
 * Three parameters produces no tool call at all, and no error either: the reply
 * completes, empty, and the agent goes on talking as though it had acted. That
 * is why a mission was never opened however the prompt was worded, and why the
 * shape below is the way it is rather than the obvious one.
 *
 * So a rule is not an object with an action, an effect and conditions. It is a
 * list of actions handed to the tool named after the effect. Conditions are not
 * spoken here at all; they are added afterwards through amend, where they are
 * one parameter on their own.
 *
 * The enums stay, and matter more than they seem to: a free-form parameter made
 * the agent stop and ask the user what to put in it, while a constrained one it
 * simply filled. They are still not a guarantee - the API stores schemas
 * verbatim and does not enforce them - so validateRules on the server remains
 * the only thing standing between a spoken rule and the evaluator.
 */
export function toolsFor(registry) {
  const actionIds = registry.actionIds;

  const actions = (description) => ({
    type: 'object',
    required: ['actions'],
    properties: {
      actions: {
        type: 'array',
        description,
        items: { type: 'string', enum: actionIds },
      },
    },
  });

  return [
    {
      type: FUNCTION_TOOL,
      name: 'start_mission',
      description:
        'Call this the moment the user asks for anything to be handled, watched, ' +
        'checked or chased. Do not ask which product, which numbers or which ' +
        'actions first: choose the needs yourself and open it.',
      parameters: {
        type: 'object',
        required: ['brief', 'needs'],
        properties: {
          brief: {
            type: 'string',
            description: 'The situation in their own words, one sentence.',
          },
          needs: {
            type: 'array',
            description:
              'Everything that would have to be done, reading and analysis included.',
            items: { type: 'string', enum: actionIds },
          },
        },
      },
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'forbid',
      description:
        'Actions the user said must never happen. "Never touch prices", "don\'t ' +
        'refund anyone", "no ads". Call it alongside start_mission when both were ' +
        'said in one breath.',
      parameters: actions('The actions to forbid.'),
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'ask_first',
      description:
        'Actions the user wants to be consulted about before they happen. "Ask me ' +
        'before you tell customers", "check with me first".',
      parameters: actions('The actions to hold for approval.'),
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'permit',
      description:
        'Actions the user said may happen on their own. Asking to be told is one ' +
        'of these: "tell me when takings drop" permits send_telegram_message.',
      parameters: actions('The actions to allow.'),
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'set_alert_threshold',
      description:
        'How far the latest daily figure must fall below the recent average before ' +
        'it is raised. It is 20% unless they say otherwise. Not a permission.',
      parameters: {
        type: 'object',
        required: ['drop_percent'],
        properties: {
          drop_percent: {
            type: 'number',
            description: 'A positive percentage, for example 30.',
          },
        },
      },
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'report_status',
      description:
        'Call this when the user asks what has happened, what was blocked, what is ' +
        'waiting, or what the current orders say.',
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

    /**
     * Someone dictating a policy is not having a conversation. They list
     * permissions, stop to think, then list prohibitions, and the pause in the
     * middle is not the end of their turn.
     *
     * The defaults are min_silence 1000 / max_silence 3000, read back from the
     * server rather than from the docs, which say otherwise. At 1000 ms the
     * agent cut in halfway through the first real dictation and answered the
     * half it had heard.
     *
     * Barge-in stays on: interrupting a wrong readback should always work.
     *
     * Note for anyone editing this: unknown keys here are silently dropped, not
     * rejected. A typo does nothing and reports success. The values the server
     * actually applied come back in `session.ready`.`config.input.turn_detection`,
     * which is the only place worth reading them from.
     */
    turn_detection: {
      vad_threshold: 0.5,
      min_silence: 1800,
      max_silence: 5000,
      interrupt_response: true,
    },

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
/**
 * What the model is told, kept short on purpose.
 *
 * This grew to 115 lines by accretion, a paragraph at a time, each one true and
 * each one making the next less likely to be read. At that length the model
 * stopped calling tools at all: replies came back completed and empty, over and
 * over, and nothing was recorded. Measured by speaking the same sentence into a
 * live session against different configurations, the tools were fine and the
 * prompt was the cause; cutting it to a third restored tool calls immediately.
 *
 * So: rules only. The reasoning behind a rule belongs in a comment here, where
 * it costs the model nothing. A test holds the length, because the way this
 * failed was gradual and invisible.
 */
export function systemPrompt(corpus) {
  const n = corpus?.skills ?? 110;
  return [
    `You are the voice interface to Standing Order, which governs an AI commerce`,
    `workforce of ${n} skills that run unattended.`,
    ``,
    `Never reply to the user without first calling a tool. Talking alone records`,
    `nothing, and leaves them watching a page that has not moved.`,
    ``,
    `- Anything to be handled, watched, checked or chased: start_mission.`,
    `- What they said must never happen: forbid.`,
    `- What they want to be consulted about first: ask_first.`,
    `- What may happen on its own: permit. Asking to be told is one of these:`,
    `  "tell me when takings drop" permits send_telegram_message.`,
    `- A drop percentage other than 20: set_alert_threshold.`,
    `- Asked what happened or what is blocked: report_status.`,
    ``,
    `One sentence usually carries a situation and its limits together, so it`,
    `usually takes start_mission and then forbid or ask_first in the same turn.`,
    ``,
    `RULES`,
    `- Act on each turn as it arrives. Never wait for more speech.`,
    `- Never ask which product, which numbers or which actions. Choose them.`,
    `- Capture exactly what they said, no more. If a phrase could mean two rules,`,
    `  ask. If you did not catch something, say so.`,
    `- Never say a rule is recorded, an action permitted, or anything done, unless`,
    `  a tool result says so. Anything under not_recorded is not in force: name it`,
    `  and ask them to restate it. Never guess a value it refused.`,
    `- Say nothing about what will happen later until the tool has returned.`,
    `- After a save, say how many rules are now in force.`,
    `- You never decide permissions. A deterministic evaluator does.`,
    ``,
    `WHAT IS REALLY CONNECTED`,
    `- Reading: public web pages, price and stock from storefronts that publish it,`,
    `  and a Google Sheet once someone pastes a link into the interface. The sheet`,
    `  is how their own numbers arrive: takings, revenue, sales, ad spend. The`,
    `  action is read_sheet and Daily Revenue is the only agent with it. A drop is`,
    `  raised at 20% below the recent average.`,
    `- Acting: sending a Telegram message.`,
    `- Everything else is registered and governed but runs against a simulation.`,
    `- It cannot read Gmail, Google Drive, a Shopify admin, an ad account or an`,
    `  order database. Asked for any of those, say plainly it is not connected yet`,
    `  rather than inventing it. You cannot connect a sheet yourself either; if`,
    `  none is connected, say where the box is.`,
    ``,
    `SPEAKING`,
    `- Understand any language; always answer in English. The available voices`,
    `  cannot pronounce Mandarin or Japanese.`,
    `- Mixed languages and English platform terms inside another language are`,
    `  normal speech, not errors.`,
    `- One or two sentences. Someone is mid-task while you talk.`,
    `- Answer ordinary questions briefly and carry on. Refusing to explain ROAS`,
    `  looks broken, not careful.`,
  ].join('\n');
}

export function greeting() {
  return 'Standing Order ready. Tell me what the workforce may and may not do.';
}
