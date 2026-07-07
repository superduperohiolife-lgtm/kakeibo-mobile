/* Kendo Tournament Manager — frontend v0.2
 * 3-tier login (view/edit/admin, auto-detected from single key).
 * POST uses text/plain to avoid CORS preflight.
 */
'use strict';

const CFG_KEY = 'kendo_cfg_v2';
let cfg = load();
let role = null;
function load() { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; } }
function save() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', !!isErr); t.classList.remove('hidden');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------------- API ----------------
async function apiGet(action, params) {
  const q = new URLSearchParams(Object.assign({ action, k: cfg.k }, params || {}));
  const res = await fetch(cfg.api + '?' + q.toString());
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
}
async function apiPost(action, body) {
  const payload = Object.assign({ action, k: cfg.k, by: cfg.by || role }, body || {});
  const res = await fetch(cfg.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
}

// ---------------- Login gate ----------------
$('#gateEnter').addEventListener('click', tryLogin);
$('#gateKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
async function tryLogin() {
  const api = $('#gateApi').value.trim();
  const k = $('#gateKey').value.trim();
  if (!api || !k) { $('#gateErr').textContent = 'Enter both URL and key.'; return; }
  cfg.api = api; cfg.k = k;
  try {
    const who = await apiGet('whoami');
    role = who.role; cfg.role = role; save();
    enterApp();
  } catch (e) { $('#gateErr').textContent = e.message; }
}
function enterApp() {
  $('#loginGate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#roleBadge').textContent = role.toUpperCase();
  $('#roleBadge').className = 'role-badge ' + role;
  applyRoleUI();
  boot();
}
function logout() { cfg = {}; save(); location.reload(); }

// role → which tabs are visible; default landing tab
function applyRoleUI() {
  const r = { view: 1, edit: 2, admin: 3 }[role];
  $$('.tab').forEach((t) => {
    const min = { edit: 2, admin: 3 }[t.dataset.min] || 1;
    t.classList.toggle('hidden', r < min);
  });
  // division pulldown only for view/edit (hidden for admin per req #10)
  $('#divisionSelect').classList.toggle('hidden', role === 'admin');
}

// ---------------- Tabs ----------------
$$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(id) {
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === id));
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  stopPolling();
  if (id === 'view-view') { startPolling(); }
  if (id === 'view-input') refreshInput();
  if (id === 'view-admin') loadAdmin();
}

// View sub-tabs
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  $('#subPlacement').classList.toggle('hidden', b.dataset.sub !== 'placement');
  $('#subElim').classList.toggle('hidden', b.dataset.sub !== 'elim');
  $('#subList').classList.toggle('hidden', b.dataset.sub !== 'list');
  if (b.dataset.sub === 'elim') renderElim();
}));

// ---------------- Division / state ----------------
let meta = { tournaments: [], divisions: [] };
let state = null;
let pollTimer = null;

async function loadMeta() {
  meta = await apiGet('meta');
  const sel = $('#divisionSelect');
  sel.innerHTML = '<option value="">Select division…</option>' + meta.divisions.map((d) => {
    const t = meta.tournaments.find((x) => x.tournament_id === d.tournament_id);
    return `<option value="${esc(d.division_id)}">${esc(t ? t.name + ' / ' : '')}${esc(d.name)}</option>`;
  }).join('');
  if (cfg.division_id) sel.value = cfg.division_id;
}
$('#divisionSelect').addEventListener('change', async (e) => {
  cfg.division_id = e.target.value; save(); state = null;
  await refreshState(); renderAll();
});
async function refreshState() {
  if (!cfg.division_id) return;
  try { state = await apiGet('state', { division_id: cfg.division_id });
    $('#pollStatus').textContent = 'Updated ' + new Date().toLocaleTimeString(); }
  catch (e) { toast(e.message, true); }
}
function renderAll() { renderPlacement(); renderElim(); renderMatchList(); }

// ---------------- Helpers for rendering ----------------
function entryName(id) {
  if (!id) return null;
  if (id === 'BYE') return { name: 'BYE', team: '', bye: true };
  const e = state.entries.find((x) => x.entry_id === id);
  return e ? { name: e.name, team: e.team } : { name: '?', team: '' };
}
function nameBlock(id) {
  const e = entryName(id);
  if (!e) return '<span class="tbd">—</span>';
  if (e.bye) return '<span class="bye">BYE</span>';
  return `<span class="pn">${esc(e.name)}</span>${e.team ? `<span class="pt">${esc(e.team)}</span>` : ''}`;
}
function ptsLabel(p) { return p ? p.split(',').join(' ') : ''; }
function courtTag(m) { return m.court ? `<span class="court">Court ${esc(m.court)}</span>` : ''; }
function outcomeTag(m) {
  if (m.outcome === 'bye') return '<em>BYE</em>';
  if (m.outcome === 'fusen') return '<em>Fusen</em>';
  if (m.outcome === 'encho') return '<em>Encho</em>';
  return '';
}

// Placement view (list of P matches)
function renderPlacement() {
  const area = $('#subPlacement');
  if (!state) { area.innerHTML = '<p class="meta">Select a division.</p>'; return; }
  const ps = state.matches.filter((m) => m.phase === 'placement');
  if (!ps.length) { area.innerHTML = '<p class="meta">This division has no placement round.</p>'; return; }
  area.innerHTML = ps.map(matchCard).join('');
}

function matchCard(m, tappable) {
  const wr = m.winner === 'R', ww = m.winner === 'W';
  return `<div class="match ${tappable ? 'tappable' : ''}" data-mid="${esc(m.match_id)}">
    <div class="mcode">${esc(m.code)} ${courtTag(m)} ${outcomeTag(m)}</div>
    <div class="side-row red ${wr ? 'won' : ''}"><i></i><div class="nm">${nameBlock(m.red_entry_id)}</div><b class="pts">${esc(ptsLabel(m.red_points))}</b></div>
    <div class="side-row white ${ww ? 'won' : ''}"><i></i><div class="nm">${nameBlock(m.white_entry_id)}</div><b class="pts">${esc(ptsLabel(m.white_points))}</b></div>
  </div>`;
}

// Match list
function renderMatchList() {
  const area = $('#subList');
  if (!state) { area.innerHTML = ''; return; }
  let html = '<table class="mlist"><tr><th>Match</th><th>Court</th><th>Red</th><th>R</th><th>W</th><th>White</th></tr>';
  state.matches.forEach((m) => {
    const rn = entryName(m.red_entry_id), wn = entryName(m.white_entry_id);
    html += `<tr>
      <td>${esc(m.code)}</td><td>${esc(m.court || '')}</td>
      <td class="${m.winner === 'R' ? 'won' : ''}">${rn ? esc(rn.name) + (rn.team ? ' <small>' + esc(rn.team) + '</small>' : '') : '—'}</td>
      <td class="red-lbl">${esc(ptsLabel(m.red_points))}</td>
      <td class="white-lbl">${esc(ptsLabel(m.white_points))}</td>
      <td class="${m.winner === 'W' ? 'won' : ''}">${wn ? esc(wn.name) + (wn.team ? ' <small>' + esc(wn.team) + '</small>' : '') : '—'}</td>
    </tr>`;
  });
  area.innerHTML = html + '</table>';
}

// ---------------- Elimination SVG bracket with connector lines ----------------
let zoom = 1;
let courtSel = '';   // '' = all
function renderCourtFilter() {
  const host = $('#courtFilter');
  if (!state) { host.innerHTML = ''; return; }
  const courts = [...new Set(state.matches.filter((m) => m.phase === 'elim1' || m.phase === 'elim').map((m) => m.court).filter(Boolean))].sort();
  if (!courts.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<button class="cf ${courtSel === '' ? 'on' : ''}" data-c="">All</button>` +
    courts.map((c) => `<button class="cf ${courtSel === c ? 'on' : ''}" data-c="${esc(c)}">Court ${esc(c)}</button>`).join('');
  $$('#courtFilter .cf').forEach((b) => b.addEventListener('click', () => { courtSel = b.dataset.c; renderElim(); }));
}
function renderElim() {
  const host = $('#elimScroll');
  renderCourtFilter();
  if (!state) { host.innerHTML = '<p class="meta">Select a division.</p>'; return; }
  let elimMatches = state.matches.filter((m) => m.phase === 'elim1' || m.phase === 'elim');
  if (courtSel) elimMatches = elimMatches.filter((m) => m.court === courtSel);
  const third = elimMatches.filter((m) => m.code === '3RD');
  const main = elimMatches.filter((m) => m.code !== '3RD');
  if (!main.length) { host.innerHTML = '<p class="meta">No matches for this court.</p>'; return; }

  // group by round
  const rounds = {};
  main.forEach((m) => { (rounds[m.round] = rounds[m.round] || []).push(m); });
  const roundNums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  roundNums.forEach((r) => rounds[r].sort((a, b) => a.match_id < b.match_id ? -1 : 1));

  // layout constants
  const COL_W = 210, GAP_X = 46, BOX_W = 176, BOX_H = 46, PAD = 20;
  const baseGapY = 20;
  const n0 = rounds[roundNums[0]].length;
  const unit = BOX_H + baseGapY;                 // vertical unit for first round pairs
  const totalH = n0 * (BOX_H * 2 + baseGapY) + PAD * 2;
  const totalW = roundNums.length * (COL_W + GAP_X) + PAD * 2;

  // compute y-center of each match
  const centers = {}; // code -> {x, yTop, yBot, cx, cy}
  roundNums.forEach((rn, ri) => {
    const list = rounds[rn];
    const x = PAD + ri * (COL_W + GAP_X);
    list.forEach((m, mi) => {
      let cy;
      if (ri === 0) {
        cy = PAD + mi * (BOX_H * 2 + baseGapY) + BOX_H;
      } else {
        // center between the two feeding matches
        const feeders = feederCodes(m);
        const ys = feeders.map((c) => centers[c] && centers[c].cy).filter((v) => v != null);
        cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : PAD + mi * (BOX_H * 2 + baseGapY) + BOX_H;
      }
      centers[m.code] = { x, cy, yTop: cy - BOX_H, code: m.code, m };
    });
  });

  let svg = `<svg width="${totalW * zoom}" height="${totalH * zoom}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg" font-family="Calibri, sans-serif">`;
  // connector lines first
  roundNums.forEach((rn, ri) => {
    if (ri === 0) return;
    rounds[rn].forEach((m) => {
      const tgt = centers[m.code];
      feederCodes(m).forEach((fc) => {
        const f = centers[fc]; if (!f) return;
        const x1 = f.x + BOX_W, x2 = tgt.x, midx = (x1 + x2) / 2;
        const won = f.m.winner && isAdvancer(f.m, m);
        svg += `<path d="M${x1} ${f.cy} H${midx} V${tgt.cy} H${x2}" fill="none" stroke="${won ? '#b3261e' : '#c8ccd2'}" stroke-width="${won ? 3 : 1.6}"/>`;
      });
    });
  });
  // boxes
  roundNums.forEach((rn) => {
    rounds[rn].forEach((m) => {
      const c = centers[m.code];
      svg += bracketBox(m, c.x, c.yTop, BOX_W, BOX_H);
    });
  });
  svg += '</svg>';
  host.innerHTML = svg;
  if (third.length) host.innerHTML += '<h3>3rd place</h3>' + third.map(matchCard).join('');
}

function feederCodes(m) {
  const out = [];
  [m.red_source, m.white_source].forEach((s) => {
    const mm = String(s).match(/^match:([^:]+):/); if (mm) out.push(mm[1]);
  });
  return out;
}
function isAdvancer(fm, target) {
  // does the winner of fm feed target's red or white?
  const w = fm.winner === 'R' ? fm.red_entry_id : fm.white_entry_id;
  return target.red_entry_id === w || target.white_entry_id === w;
}
function srcHint(src) {
  // e.g. match:P3:W -> "Grp3 W", match:P5:L -> "Grp5 L"
  const mm = String(src).match(/^match:P(\d+):(W|L)$/);
  if (mm) return 'Grp' + mm[1] + ' ' + mm[2];
  if (src === 'BYE') return 'BYE';
  return '';
}
function bracketBox(m, x, y, w, h) {
  const half = h / 2;
  const wr = m.winner === 'R', ww = m.winner === 'W';
  const red = entryName(m.red_entry_id), white = entryName(m.white_entry_id);
  function line(e, won, isRed, yy) {
    const fill = won ? '#fdf3e7' : '#ffffff';
    const stripe = isRed ? '#b3261e' : '#ffffff';
    const stroke = isRed ? '#b3261e' : '#9aa0a6';
    const hint = isRed ? srcHint(m.red_source) : srcHint(m.white_source);
    const nm = e ? (e.bye ? 'BYE' : e.name) : (hint || '—');
    const tm = e && e.team ? e.team : '';
    return `<g>
      <rect x="${x}" y="${yy}" width="${w}" height="${half}" fill="${fill}" stroke="#d9dce1"/>
      <rect x="${x}" y="${yy}" width="5" height="${half}" fill="${stripe}" stroke="${stroke}" stroke-width="0.6"/>
      <text x="${x + 12}" y="${yy + (tm ? half / 2 - 1 : half / 2 + 4)}" font-size="12" font-weight="${won ? 700 : 400}" fill="${e ? '#1c1c1c' : '#aab'}">${esc(clip(nm, 18))}</text>
      ${tm ? `<text x="${x + 12}" y="${yy + half - 5}" font-size="9" fill="#888">${esc(clip(tm, 22))}</text>` : ''}
      <text x="${x + w - 8}" y="${yy + half / 2 + 4}" font-size="11" text-anchor="end" fill="#333">${esc(ptsLabel(isRed ? m.red_points : m.white_points))}</text>
    </g>`;
  }
  const codeLbl = `<text x="${x}" y="${y - 3}" font-size="9" fill="#8a8f98">${esc(m.code)}${m.court ? ' · C' + esc(m.court) : ''}</text>`;
  return codeLbl + line(red, wr, true, y) + line(white, ww, false, y + half);
}
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

$$('.zoombar button').forEach((b) => b.addEventListener('click', () => {
  const z = b.dataset.z;
  if (z === 'in') zoom = Math.min(2, zoom + 0.15);
  else if (z === 'out') zoom = Math.max(0.4, zoom - 0.15);
  else if (z === 'fit') { const host = $('#elimScroll'); const svg = host.querySelector('svg'); if (svg) { const vw = host.clientWidth - 8; const bw = parseFloat(svg.getAttribute('viewBox').split(' ')[2]); zoom = Math.max(0.4, Math.min(1, vw / bw)); } }
  $('#zoomLbl').textContent = Math.round(zoom * 100) + '%';
  renderElim();
}));

// ---------------- Polling ----------------
function startPolling() {
  stopPolling();
  const tick = async () => { await refreshState(); renderAll(); };
  tick(); pollTimer = setInterval(tick, 8000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---------------- Result entry ----------------
async function refreshInput() {
  if (!cfg.division_id) { $('#readyMatches').innerHTML = '<p class="meta">Select a division.</p>'; $('#doneMatches').innerHTML = ''; return; }
  if (!state) await refreshState();
  if (!state) return;
  const ready = state.matches.filter((m) => m.red_entry_id && m.white_entry_id && !m.winner && m.red_entry_id !== 'BYE' && m.white_entry_id !== 'BYE');
  const done = state.matches.filter((m) => m.winner && m.outcome !== 'bye');
  $('#readyMatches').innerHTML = ready.length ? ready.map((m) => matchCard(m, true)).join('') : '<p class="meta">No matches ready for entry.</p>';
  $('#doneMatches').innerHTML = done.map((m) => `<div class="done-row">${matchCard(m, false)}<button class="undo" data-mid="${esc(m.match_id)}">Undo</button></div>`).join('');
  $$('#readyMatches .match.tappable').forEach((el) => el.addEventListener('click', () => openResultDialog(el.dataset.mid)));
  $$('#doneMatches .undo').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Undo this result? Downstream matches will also be cleared.')) return;
    try { await apiPost('undo_result', { division_id: cfg.division_id, match_id: b.dataset.mid }); toast('Undone'); await refreshState(); refreshInput(); }
    catch (e) { toast(e.message, true); }
  }));
}

let dlg = { mid: null, winner: null, red: [], white: [] };
function openResultDialog(mid) {
  const m = state.matches.find((x) => x.match_id === mid); if (!m) return;
  dlg = { mid, winner: null, red: [], white: [] };
  $('#rdTitle').textContent = m.code + ' — result';
  $('#rdRedBtn').textContent = 'Red: ' + nameOf(m.red_entry_id);
  $('#rdWhiteBtn').textContent = 'White: ' + nameOf(m.white_entry_id);
  $('#rdOutcome').value = 'normal';
  renderChips(); updateWinnerUI();
  $('#resultDialog').showModal();
}
function nameOf(eid) { const e = state.entries.find((x) => x.entry_id === eid); return e ? e.name : '?'; }
function renderChips() {
  ['red', 'white'].forEach((side) => {
    const box = $(side === 'red' ? '#rdRedPts' : '#rdWhitePts');
    box.innerHTML = ['M', 'K', 'D', 'T', 'H'].map((p) =>
      `<button type="button" class="chip ${dlg[side].includes(p) ? 'on' : ''}" data-side="${side}" data-p="${p}">${p}${countOf(dlg[side], p) === 2 ? '×2' : ''}</button>`).join('');
  });
  $$('.chip').forEach((c) => c.addEventListener('click', () => {
    const side = c.dataset.side, p = c.dataset.p, arr = dlg[side], cnt = countOf(arr, p);
    if (cnt < 1 && arr.length < 2) arr.push(p);
    else if (cnt === 1 && arr.length < 2) arr.push(p);
    else removeAll(arr, p);
    renderChips();
  }));
}
function countOf(a, p) { return a.filter((x) => x === p).length; }
function removeAll(a, p) { for (let i = a.length - 1; i >= 0; i--) if (a[i] === p) a.splice(i, 1); }
$('#rdRedBtn').addEventListener('click', () => { dlg.winner = 'R'; updateWinnerUI(); });
$('#rdWhiteBtn').addEventListener('click', () => { dlg.winner = 'W'; updateWinnerUI(); });
function updateWinnerUI() { $('#rdRedBtn').classList.toggle('sel', dlg.winner === 'R'); $('#rdWhiteBtn').classList.toggle('sel', dlg.winner === 'W'); }
$('#rdCancel').addEventListener('click', () => $('#resultDialog').close());
$('#rdSave').addEventListener('click', async () => {
  if (!dlg.winner) { toast('Choose the winner (Red/White).', true); return; }
  try {
    await apiPost('save_result', { division_id: cfg.division_id, match_id: dlg.mid, winner: dlg.winner, red_points: dlg.red.join(','), white_points: dlg.white.join(','), outcome: $('#rdOutcome').value });
    $('#resultDialog').close(); toast('Saved'); await refreshState(); refreshInput();
  } catch (e) { toast(e.message, true); }
});

// ---------------- Admin ----------------
async function loadAdmin() {
  try {
    await loadMeta();
    $('#tourSelect').innerHTML = meta.tournaments.map((t) => `<option value="${esc(t.tournament_id)}">${esc(t.name)}</option>`).join('');
    try { const s = await apiGet('sheet_url'); $('#sheetLink').href = s.url; } catch (e) {}
  } catch (e) { toast(e.message, true); }
}
$('#chkPlacement').addEventListener('change', (e) => {
  $('#placementOpts').classList.toggle('hidden', !e.target.checked);
  $('#elimOpts').classList.toggle('hidden', e.target.checked);
});
$('#btnCreateTour').addEventListener('click', async () => {
  try { const r = await apiPost('create_tournament', { name: $('#newTourName').value.trim(), date: $('#newTourDate').value }); toast('Created ' + r.tournament_id); $('#newTourName').value = ''; loadAdmin(); }
  catch (e) { toast(e.message, true); }
});
$('#btnCreateDiv').addEventListener('click', async () => {
  const placement = $('#chkPlacement').checked;
  try {
    const r = await apiPost('create_division', { tournament_id: $('#tourSelect').value, name: $('#newDivName').value.trim(), placement, courts: $('#courtCount').value, group_count: placement ? $('#groupCount').value : undefined, bracket_size: placement ? undefined : $('#bracketSize').value, third_place: placement ? false : $('#chkThird').checked });
    toast(`Created ${r.division_id} (${r.slots} slots)`); cfg.division_id = r.division_id; save(); await loadMeta();
  } catch (e) { toast(e.message, true); }
});
$('#btnSearchPlayers').addEventListener('click', async () => {
  try {
    const rows = await apiGet('players', { team: $('#teamFilter').value, q: $('#nameFilter').value });
    $('#playerList').innerHTML = rows.length ? '<table class="mlist"><tr><th>ID</th><th>Name</th><th>Team</th></tr>' + rows.map((p) => `<tr><td>${esc(p.player_id)}</td><td>${esc(p.name)}</td><td>${esc(p.team)}</td></tr>`).join('') + '</table>' : '<p class="meta">No matches.</p>';
    loadTeams(rows);
  } catch (e) { toast(e.message, true); }
});
async function loadTeams(rows) {
  try { const players = rows || await apiGet('players'); const teams = [...new Set(players.map((p) => p.team).filter(Boolean))].sort(); $('#teamList').innerHTML = teams.map((t) => `<option value="${esc(t)}">`).join(''); } catch (e) {}
}
$('#btnAddPlayer').addEventListener('click', async () => {
  const name = $('#newName').value.trim(), team = $('#newTeam').value.trim();
  if (!name) { toast('Enter a player name.', true); return; }
  try { const r = await apiPost('register_player', { name, team }); toast('Added ' + r.player_id); $('#newName').value = ''; loadTeams(); }
  catch (e) { toast(e.message, true); }
});

// Slot assignment
let slotPlayers = [];
$('#btnLoadSlots').addEventListener('click', async () => {
  if (!cfg.division_id) { toast('Select a division at the top.', true); return; }
  try {
    await refreshState(); slotPlayers = await apiGet('players');
    const slotSrc = state.matches.flatMap((m) => [m.red_source, m.white_source].filter((s) => /^slot:\d+$/.test(String(s))));
    if (!slotSrc.length) { $('#slotArea').innerHTML = '<p class="meta">This division has no slot inputs.</p>'; return; }
    const maxSlot = Math.max(...slotSrc.map((s) => parseInt(s.split(':')[1], 10)));
    const bySlot = {}; state.entries.forEach((e) => { bySlot[String(e.slot)] = e; });
    let html = '';
    for (let s = 1; s <= maxSlot; s++) {
      const cur = bySlot[String(s)];
      html += `<div class="slot-row"><span class="slot-no">${s}</span>
        <select class="slot-sel" data-slot="${s}"><option value="">(empty)</option><option value="BYE" ${cur && cur.player_id === 'BYE' ? 'selected' : ''}>BYE</option>
        ${slotPlayers.map((p) => `<option value="${esc(p.player_id)}" ${cur && cur.player_id === p.player_id ? 'selected' : ''}>${esc(p.team)} ${esc(p.name)}</option>`).join('')}</select>
        <input class="slot-comp" data-slot="${s}" placeholder="Comp #" value="${esc(cur ? cur.comp_no : '')}"></div>`;
    }
    $('#slotArea').innerHTML = html; $('#btnSaveSlots').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
});
$('#btnSaveSlots').addEventListener('click', async () => {
  const assignments = $$('.slot-sel').map((sel) => ({ slot: parseInt(sel.dataset.slot, 10), player_id: sel.value, comp_no: ($(`.slot-comp[data-slot="${sel.dataset.slot}"]`) || {}).value || '' })).filter((a) => a.player_id);
  try { await apiPost('assign_entries', { division_id: cfg.division_id, assignments }); toast('Assignment saved'); await refreshState(); }
  catch (e) { toast(e.message, true); }
});

// Elimination round-1 link editor (case Y: default seed + editable before start)
$('#btnLoadMap').addEventListener('click', async () => {
  if (!cfg.division_id) { toast('Select a division.', true); return; }
  try {
    await refreshState();
    const e1 = state.matches.filter((m) => m.phase === 'elim1');
    if (!e1.length) { $('#mapArea').innerHTML = '<p class="meta">No round-1 links for this bracket.</p>'; $('#btnSaveMap').classList.add('hidden'); return; }
    const ps = state.matches.filter((m) => m.phase === 'placement');
    const groups = ps.map((m) => m.code.replace('P', ''));
    const locked = state.matches.some((m) => (m.phase === 'elim1' || m.phase === 'elim') && m.winner && m.outcome !== 'bye');
    const cur = {};
    e1.forEach((m) => {
      ['R', 'W'].forEach((side) => {
        const src = side === 'R' ? m.red_source : m.white_source;
        const mm = String(src).match(/^match:P(\d+):(W|L)$/);
        cur[m.code + ':' + side] = mm ? mm[1] + ':' + mm[2] : (src === 'BYE' ? 'BYE' : '');
      });
    });
    let html = locked ? '<p class="meta" style="color:#b3261e">Locked — elimination results exist. Undo them to edit.</p>' : '<p class="meta">Default = standard seed. Edit any slot before matches start.</p>';
    html += '<table class="maptbl"><tr><th>Match</th><th>Court</th><th>Red source</th><th>White source</th></tr>';
    e1.forEach((m) => {
      html += `<tr><td>${esc(m.code)}</td><td>${esc(m.court || '')}</td>
        <td>${srcSelect(m.code, 'R', groups, cur, locked)}</td>
        <td>${srcSelect(m.code, 'W', groups, cur, locked)}</td></tr>`;
    });
    $('#mapArea').innerHTML = html + '</table>';
    $('#btnSaveMap').classList.toggle('hidden', locked);
  } catch (e) { toast(e.message, true); }
});
function srcSelect(code, side, groups, cur, locked) {
  const sel = cur[code + ':' + side] || '';
  let opts = '<option value="BYE">(BYE)</option>';
  groups.forEach((g) => {
    ['W', 'L'].forEach((res) => {
      const v = g + ':' + res;
      opts += `<option value="${v}" ${sel === v ? 'selected' : ''}>Grp ${g} ${res === 'W' ? 'Winner' : 'Loser'}</option>`;
    });
  });
  return `<select class="map-sel" data-code="${code}" data-side="${side}" ${locked ? 'disabled' : ''}>${opts}</select>`;
}
$('#btnSaveMap').addEventListener('click', async () => {
  const links = $$('.map-sel').map((sel) => ({ elim_code: sel.dataset.code, side: sel.dataset.side, src: sel.value === 'BYE' ? 'BYE' : 'P' + sel.value }));
  try { await apiPost('set_links', { division_id: cfg.division_id, links }); toast('Links saved'); await refreshState(); renderAll(); }
  catch (e) { toast(e.message, true); }
});

// Courts
$('#btnLoadCourts').addEventListener('click', async () => {
  if (!cfg.division_id) { toast('Select a division.', true); return; }
  try {
    await refreshState();
    let html = '<table class="maptbl"><tr><th>Match</th><th>Court</th></tr>';
    state.matches.forEach((m) => { html += `<tr><td>${esc(m.code)}</td><td><input class="court-in" data-mid="${esc(m.match_id)}" value="${esc(m.court || '')}" placeholder="e.g. C"></td></tr>`; });
    $('#courtArea').innerHTML = html + '</table><button id="btnSaveCourts" class="primary">Save courts</button>';
    $('#btnSaveCourts').addEventListener('click', async () => {
      try {
        for (const inp of $$('.court-in')) {
          await apiPost('set_court', { division_id: cfg.division_id, match_id: inp.dataset.mid, court: inp.value.trim() });
        }
        toast('Courts saved'); await refreshState();
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
});

// ---------------- Boot ----------------
async function boot() {
  try {
    await loadMeta();
    if (role === 'admin') { switchTab('view-admin'); }
    else {
      if (cfg.division_id) { $('#divisionSelect').value = cfg.division_id; await refreshState(); renderAll(); }
      switchTab('view-view');
    }
  } catch (e) { toast(e.message, true); }
}

// autologin if cfg present
(function () {
  $('#roleBadge').addEventListener('dblclick', logout); // hidden logout
  if (cfg.api && cfg.k) {
    $('#gateApi').value = cfg.api; $('#gateKey').value = cfg.k;
    apiGet('whoami').then((w) => { role = w.role; enterApp(); }).catch(() => { /* stay on gate */ });
  }
})();
