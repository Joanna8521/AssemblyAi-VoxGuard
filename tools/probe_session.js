/**
 * Probe: which session.update payloads does the Voice Agent API actually accept?
 *
 * "Invalid session configuration" names no field, and the published docs
 * disagree with each other about the tool shape. So rather than guess in the
 * browser one reload at a time, this connects for real and reports exactly what
 * came back for each variant.
 *
 *   node --env-file=.env tools/probe_session.js
 *
 * Every variant gets its own connection and its own token, because tokens are
 * single-use. Each run costs a few seconds of billed connection time.
 *
 * FINDING (measured 2026-09-04, two rounds)
 *
 *   `type: 'function'` is mandatory on every tool. Without it the session is
 *   rejected as "Invalid session configuration" with `param: null`, which names
 *   nothing. The REST agent reference lists tool fields without it; the events
 *   reference includes it. The events reference is right.
 *
 *   Round one could not have concluded that on its own: the two schema variants
 *   that failed were also missing `type`, so their failure was confounded with
 *   it. Round two re-ran every schema shape with the field present and all of
 *   them passed, including an array of objects, an object property with no
 *   `properties` of its own, an empty `properties`, and three tools at once.
 *   The field was the whole story; the schemas were never the problem.
 */

const KEY = process.env.ASSEMBLYAI_API_KEY;
if (!KEY) {
  console.error('ASSEMBLYAI_API_KEY is not set');
  process.exit(1);
}

async function token() {
  const url = new URL('https://agents.assemblyai.com/v1/token');
  url.searchParams.set('expires_in_seconds', '60');
  url.searchParams.set('max_session_duration_seconds', '60');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).token;
}

const SIMPLE_TOOL = {
  name: 'ping',
  description: 'Call this when the user says ping.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
};

const RULE_ITEM = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['pause_ad', 'notify_customer'] },
    effect: { type: 'string', enum: ['ALLOW', 'DENY', 'ASK'] },
  },
  required: ['action', 'effect'],
};

const VARIANTS = [
  ['bare', {}],
  ['prompt only', { system_prompt: 'You are a test agent.' }],
  ['prompt + greeting', { system_prompt: 'You are a test agent.', greeting: 'Ready.' }],
  ['+ one flat tool', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.', tools: [SIMPLE_TOOL],
  }],
  ['+ tool with type:function', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.',
    tools: [{ type: 'function', ...SIMPLE_TOOL }],
  }],
  ['+ tool with execution_mode', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.',
    tools: [{ ...SIMPLE_TOOL, execution_mode: 'interactive' }],
  }],
  ['+ tool with type and execution_mode', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.',
    tools: [{ type: 'function', ...SIMPLE_TOOL, execution_mode: 'interactive' }],
  }],
  ['+ nested array-of-object param', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.',
    tools: [{
      type: 'function',
      name: 'compile_policy',
      description: 'Compile spoken rules into a policy.',
      parameters: {
        type: 'object',
        properties: { rules: { type: 'array', items: RULE_ITEM } },
        required: ['rules'],
      },
    }],
  }],
  ['+ free-form object property', {
    system_prompt: 'You are a test agent.', greeting: 'Ready.',
    tools: [{
      type: 'function',
      name: 'compile_policy',
      description: 'Compile spoken rules into a policy.',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['pause_ad'] },
                effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
                // The suspect: a property typed `object` with no `properties`.
                conditions: { type: 'object', description: 'free-form' },
              },
              required: ['action', 'effect'],
            },
          },
        },
        required: ['rules'],
      },
    }],
  }],
];

function attempt(label, session) {
  return new Promise(async (resolve) => {
    let t;
    try {
      t = await token();
    } catch (e) {
      return resolve({ label, outcome: 'token failed', detail: e.message });
    }

    const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(t)}`);
    const seen = [];
    let settled = false;

    const done = (outcome, detail) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ label, outcome, detail, seen });
    };

    const timer = setTimeout(() => done('timeout', `saw: ${seen.join(', ') || 'nothing'}`), 9000);

    ws.onopen = () => ws.send(JSON.stringify({ type: 'session.update', session }));

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      seen.push(m.type);
      if (m.type === 'session.error') {
        clearTimeout(timer);
        // `param` is optional in the docs. If it is populated it names the field,
        // which is the entire reason for running this.
        done('REJECTED', JSON.stringify({ code: m.code, message: m.message, param: m.param ?? null }));
      }
      if (m.type === 'session.ready' || m.type === 'session.updated') {
        clearTimeout(timer);
        // Close politely: a bare close leaves a billable resume window open.
        try { ws.send(JSON.stringify({ type: 'session.end' })); } catch {}
        setTimeout(() => done('accepted', m.type), 300);
      }
    };

    ws.onerror = () => { clearTimeout(timer); done('socket error', ''); };
  });
}

for (const [label, session] of VARIANTS) {
  const r = await attempt(label, session);
  const mark = r.outcome === 'accepted' ? 'OK  ' : r.outcome === 'REJECTED' ? 'FAIL' : '??  ';
  console.log(`${mark} ${label.padEnd(34)} ${r.outcome}`);
  if (r.detail) console.log(`     ${r.detail}`);
  if (r.seen?.length) console.log(`     events: ${r.seen.join(' -> ')}`);
}
