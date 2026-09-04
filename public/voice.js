/**
 * The voice connection, as a module so the console and the floor can share it.
 *
 * Audio goes from this browser straight to AssemblyAI with a short-lived token
 * the server mints. It never reaches our server, so we cannot store anyone's
 * voice even by accident. What our server sees is the tool call that comes out
 * the other end.
 */

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const SAMPLE_RATE = 24000;

const api = (path, body) => fetch(path, body
  ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  : undefined).then(async (r) => {
    const d = await r.json().catch(() => ({ error: `${r.status}` }));
    if (!r.ok) throw new Error(d.error ?? `${r.status}`);
    return d;
  });

/**
 * @param {object} h  onStatus, onUser(text, isFinal), onAgent, onTool, onError, onLevel
 * @returns {{stop: () => void}}
 */
export async function connect(h = {}) {
  const say = (k, ...a) => h[k]?.(...a);

  // A fresh token per connection: they are single-use, including on reconnect.
  const [{ token }, config] = await Promise.all([
    api('/api/token'),
    api('/api/session-config'),
  ]);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false },
    });
  } catch {
    throw new Error('Microphone permission is needed. Allow it and press talk again.');
  }

  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  let audioCtx = null, node = null, playAt = 0, closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (node) { node.port.onmessage = null; node.disconnect(); }
    audioCtx?.close().catch(() => {});
    stream?.getTracks().forEach((t) => t.stop());
    say('onStatus', 'offline');
  };

  ws.onopen = () => {
    say('onStatus', 'connecting');
    ws.send(JSON.stringify({ type: 'session.update', session: config }));
  };
  ws.onerror = () => say('onError', 'The voice connection failed. Check the browser console.');
  ws.onclose = teardown;

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'session.ready':
        say('onStatus', 'live');
        await startCapture();
        break;

      case 'transcript.user.delta': say('onUser', msg.text ?? '', false); break;
      case 'transcript.user':       say('onUser', msg.text ?? '', true); break;
      case 'transcript.agent':      say('onAgent', msg.text ?? ''); break;
      case 'reply.audio':           play(msg.data ?? msg.audio); break;

      case 'tool.call': {
        // The two published shapes for this event disagree: one nests the
        // fields under `tool`, the other keeps them flat. Accept both, and log
        // what actually arrived so the ambiguity settles on evidence.
        const t = msg.tool ?? msg;
        const name = t.name;
        const callId = t.call_id ?? msg.call_id;
        const args = t.arguments ?? t.parameters ?? {};
        console.log('[tool.call]', name, JSON.stringify(msg).slice(0, 500));

        let result, isError = false;
        try {
          result = await runTool(name, args);
        } catch (e) {
          result = { error: e.message };
          isError = true;
          say('onError', `${name} failed: ${e.message}`);
        }
        ws.send(JSON.stringify({
          type: 'tool.result', call_id: callId, result: JSON.stringify(result), is_error: isError,
        }));
        say('onTool', name, result);
        break;
      }

      case 'session.error': say('onError', `${msg.code}: ${msg.message}`); break;
      case 'session.ended': teardown(); break;
    }
  };

  /**
   * What the agent is allowed to do here. Each returns plain data, and that data
   * is what the agent reads back, so none of it may claim an action ran.
   * `not_recorded` carries rules the server refused: the agent has to say so.
   */
  async function runTool(name, args) {
    if (name === 'start_mission') {
      const r = await api('/api/missions', {
        brief: args.brief ?? '',
        needs: args.needs ?? [],
        rules: args.rules ?? [],
        scope: args.scope ?? 'mission',
      });
      say('onMission', r.mission, r.blueprint);
      return {
        mission_id: r.mission.id,
        team: r.mission.team.map((m) => `${m.name}: ${m.reason}`),
        why_this_team: r.mission.composition,
        orders_in_force: r.mission.policy.rules.map((x) => `${x.action}: ${x.effect}`),
        nobody_can_do: r.unknownNeeds ?? [],
        not_recorded: (r.rejected ?? []).map((x) => `${x.rule.action ?? '?'}: ${x.reason}`),
        note: 'Assembled and bounded. Nothing has run yet.',
      };
    }

    if (name === 'compile_policy') {
      const r = await api('/api/policy/compile', {
        rules: args.rules ?? [], scope: args.scope ?? 'mission',
      });
      return {
        policy_id: r.policy.policyId,
        version: r.policy.version,
        merged_into_existing: r.merged === true,
        rules_in_force: r.policy.rules.map((x) => `${x.action}: ${x.effect}`),
        total_rules: r.policy.rules.length,
        not_recorded: (r.rejected ?? []).map((x) => `${x.rule.action ?? '?'}: ${x.reason}`),
        note: 'Recorded. Nothing has run yet.',
      };
    }

    if (name === 'amend_policy') {
      const r = await api('/api/policy/amend', { changes: args.changes ?? [] });
      return {
        policy_id: r.policy.policyId,
        version: r.policy.version,
        rules_in_force: r.policy.rules.map((x) => `${x.action}: ${x.effect}`),
        not_recorded: (r.rejected ?? []).map((x) => `${x.rule.action ?? '?'}: ${x.reason}`),
      };
    }

    if (name === 'report_status') {
      const s = await api('/api/state');
      const held = s.audit.filter((e) => e.verdict !== 'ALLOW');
      return {
        policy_version: s.policy?.version ?? null,
        rules_in_force: s.policy?.rules.map((x) => `${x.action}: ${x.effect}`) ?? [],
        decisions: s.audit.length,
        held: held.map((e) => ({ action: e.action, verdict: e.verdict, reason: e.reason })),
      };
    }

    throw new Error(`no such tool: ${name}`);
  }

  // ── capture ───────────────────────────────────────────────────────────────
  async function startCapture() {
    // Ask the context for 24 kHz directly rather than resampling by hand, and
    // the drift that comes with doing it by hand.
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const worklet = URL.createObjectURL(new Blob([`
      class Cap extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0][0];
          if (ch) this.port.postMessage(new Float32Array(ch));
          return true;
        }
      }
      registerProcessor('cap', Cap);
    `], { type: 'application/javascript' }));

    await audioCtx.audioWorklet.addModule(worklet);
    URL.revokeObjectURL(worklet);

    node = new AudioWorkletNode(audioCtx, 'cap');
    node.port.onmessage = ({ data }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const pcm = new Int16Array(data.length);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      say('onLevel', Math.sqrt(sum / data.length));
      ws.send(JSON.stringify({ type: 'input.audio', audio: toBase64(pcm.buffer) }));
    };
    audioCtx.createMediaStreamSource(stream).connect(node);
  }

  function play(base64) {
    if (!audioCtx || !base64) return;
    const raw = atob(base64);
    const pcm = new Int16Array(raw.length / 2);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = (raw.charCodeAt(i * 2 + 1) << 8) | raw.charCodeAt(i * 2);
    }
    const buf = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    playAt = Math.max(playAt, audioCtx.currentTime);
    src.start(playAt);
    playAt += buf.duration;
  }

  return {
    stop() {
      // session.end first, then let the server close. A bare close leaves the
      // session inside a 30-second resume window, and that window is billable.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.end' }));
      else teardown();
    },
  };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
