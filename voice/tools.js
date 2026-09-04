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

export function toolsFor(registry) {
  const actionIds = registry.actionIds;
  const vocabulary = registry.conditionVocabulary;
  const catalogue = actionIds
    .map((id) => `${id} = ${registry.label(id, 'en').toLowerCase()}`)
    .join('; ');

  return [
    {
      type: FUNCTION_TOOL,
      name: 'start_mission',
      description:
        'Call this when the user describes a situation they want handled, rather than ' +
        'only stating rules. One sentence usually carries both, and they are different ' +
        'things that both have to be extracted.\n\n' +
        '`needs` is the work: what would actually have to be done to deal with what they ' +
        'described. Include reading and analysis, not only the dramatic parts. If a ' +
        'product is out of stock, somebody has to look at stock before anything else.\n\n' +
        '`rules` is the boundary: only what they said out loud about what may and may not ' +
        'happen. An action can appear in both, and often should. "Ask me before telling ' +
        'customers" means notify_customer is needed AND carries an ASK.\n\n' +
        'Do not invent needs to look thorough or rules to look careful. If they did not ' +
        'mention refunds, refunds are not a rule; the evaluator already refuses what ' +
        'nobody authorised.',
      parameters: {
        type: 'object',
        properties: {
          brief: {
            type: 'string',
            description: 'The situation in their own words, one sentence.',
          },
          needs: {
            type: 'array',
            description: 'The actions this work requires. ' + catalogue,
            items: { type: 'string', enum: actionIds },
          },
          rules: {
            type: 'array',
            description: 'Only the permissions and prohibitions they actually stated.',
            items: ruleSchema(actionIds, vocabulary, catalogue),
          },
          scope: {
            type: 'string',
            enum: ['mission', 'session'],
            description: 'mission unless they said something like "from now on".',
          },
        },
        required: ['brief', 'needs'],
      },
      execution_mode: 'interactive',
    },

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
            items: ruleSchema(actionIds, vocabulary, catalogue),
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
            items: ruleSchema(actionIds, vocabulary, catalogue),
          },
        },
        required: ['changes'],
      },
      execution_mode: 'interactive',
    },

    {
      type: FUNCTION_TOOL,
      name: 'set_alert_threshold',
      description:
        'How far the latest daily figure must fall below the recent average before ' +
        'Daily Revenue raises it. Defaults to 20 percent. Call this only when the ' +
        'user names a different number; it changes what gets raised, not what is ' +
        'permitted, so it is not a policy rule and does not go through the gate.',
      parameters: {
        type: 'object',
        properties: {
          drop_percent: {
            type: 'number',
            description: 'A positive number of percent, for example 30 for "a third off".',
          },
        },
        required: ['drop_percent'],
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
export function systemPrompt(corpus) {
  const n = corpus?.skills ?? 110;
  return [
    `You are the voice interface to Standing Order, a governance layer sitting in front`,
    `of an AI commerce workforce of ${n} skills that run on their own, without the`,
    `user watching.`,
    ``,
    `Two things arrive in one sentence and both matter.`,
    ``,
    `When somebody describes a situation they want dealt with, call start_mission.`,
    `It takes the work the situation requires and the boundaries they put around it,`,
    `and those are not the same list. "The product is out of stock, deal with it, but`,
    `don't refund anyone" needs stock read, ads paused and the listing taken down,`,
    `and carries one prohibition. Miss the work and nothing happens; miss the`,
    `boundary and the wrong thing happens.`,
    ``,
    `Asking to be told is itself a permission, and the most commonly missed one.`,
    `"Tell me when takings drop", "let me know if a rival moves", "alert me the`,
    `moment it sells out" all grant send_telegram_message, and it belongs in the`,
    `rules as ALLOW alongside whatever they prohibited in the same breath. Record`,
    `only the prohibitions and you have assembled a team to watch something and`,
    `forbidden it from reporting back, which is the one outcome nobody asked for.`,
    `Sending a message to the operator is also the only outward action connected,`,
    `so it is the cheapest thing to be right about.`,
    ``,
    `Say nothing about what will happen in future until a tool call has returned.`,
    `"I will notify you as soon as takings drop" before start_mission has run is a`,
    `promise made by nobody: there is no mission, no rule, and nothing watching.`,
    `Open the mission first, then say what is now in force.`,
    ``,
    `When they are only adding or changing rules on work already under way, call`,
    `compile_policy or amend_policy instead.`,
    ``,
    `Around that, be a useful colleague. If they ask what a term means, what the`,
    `current policy says, what got blocked, or how any of this works, answer them`,
    `briefly and then carry on. Refusing to explain ROAS makes you look broken, not`,
    `careful. The line you must not cross is deciding permissions, not conversation.`,
    ``,
    `Hold to these:`,
    `- Never describe a capability this system does not have. It cannot read Gmail,`,
    `  Google Drive, a Shopify admin, an ad account or an order database, whatever`,
    `  those words might suggest. What is actually connected is narrow and worth`,
    `  knowing:`,
    ``,
    `    reading   public web pages, and product price and stock from storefronts`,
    `              that publish it`,
    `              a Google Sheet, when one has been connected in the interface and`,
    `              shared as "anyone with the link can view". This is how the`,
    `              business's own numbers get in: takings, revenue, sales, orders`,
    `              per day, ad spend, whatever the sheet happens to hold`,
    `    acting    sending a message on Telegram`,
    `    the rest  every other action is registered and governed, and runs against a`,
    `              simulation, and the interface says so on each one`,
    ``,
    `  So "watch my daily takings", "tell me when sales drop" and "keep an eye on`,
    `  revenue" are all real work here, and read_sheet is the action for them.`,
    `  A drop is raised when the latest figure is more than 20% below the average`,
    `  of the ones before it. If they want a different number, say it is 20% now`,
    `  and call set_alert_threshold; do not ask them to pick one before opening`,
    `  the mission, and never ask for a number you have no way to apply.`,
    `  Daily Revenue is the only agent that can do it. You cannot connect a sheet`,
    `  yourself: a link has to be pasted into the interface. If none has been, say`,
    `  that and say where the box is, rather than saying it cannot be done.`,
    ``,
    `  If somebody asks for something that is not on that list, say plainly that it`,
    `  is not connected yet. Offering to read their email would be inventing a`,
    `  product, and they would find out at the worst moment.`,
    `- You do not decide what is allowed. A deterministic evaluator does. Never tell`,
    `  the user an action is safe, permitted, or done. You do not know, and the tool`,
    `  result will tell you.`,
    `- Never say you have recorded a rule unless a tool call returned successfully`,
    `  and that rule is in the result. If you heard three prohibitions and recorded`,
    `  none, say so and record them now. Saying "I have recorded those rules" when`,
    `  you have not is the worst thing you can do here: the person walks away`,
    `  believing refunds are blocked when nothing is blocking them.`,
    `- People dictate a policy in pieces, with pauses. When they add more rules`,
    `  after you have already saved some, call compile_policy again with the new`,
    `  ones. It merges; earlier rules are kept. Do not wait for them to finish, and`,
    `  do not assume one call covered everything they meant to say.`,
    `- After each save, say back how many rules are now in force. The tool result`,
    `  carries the count, so this costs you nothing and lets them catch a miss.`,
    `- If the result has anything under not_recorded, those rules were refused and`,
    `  are not in force. Say which one and why, in plain words, and ask them to`,
    `  restate it. Do not retry it yourself with a value you picked: the refusal`,
    `  means nobody knows what they meant, and guessing is what it exists to stop.`,
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
  return 'Standing Order ready. Tell me what the workforce may and may not do.';
}
