/**
 * The board.
 *
 * One mission at a time, laid out so the whole argument is visible at once:
 * what was said, who it put to work, what they may do, and where an action
 * stops. Nothing here decides anything; every verdict on screen came from the
 * evaluator over HTTP, and the page only shows it.
 */

import { connect } from './voice.js';
import { registerWebMCP } from './webmcp.js';

const $ = (id) => document.getElementById(id);

const api = (path, body) => fetch(path, body
  ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  : undefined).then(async (r) => {
    const d = await r.json().catch(() => ({ error: `${r.status}` }));
    if (!r.ok) throw new Error(d.error ?? `${r.status}`);
    return d;
  });

let MISSION = null, BLUEPRINT = null, VOICE = null;

const fail = (where, msg) => { $(where).textContent = msg; $(where).classList.add('show'); };
const clearFail = () => { for (const id of ['err', 'hero-err']) $(id)?.classList.remove('show'); };

// ── the flow ────────────────────────────────────────────────────────────────

function stageEl(stage) {
  const d = document.createElement('div');
  d.className = `stage${stage.support ? ' support' : ''}`;
  d.id = `s-${stage.id}`;
  d.title = stage.reason ?? '';
  d.innerHTML = `<span class="e">${stage.emoji}</span><span class="n">${stage.name}</span>`;
  return d;
}

function linkEl(label) {
  const d = document.createElement('div');
  d.className = 'link';
  d.style.position = 'relative';
  d.innerHTML = `<i></i>${label ? `<span class="lbl">${label}</span>` : ''}`;
  return d;
}

function endcap(text) {
  const d = document.createElement('div');
  d.className = 'endcap';
  d.textContent = text;
  return d;
}

function renderFlow(bp) {
  const flow = $('flow');
  flow.innerHTML = '';
  if (!bp) return;

  const rail = document.createElement('div');
  rail.className = 'rail';

  rail.appendChild(endcap(bp.source));
  rail.appendChild(linkEl('wakes'));

  const agents = document.createElement('div');
  agents.className = 'col agents';
  for (const stage of bp.stages) agents.appendChild(stageEl(stage));
  rail.appendChild(agents);

  rail.appendChild(linkEl('wants to act'));

  const gate = document.createElement('div');
  gate.className = 'col';
  gate.innerHTML =
    `<div class="gate" id="gate">` +
    `<p class="ttl">Standing<br>Order</p>` +
    `<div class="sig"><i></i><i></i><i></i></div>` +
    `<p class="cnt"><b id="g-pass">0</b> done &middot; <b id="g-hold">0</b> held</p></div>`;
  rail.appendChild(gate);

  rail.appendChild(linkEl('cleared only'));
  rail.appendChild(endcap('The outside world'));

  flow.appendChild(rail);
}

function signal(verdict) {
  const g = $('gate');
  if (g) {
    g.className = `gate s-${verdict}`;
    setTimeout(() => { g.className = 'gate'; }, 2400);
  }
  const lamps = $('lamps').children;
  for (const l of lamps) l.className = '';
  lamps[verdict === 'DENY' ? 0 : verdict === 'ASK' ? 1 : 2].className = 'on';
}

function markStage(agentId, verdict) {
  const el = $(`s-${agentId}`);
  if (!el) return;
  el.classList.add('busy');
  setTimeout(() => {
    el.classList.remove('busy');
    el.classList.add(verdict === 'ALLOW' ? 'cleared' : 'held');
    setTimeout(() => el.classList.remove('cleared', 'held'), 2400);
  }, 550);
}

function packet(text) {
  const gate = $('gate');
  if (!gate) return;
  const p = document.createElement('span');
  p.className = 'pkt';
  p.textContent = text;
  p.style.left = '50%';
  p.style.top = '50%';
  gate.style.position = 'relative';
  gate.appendChild(p);
  setTimeout(() => p.remove(), 1250);
}

// ── the mission ─────────────────────────────────────────────────────────────

function renderMission(mission, bp) {
  MISSION = mission;
  BLUEPRINT = bp;

  $('hero-panel').hidden = true;
  $('board').hidden = false;

  $('m-id').textContent = mission.id;
  $('m-brief').querySelector('span').textContent = mission.brief;
  $('c-mission').textContent = `${mission.id} v${mission.policy.version}`;
  $('c-fp').textContent = mission.fingerprint;

  const team = $('m-team');
  team.innerHTML = '';
  for (const m of mission.team) {
    const d = document.createElement('div');
    d.className = `member${m.support ? ' support' : ''}`;
    d.innerHTML = `<span class="e">${m.emoji}</span>` +
      `<span><span class="n">${m.name}</span><span class="r">${m.reason}</span></span>`;
    team.appendChild(d);
  }

  // Why these and not the others, in the page rather than in a footnote. It is
  // the difference between a team and a list.
  $('m-composition').textContent = mission.composition +
    (mission.passedOver?.length
      ? ` ${mission.passedOver.length} others could have helped and would have added nothing.`
      : '');

  renderBands(mission.policy);
  renderFlow(bp);
}

function renderBands(policy) {
  const groups = [
    ['allow', 'On their own', policy.rules.filter((r) => r.effect === 'ALLOW')],
    ['ask', 'Ask first', policy.rules.filter((r) => r.effect === 'ASK')],
    ['deny', 'Never', policy.rules.filter((r) => r.effect === 'DENY')],
  ];
  $('m-bands').innerHTML = groups.map(([cls, title, rules]) =>
    `<div class="band ${cls}"><h4>${title}</h4>` +
    (rules.length
      ? `<ul>${rules.map((r) => `<li>${r.action}${r.conditions
          ? ` <span style="opacity:.7">${Object.entries(r.conditions)
              .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}</span>`
          : ''}</li>`).join('')}</ul>`
      : '<p class="none">nothing stated, so nothing assumed</p>') +
    '</div>').join('');
}

function renderAttention(decisions) {
  const held = decisions.filter((d) => d.verdict !== 'ALLOW');
  const box = $('m-attention');
  if (!held.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h4>Waiting on you</h4>` + held.map((d) =>
    `<div class="item"><b>${d.action}</b> &mdash; ${d.agent} wanted to, because ${d.why}.<br>` +
    `<span style="color:var(--muted)">${d.reason}</span></div>`).join('') +
    `<p class="ask" style="margin-top:8px;font-size:12px;color:var(--muted)">` +
    `Say what you want done about it and the orders change.</p>`;
}

// ── watching ────────────────────────────────────────────────────────────────

function renderWatches(listings) {
  const box = $('watches');
  if (!listings?.length) {
    box.innerHTML = '<p class="empty">Nothing watched.<br>Shopify shops read cleanest: ' +
      'they publish price and stock rather than hiding it in the page.</p>';
    return;
  }
  box.innerHTML = '';
  for (const w of listings) {
    const host = new URL(w.url).hostname.replace(/^www\./, '');
    const d = document.createElement('div');
    d.className = `w ${w.inStock === false ? 'out' : w.inStock ? 'ok' : ''}`;
    d.innerHTML =
      `<span class="t">${w.title ?? host}<small>${w.lastError ? w.lastError
        : w.inStock === false ? 'sold out'
        : w.inStock ? `${w.variantsInStock} in stock` : host}</small></span>` +
      `<span class="p">${w.price ?? '—'}</span>` +
      `<button class="x" data-url="${w.url}" title="Stop watching">&times;</button>`;
    box.appendChild(d);
  }
  for (const b of box.querySelectorAll('.x')) {
    b.onclick = async () => renderWatches((await api('/api/watch/remove', { url: b.dataset.url })).watching);
  }
}

// ── audit ───────────────────────────────────────────────────────────────────

function renderAudit(entries) {
  const box = $('log');
  $('c-audit').textContent = entries.length;
  if (!entries.length) { box.innerHTML = '<p class="empty">Nothing decided yet</p>'; return; }
  box.innerHTML = '';
  for (const e of entries.slice(-40)) {
    const d = document.createElement('div');
    d.className = 'lrow';
    const did = e.verdict !== 'ALLOW' ? 'not run' : e.performed ? 'sent' : 'simulated';
    d.innerHTML =
      `<span class="ts">${e.at.slice(11, 19)}</span>` +
      `<span class="ac">${e.action}</span>` +
      `<span><span class="tag ${e.real ? 'real' : ''}">${did}</span> ` +
      `<span class="v ${e.verdict}">${e.verdict}</span></span>` +
      `<span class="why">${e.reason}${e.outcome ? ` &middot; ${e.outcome}` : ''}</span>`;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const [state, pools] = await Promise.all([api('/api/state'), api('/api/pools')]);
  renderAudit(state.audit);
  renderWatches(pools.pools?.listings);
  if (MISSION && state.policy) {
    MISSION.policy = state.policy;
    $('c-mission').textContent = `${MISSION.id} v${state.policy.version}`;
    $('c-fp').textContent = state.fingerprint ?? '—';
    renderBands(state.policy);
  }
}

// ── running ─────────────────────────────────────────────────────────────────

async function runMission() {
  const btn = $('run-mission');
  btn.disabled = true;
  btn.textContent = 'Running…';
  clearFail();
  try {
    const r = await api('/api/missions/run', { id: MISSION?.id });

    let done = 0, held = 0;
    for (const d of r.decisions) {
      markStage(d.audit.skill, d.verdict);
      packet(d.action);
      signal(d.verdict);
      d.verdict === 'ALLOW' ? done++ : held++;
      if ($('g-pass')) { $('g-pass').textContent = done; $('g-hold').textContent = held; }
      await new Promise((res) => setTimeout(res, 900));
    }
    renderAttention(r.decisions);

    if (!r.decisions.length) {
      renderAttention([]);
      $('m-composition').textContent =
        `Nothing has changed since the last look, so nobody asked to do anything. ` +
        r.observed.slice(0, 2).join(' ');
    }
  } catch (e) {
    fail('err', e.message);
  }
  btn.disabled = false;
  btn.textContent = 'Run it';
  await refresh();
}

// ── voice ───────────────────────────────────────────────────────────────────

function setConn(text, live) {
  $('c-conn').textContent = text;
  $('c-conn').className = `chip${live ? ' live' : ''}`;
  const talking = live;
  $('talk').textContent = talking ? 'Stop' : 'Talk';
  $('talk').className = talking ? 'stop' : '';
  $('hero-lbl').textContent = talking ? 'Listening…' : 'Start talking';
  $('hero-mic').className = `mic${talking ? ' on' : ''}`;
}

async function talk() {
  if (VOICE) { VOICE.stop(); return; }
  clearFail();
  try {
    VOICE = await connect({
      onStatus: (s) => { setConn(s, s === 'live'); if (s === 'offline') VOICE = null; },
      onUser: (text, final) => {
        $('said').innerHTML = final ? '' : '<span class="partial"></span>';
        (final ? $('said') : $('said').firstChild).textContent = text;
      },
      onAgent: (text) => { $('agent').hidden = false; $('agent-text').textContent = text; },
      onMission: (mission, bp) => renderMission(mission, bp),
      onTool: refresh,
      onError: (m) => fail(MISSION ? 'err' : 'hero-err', m),
    });
  } catch (e) {
    fail(MISSION ? 'err' : 'hero-err', e.message);
    VOICE = null;
  }
}

// ── the worked examples, for when nobody wants to talk to a laptop ──────────

const EXAMPLES = {
  stock: {
    brief: "A product just went out of stock. Handle it, but don't refund or cancel anything, and ask me before you tell customers.",
    needs: ['read_inventory', 'pause_ad', 'delist_product', 'mark_out_of_stock', 'notify_customer'],
    rules: [
      { action: 'pause_ad', effect: 'ALLOW' },
      { action: 'delist_product', effect: 'ALLOW' },
      { action: 'mark_out_of_stock', effect: 'ALLOW' },
      { action: 'send_telegram_message', effect: 'ALLOW' },
      { action: 'notify_customer', effect: 'ASK' },
      { action: 'issue_refund', effect: 'DENY' },
      { action: 'cancel_order', effect: 'DENY' },
    ],
  },
  revenue: {
    brief: "Revenue is down this week and I don't know why. Find out, and don't change any prices while you look.",
    needs: ['read_metrics', 'read_orders', 'analyze_data', 'forecast', 'generate_report'],
    rules: [
      { action: 'read_metrics', effect: 'ALLOW' },
      { action: 'generate_report', effect: 'ALLOW' },
      { action: 'send_telegram_message', effect: 'ALLOW' },
      { action: 'update_price', effect: 'DENY' },
      { action: 'change_ad_budget', effect: 'ASK' },
    ],
  },
  rivals: {
    brief: 'Watch what my competitors are charging and tell me when anything moves.',
    needs: ['scrape_public_page', 'analyze_data', 'read_ranking'],
    rules: [
      { action: 'scrape_public_page', effect: 'ALLOW' },
      { action: 'send_telegram_message', effect: 'ALLOW' },
      { action: 'update_price', effect: 'ASK' },
    ],
  },
};

// ── boot ────────────────────────────────────────────────────────────────────

(async () => {
  const [health, catalog] = await Promise.all([api('/api/health'), api('/api/actions')]);

  $('c-corpus').innerHTML = `<b>${health.corpus?.skills ?? '?'}</b> governed`;
  if (!health.keyConfigured) {
    setConn('no API key', false);
    $('talk').disabled = true;
    $('hero-mic').disabled = true;
  }

  registerWebMCP(catalog.actions
    .filter((a) => a.risk.startsWith('L3') || a.risk.startsWith('L4'))
    .map((a) => a.id));

  addEventListener('signalbox:decision', (e) => { signal(e.detail.verdict); refresh(); });

  for (const b of document.querySelectorAll('[data-eg]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('/api/missions', EXAMPLES[b.dataset.eg]);
        renderMission(r.mission, r.blueprint);
        await refresh();
      } catch (e) { fail('hero-err', e.message); }
      b.disabled = false;
    };
  }

  $('talk').onclick = talk;
  $('hero-mic').onclick = talk;
  $('run-mission').onclick = runMission;

  $('reset').onclick = async () => {
    await api('/api/reset', {});
    MISSION = null;
    $('board').hidden = true;
    $('hero-panel').hidden = false;
    $('said').textContent = '';
    $('agent').hidden = true;
    $('c-mission').textContent = 'no mission';
    $('c-fp').textContent = '—';
  };

  $('watch-add').onclick = async () => {
    const url = $('watch-url').value.trim();
    if (!url) return;
    try {
      renderWatches((await api('/api/watch', { url })).watching);
      $('watch-url').value = '';
    } catch (e) { fail('err', e.message); }
  };
  $('watch-url').onkeydown = (e) => { if (e.key === 'Enter') $('watch-add').click(); };

  $('run-watch').onclick = async () => {
    const b = $('run-watch');
    b.disabled = true;
    b.textContent = '…';
    try {
      const r = await api('/api/agents/run', { agent: 'A11' });
      for (const d of r.decisions ?? []) { signal(d.verdict); packet(d.action); }
    } catch (e) { fail('err', e.message); }
    b.disabled = false;
    b.textContent = 'Check';
    await refresh();
  };

  await refresh();
})();
