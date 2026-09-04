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

/**
 * Whichever error line is actually on screen.
 *
 * This used to pick by whether a mission existed, which was the same thing
 * until the board started opening on the press. After that, an error raised
 * before the first mission went to the opening screen's error line, and the
 * opening screen was hidden: a session that failed said so into a box nobody
 * could see, and the symptom was a page that simply did nothing.
 */
const visibleError = () => ($('hero-panel').hidden ? 'err' : 'hero-err');

/**
 * A short record of what the voice connection did.
 *
 * "It didn't do anything" is a true report that fits a session that failed to
 * start, a config the server rejected, a connection that closed, and a model
 * that heard perfectly well and only chatted back. Those need different fixes,
 * and telling them apart took a round of guessing each time. The page now says
 * which one happened.
 */
const WIRE = [];
function note(text) {
  WIRE.push(`${new Date().toTimeString().slice(0, 8)}  ${text}`);
  const box = $('wire');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<b>connection</b>' +
    WIRE.slice(-6).map((l) => `<div>${esc(l)}</div>`).join('');
}
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
  rail.id = 'rail';

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
  const world = endcap('The outside world');
  world.id = 'world';
  rail.appendChild(world);

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whose turn it is.
 *
 * A run used to flash every agent the same way at the same place, which showed
 * that something happened and never who did it. The work is a relay, so it is
 * drawn as one: one agent holds the stage, the rest step back, and the baton
 * moves down the line in the order the pools actually force.
 */
function takeStage(agentId) {
  const rail = $('rail');
  if (rail) rail.classList.add('running');
  for (const el of document.querySelectorAll('.stage.active')) {
    el.classList.remove('active');
    el.classList.add('done');
  }
  const el = $(`s-${agentId}`);
  if (el) {
    el.classList.remove('done');
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  return el;
}

function endRun() {
  const rail = $('rail');
  if (!rail) return;
  for (const el of rail.querySelectorAll('.stage')) el.classList.remove('active', 'done');
  rail.classList.remove('running');
}

/**
 * One request, in flight.
 *
 * Animated between two elements that are actually on the page rather than along
 * hardcoded coordinates, so it stays correct when the rail wraps, the window is
 * a phone, or the team has six agents instead of two.
 */
async function fly(fromEl, toEl, text, tone, ms = 620) {
  const flow = $('flow');
  if (!flow || !fromEl || !toEl) return;

  const base = flow.getBoundingClientRect();
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();

  const p = document.createElement('span');
  p.className = `fly ${tone ?? ''}`;
  p.textContent = text;
  flow.appendChild(p);

  // Kept inside the visible box. The rail scrolls sideways, so on a narrow
  // window the world endcap sits off the edge and an unclamped flight throws
  // the packet out of the panel entirely. Clamped, a cleared request still
  // reads as leaving: it travels to the edge and goes.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const point = (r, edge) => [
    clamp(edge === 'right' ? r.right - base.left - 4 : r.left - base.left + 4, 8, base.width - 8),
    clamp(r.top + r.height / 2 - base.top, 10, base.height - 10),
  ];
  const from = point(a, 'right');
  const to = point(b, 'left');

  const anim = p.animate([
    { transform: `translate(${from[0]}px, ${from[1]}px) translate(-100%, -50%) scale(.82)`, opacity: 0 },
    { transform: `translate(${(from[0] + to[0]) / 2}px, ${(from[1] + to[1]) / 2}px) translate(-50%, -50%) scale(1)`, opacity: 1, offset: .45 },
    { transform: `translate(${to[0]}px, ${to[1]}px) translate(0, -50%) scale(.9)`, opacity: 1 },
  ], { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });

  try { await anim.finished; } catch { /* the run was cut short */ }
  return p;
}

// ── the mission ─────────────────────────────────────────────────────────────

/**
 * Show the working board, mission or no mission.
 *
 * Pressing the microphone used to leave somebody on the opening screen until a
 * mission happened to be created, so the moment they most needed to see what
 * was going on was the moment the least was on show. The board is where the
 * transcript, the orders and the audit live, so it opens as soon as there is
 * anything to watch.
 */
function showBoard() {
  if (!$('board').hidden) return;
  $('hero-panel').hidden = true;
  $('board').hidden = false;

  // Every panel says what it is waiting for. A board of empty boxes reads as
  // broken; a board that says what it is listening for reads as ready.
  //
  // The prompt does not go in the brief: that block is headed "You said", and
  // putting the page's own words there attributes them to the person.
  $('m-brief').hidden = true;
  $('m-team').innerHTML =
    '<p class="empty">Say what needs handling, and how far they may go.<br>' +
    'Whoever is needed appears here.</p>';
  $('m-composition').textContent = '';
  $('flow').innerHTML = '<p class="empty">The shape of the work appears once there is some.</p>';
  $('run-mission').disabled = true;

  // Deliberately not touching the orders. Blanking them here wiped rules that
  // were already in force the moment somebody pressed the microphone: the
  // panel said nothing was stated while two prohibitions were being enforced.
  // Whatever is in force is drawn by refresh, which knows.
  refresh();
}

function renderMission(mission, bp) {
  MISSION = mission;
  BLUEPRINT = bp;

  $('hero-panel').hidden = true;
  $('board').hidden = false;

  $('run-mission').disabled = false;
  $('m-brief').hidden = false;
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

  // A refusal is not a request. Both were headed "Waiting on you", which put a
  // decision that has already been made under a heading that says somebody
  // still has to make it. They read differently and should look different.
  const asked = held.filter((d) => d.verdict === 'ASK');
  const refused = held.filter((d) => d.verdict === 'DENY');

  const item = (d) =>
    `<div class="item"><b>${esc(d.action)}</b> &mdash; ${esc(d.agent)} wanted to, ` +
    `because ${esc(d.why)}.<br>` +
    `<span style="color:var(--muted)">${esc(d.reason)}</span></div>`;

  let html = '';
  if (asked.length) {
    html += `<h4>Waiting on you</h4>${asked.map(item).join('')}`;
  }
  if (refused.length) {
    html += `<h4${asked.length ? ' style="margin-top:11px"' : ''}>Refused</h4>` +
      refused.map(item).join('');
  }
  html += `<p class="ask" style="margin-top:8px;font-size:12px;color:var(--muted)">` +
    `Say what you want done about it and the orders change.</p>`;
  box.innerHTML = html;
}

// ── watching ────────────────────────────────────────────────────────────────

/**
 * Everything the workforce reads, in one list.
 *
 * A rival's product page and the shop's own spreadsheet are different kinds of
 * source and the same kind of answer to "where do these numbers come from", so
 * they share a panel. They are told apart by a mark rather than by a second box:
 * asking somebody to sort a link into the right field before pasting it is work
 * the page can do itself, and the desktop has no room for a second field anyway.
 */
function renderSources(pools) {
  const box = $('watches');
  const listings = pools?.listings ?? [];
  const sheets = pools?.sheets ?? [];

  const hero = $('hero-sources');
  if (hero) {
    const named = [
      ...sheets.map((s) => s.name ?? 'a spreadsheet'),
      ...listings.map((w) => {
        try { return new URL(w.url).hostname.replace(/^www\./, ''); } catch { return w.url; }
      }),
    ];
    hero.textContent = named.length
      ? `Already reading: ${[...new Set(named)].join(', ')}`
      : '';
  }

  if (!listings.length && !sheets.length) {
    box.innerHTML = '<p class="empty">Nothing being read.<br>' +
      'Paste a rival&rsquo;s product page, or a Google Sheet shared as ' +
      '&ldquo;anyone with the link can view&rdquo;.</p>';
    return;
  }

  box.innerHTML = '';

  for (const sheet of sheets) {
    const d = document.createElement('div');
    d.className = 'w sheet';
    // What it says before anybody has read it must not look like a reading.
    const state = sheet.lastError ? sheet.lastError
      : sheet.rows != null ? `${sheet.rows} rows &middot; ${(sheet.headers ?? []).slice(0, 3).join(', ')}`
      : 'not read yet';
    d.innerHTML =
      `<span class="t">${esc(sheet.name ?? 'spreadsheet')}<small>${state}</small></span>` +
      `<span class="p">sheet</span>` +
      `<button class="x" data-sheet="${esc(sheet.url)}" title="Stop reading">&times;</button>`;
    box.appendChild(d);
  }

  for (const w of listings) {
    const host = new URL(w.url).hostname.replace(/^www\./, '');
    const d = document.createElement('div');
    d.className = `w ${w.inStock === false ? 'out' : w.inStock ? 'ok' : ''}`;
    d.innerHTML =
      `<span class="t">${esc(w.title ?? host)}<small>${esc(w.lastError ? w.lastError
        : w.inStock === false ? 'sold out'
        : w.inStock ? `${w.variantsInStock} in stock` : host)}</small></span>` +
      `<span class="p">${w.price ?? '&mdash;'}</span>` +
      `<button class="x" data-url="${esc(w.url)}" title="Stop watching">&times;</button>`;
    box.appendChild(d);
  }

  for (const b of box.querySelectorAll('.x')) {
    b.onclick = async () => {
      const route = b.dataset.sheet ? '/api/sheets/remove' : '/api/watch/remove';
      await api(route, { url: b.dataset.sheet ?? b.dataset.url });
      renderSources((await api('/api/pools')).pools);
    };
  }
}

/**
 * Text into HTML, safely.
 *
 * A sheet is named by whoever shares it and a listing title comes off somebody
 * else's storefront, so both are somebody else's input arriving in an
 * innerHTML. Escaping at the point of insertion rather than trusting the source
 * is the only version of this that stays true when a new source is added.
 */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

/**
 * What the workforce has done over time.
 *
 * The recent list answers "what just happened" and expires with the screen. The
 * ledger behind this answers the question a business actually comes back with a
 * month later, which the session store could never have answered because it did
 * not keep anything that long.
 */
async function renderReport() {
  const box = $('report');
  box.innerHTML = '<p class="empty">Reading the ledger…</p>';
  try {
    const d = await api('/api/report');
    const r = d.report;

    if (!r.window.decisions) {
      box.innerHTML = `<p class="empty">Nothing decided in the last 30 days.` +
        (d.entries ? ` The ledger holds ${d.entries} older.` : '') + `</p>`;
      return;
    }

    const line = (k, v) => `<div class="rep"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const list = (rows, n = 4) => rows.slice(0, n)
      .map((x) => line(x.name, x.count)).join('') || line('nothing', 0);

    box.innerHTML =
      `<div class="rep-hd">Last 30 days</div>` +
      line('Decisions', r.window.decisions) +
      line('Missions', r.missions) +
      line('Cleared', r.verdicts.ALLOW) +
      line('Held for you', r.verdicts.ASK) +
      line('Refused outright', r.verdicts.DENY) +
      line('You were needed', `${Math.round(r.interventionRate * 100)}%`) +

      `<div class="rep-hd">How far it reached</div>` +
      line('Carried out for real', r.reached.real) +
      line('Authorised, sandboxed', r.reached.sandboxed) +

      `<div class="rep-hd">Most often stopped</div>` + list(r.stoppedByAction) +
      `<div class="rep-hd">Busiest</div>` + list(r.byAgent) +
      `<div class="rep-hd">Kept</div>` +
      line(d.kept, `${d.entries} entries`);
  } catch (e) {
    box.innerHTML = `<p class="empty">${e.message}</p>`;
  }
}

function showTab(which) {
  const isReport = which === 'report';
  $('log').hidden = isReport;
  $('report').hidden = !isReport;
  $('tab-log').classList.toggle('on', !isReport);
  $('tab-report').classList.toggle('on', isReport);
  if (isReport) renderReport();
}

async function refresh() {
  const [state, pools] = await Promise.all([api('/api/state'), api('/api/pools')]);
  renderAudit(state.audit);
  if (!$('report').hidden) renderReport();
  renderSources(pools.pools);

  // Orders are drawn whenever there are orders, mission or no mission.
  //
  // This was guarded on a mission existing, so somebody who opened by stating
  // two prohibitions had them recorded on the server, confirmed in the tool
  // result, and shown nowhere: the panel went on saying nothing was stated
  // while two rules were in force. Of every way to be wrong, a governance tool
  // under-reporting what it is enforcing is close to the worst.
  if (state.policy) {
    if (MISSION) MISSION.policy = state.policy;
    $('c-mission').textContent = MISSION
      ? `${MISSION.id} v${state.policy.version}`
      : `standing v${state.policy.version}`;
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

    // Grouped by agent, in the order the server ran them, so the animation is
    // the relay that happened rather than a shuffle of the same decisions.
    const turns = [];
    for (const d of r.decisions) {
      const last = turns.at(-1);
      if (last && last.id === d.audit.skill) last.items.push(d);
      else turns.push({ id: d.audit.skill, name: d.agent, items: [d] });
    }

    let done = 0, held = 0;
    for (const turn of turns) {
      const agentEl = takeStage(turn.id);
      await wait(430);

      for (const d of turn.items) {
        // Out from the agent that wants it, as far as the gate.
        await fly(agentEl ?? $('rail'), $('gate'), d.action, null, 560);
        signal(d.verdict);

        // And on to the world only if it was cleared. A request that stops at
        // the gate has to be seen stopping, or the gate is set dressing.
        if (d.verdict === 'ALLOW') {
          done++;
          await fly($('gate'), $('world'), d.action, 'ALLOW', 520);
        } else {
          held++;
          await fly($('gate'), $('gate'), d.action, d.verdict, 300);
        }
        if ($('g-pass')) { $('g-pass').textContent = done; $('g-hold').textContent = held; }
        for (const el of document.querySelectorAll('.fly')) el.remove();
        await wait(260);
      }
    }
    endRun();
    renderAttention(r.decisions);
    wantVoice(r.decisions.some((d) => d.verdict !== 'ALLOW'));

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
  $('c-conn2').textContent = live ? 'listening' : text;
  $('c-conn2').className = `chip${live ? ' live' : ''}`;

  $('mic').className = `mic-btn${live ? ' live' : ''}`;
  $('mic-lbl').textContent = live ? 'Listening. Tap to stop.' : 'Hold a conversation';
  $('mic-hint').textContent = live
    ? 'it is listening; say what you want changed'
    : 'say what changed, or what they may do now';

  $('hero-lbl').textContent = live ? 'Listening…' : 'Start talking';
  $('hero-mic').className = `mic${live ? ' on' : ''}`;
}

/** When something is held, the microphone is the answer to it. Say so. */
function wantVoice(on) {
  $('mic').classList.toggle('wanted', on);
  if (on) $('mic-hint').textContent = 'something is waiting on you. tell it what to do.';
}

async function talk() {
  if (VOICE) { VOICE.stop(); return; }
  clearFail();
  showBoard();
  note('starting');
  try {
    VOICE = await connect({
      onStatus: (s) => { setConn(s, s === 'live'); note(s); if (s === 'offline') VOICE = null; },
      // Where the turn is, said in the hint line under the button. Somebody who
      // has stopped speaking needs to know whether they were heard before they
      // decide the thing is broken and press stop.
      onTurn: (state) => {
        note(state);
        const hint = $('mic-hint');
        if (hint) {
          hint.textContent = {
            thinking: 'heard you. working out what that means',
            answering: 'answering',
            listening: 'say what changed, or what they may do now',
          }[state] ?? '';
        }
      },
      onUser: (text, final) => {
        $('said').innerHTML = final ? '' : '<span class="partial"></span>';
        (final ? $('said') : $('said').firstChild).textContent = text;
      },
      // Both the part-formed reply and the finished one. Only the final was
      // drawn, so an answer that arrived as deltas left the panel showing the
      // greeting from ten minutes earlier while the log said it had answered
      // twice. What it says has to be readable, not only audible.
      onAgent: (text, final = true) => {
        $('agent').hidden = false;
        $('agent-text').textContent = text;
        $('agent').classList.toggle('partial', !final);
      },
      onMission: (mission, bp) => { note(`mission ${mission.id} opened`); renderMission(mission, bp); },
      // Every tool call, named. A turn where the model answered without calling
      // anything is the commonest way for nothing to happen, and it is
      // invisible unless the calls that did happen are listed.
      onTool: (name, result) => {
        note(`called ${name}${result?.total_rules != null ? ` (${result.total_rules} rules)` : ''}`);
        refresh();
      },
      onError: (m) => { fail(visibleError(), m); note(`error: ${m}`); },
      // An ending nobody asked for gets said out loud, in the panel somebody is
      // already looking at, rather than being left to be inferred from a status
      // chip going quiet.
      onEnded: (why, deliberate) => {
        VOICE = null;
        note(why);
        if (deliberate) return;
        $('agent').hidden = false;
        $('agent-text').textContent = why;
      },
    });
  } catch (e) {
    fail(visibleError(), e.message);
    note(`could not start: ${e.message}`);
    VOICE = null;
  }
}

/**
 * Which of this team will actually do something. Said up front, because a page
 * that lets somebody press run and then reports that four of five agents were
 * only ever descriptions has wasted their time and their trust.
 */
async function showReadiness(missionId) {
  try {
    const r = await api('/api/missions/readiness', { id: missionId });
    const note = document.createElement('p');
    note.className = 'composition';
    note.innerHTML = r.runs.length
      ? `<b style="color:var(--clear)">${r.runs.join(', ')}</b> will really go and look. ` +
        (r.describes.length
          ? `${r.describes.length} others on this team are described but not yet built, and will say so.`
          : '')
      : `Nobody on this team is built yet. They will each say so rather than pretend.`;
    $('m-composition').after(note);
  } catch { /* the readiness note is a courtesy, not a requirement */ }
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
  launches: {
    brief: 'Tell me when a competitor puts out something new, but never change our own prices to match.',
    needs: ['scrape_public_page', 'analyze_data', 'draft_plan'],
    rules: [
      { action: 'scrape_public_page', effect: 'ALLOW' },
      { action: 'send_telegram_message', effect: 'ALLOW' },
      { action: 'draft_plan', effect: 'ALLOW' },
      { action: 'update_price', effect: 'DENY' },
      { action: 'apply_discount', effect: 'ASK' },
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
    $('mic').disabled = true;
    $('hero-mic').disabled = true;
    $('mic-lbl').textContent = 'No API key configured';
    $('mic-hint').textContent = 'everything else still works without it';
  }

  registerWebMCP(catalog.actions
    .filter((a) => a.risk.startsWith('L3') || a.risk.startsWith('L4'))
    .map((a) => a.id));

  addEventListener('signalbox:decision', (e) => { signal(e.detail.verdict); refresh(); });

  for (const b of document.querySelectorAll('[data-eg]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        // Give the watchers something to look at, or the example composes a
        // team and then reports that there is nothing to see.
        await api('/api/watch/seed', {});
        const r = await api('/api/missions', EXAMPLES[b.dataset.eg]);
        renderMission(r.mission, r.blueprint);
        await showReadiness(r.mission.id);
        await refresh();
      } catch (e) { fail('hero-err', e.message); }
      b.disabled = false;
    };
  }

  $('tab-log').onclick = () => showTab('log');
  $('tab-report').onclick = () => showTab('report');

  $('mic').onclick = talk;
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

  /**
   * Connect something for the workforce to read.
   *
   * Takes the input it was given rather than one fixed field, because the same
   * action belongs in two places: on the first screen, where sources should be
   * connected before the work that needs them, and in the panel once a mission
   * is open. It was only in the second, which meant a visitor arriving at the
   * app had nowhere at all to paste a link.
   */
  const addSource = async (inputId, errorId) => {
    const input = $(inputId);
    const url = input.value.trim();
    if (!url) return;
    // A spreadsheet is read as a spreadsheet and a shop page as a shop page.
    // Which one this is can be seen from the link, so it is not worth asking.
    const isSheet = /docs\.google\.com\/spreadsheets\//.test(url);
    try {
      await api(isSheet ? '/api/sheets' : '/api/watch', { url });
      input.value = '';
      renderSources((await api('/api/pools')).pools);
    } catch (e) { fail(errorId, e.message); }
  };

  $('hero-add').onclick = () => addSource('hero-url', 'hero-err');
  $('hero-url').onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) addSource('hero-url', 'hero-err');
  };

  $('watch-add').onclick = () => addSource('watch-url', 'err');
  // One handler. Two assignments to onkeydown meant the second silently
  // replaced the first, which is the kind of thing that reads fine and is
  // simply not there. isComposing is checked because a link can be pasted
  // beside text somebody is still composing.
  $('watch-url').onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) addSource('watch-url', 'err');
  };

  $('run-watch').onclick = async () => {
    const b = $('run-watch');
    b.disabled = true;
    b.textContent = '…';
    try {
      // Whatever is being read gets read. Checking only the rival pages while a
      // spreadsheet sits in the same list, under the same button, would be a
      // button that quietly does less than the panel it sits on says it does.
      const pools = (await api('/api/pools')).pools ?? {};
      const who = ['A11'];
      if ((pools.sheets ?? []).length) who.push('A30');

      const notes = [];
      for (const agent of who) {
        const r = await api('/api/agents/run', { agent });
        notes.push(...(r.observed ?? []));
        for (const d of r.decisions ?? []) {
          const agentEl = takeStage(d.audit?.skill ?? agent);
          await fly(agentEl ?? $('rail'), $('gate'), d.action, null, 480);
          signal(d.verdict);
          if (d.verdict === 'ALLOW') await fly($('gate'), $('world'), d.action, 'ALLOW', 440);
          for (const el of document.querySelectorAll('.fly')) el.remove();
        }
      }
      endRun();
      // A read that found nothing worth acting on still happened, and saying so
      // beats a silent button that looks broken.
      if (notes.length) $('watch-note').textContent = notes[notes.length - 1];
    } catch (e) { fail('err', e.message); }
    b.disabled = false;
    b.textContent = 'Check';
    await refresh();
  };

  renderBands({ rules: [] });

  // Both halves, and a warning when they disagree. The server build alone
  // answers "what was deployed", never "what am I running", and those coming
  // apart is what a stale bundle looks like from the inside.
  try {
    const h = await api('/api/health');
    const mine = document.querySelector('meta[name="build"]')?.content ?? '?';
    const chip = $('c-build');
    chip.textContent = h.version === mine ? mine : `${mine} \u2260 ${h.version}`;
    chip.title = h.version === mine
      ? 'this page and the server are the same build'
      : `this page was built from ${mine}; the server is running ${h.version}. Reload.`;
    chip.classList.toggle('stale', h.version !== mine);
  } catch { $('c-build').textContent = 'offline'; }

  await refresh();
})();
