/**
 * Kendo Tournament Management System — GAS Web App API v0.2
 * Spec: kendo_tournament_system_design_v1_1.md
 *
 * Run initSetup() once to create sheets and keys.
 *
 * Access keys (Script Properties):
 *   VIEW_KEY  … view only
 *   EDIT_KEY  … view + result entry
 *   ADMIN_KEY … everything (setup: tournament/division/player/slot/court/placement-map)
 */

// ============================================================
// Schema
// ============================================================
const SHEET_DEFS = {
  PlayerMaster: ['player_id', 'name', 'team', 'note', 'created_at', 'is_active'],
  Tournaments:  ['tournament_id', 'name', 'date', 'status'],
  Divisions:    ['division_id', 'tournament_id', 'name', 'type', 'placement', 'third_place', 'status'],
  Entries:      ['entry_id', 'division_id', 'player_id', 'comp_no', 'slot', 'status'],
  Matches:      ['match_id', 'division_id', 'code', 'phase', 'round', 'court',
                 'red_source', 'white_source', 'red_entry_id', 'white_entry_id',
                 'winner', 'red_points', 'white_points', 'outcome',
                 'updated_at', 'updated_by']
};

const VALID_POINTS = ['M', 'K', 'D', 'T', 'H'];   // Men / Kote / Do / Tsuki / Hansoku
const FUSEN_MARK = '\u25cb,\u25cb';               // walkover: two hollow circles = 2 points

// ============================================================
// Setup (run once, manually)
// ============================================================
function initSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEET_DEFS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(SHEET_DEFS[name]); sh.setFrozenRows(1); }
  });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('VIEW_KEY'))  props.setProperty('VIEW_KEY', 'view2026');
  if (!props.getProperty('EDIT_KEY'))  props.setProperty('EDIT_KEY', 'edit2026');
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', 'admin2026');
  Logger.log('Setup done. VIEW=%s EDIT=%s ADMIN=%s',
    props.getProperty('VIEW_KEY'), props.getProperty('EDIT_KEY'), props.getProperty('ADMIN_KEY'));
}

// ============================================================
// Utilities
// ============================================================
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet missing: ' + name + ' (run initSetup)');
  return sh;
}
function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = SHEET_DEFS[name];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const obj = { _row: r + 1 };
    headers.forEach(function (h, c) { obj[h] = values[r][c]; });
    out.push(obj);
  }
  return out;
}
function appendRow_(name, obj) {
  const headers = SHEET_DEFS[name];
  sheet_(name).appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}
function patchRow_(name, row, patch) {
  const headers = SHEET_DEFS[name];
  const sh = sheet_(name);
  Object.keys(patch).forEach(function (h) {
    const c = headers.indexOf(h);
    if (c >= 0) sh.getRange(row, c + 1).setValue(patch[h]);
  });
}
function nextId_(name, idCol, prefix, pad) {
  const rows = readAll_(name);
  let max = 0;
  rows.forEach(function (r) {
    const m = String(r[idCol]).match(new RegExp('^' + prefix + '-(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + String(max + 1).padStart(pad || 4, '0');
}
function now_() { return new Date().toISOString(); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return json_({ ok: true, data: data }); }
function err_(msg) { return json_({ ok: false, error: String(msg) }); }

function roleOf_(k) {
  if (!k) return null;
  const p = PropertiesService.getScriptProperties();
  if (k === p.getProperty('ADMIN_KEY')) return 'admin';
  if (k === p.getProperty('EDIT_KEY'))  return 'edit';
  if (k === p.getProperty('VIEW_KEY'))  return 'view';
  return null;
}
function rank_(role) { return { view: 1, edit: 2, admin: 3 }[role] || 0; }

// ============================================================
// Entry points
// ============================================================
function doGet(e) {
  try {
    const p = e.parameter || {};
    const role = roleOf_(p.k);
    if (!role) return err_('Invalid key');
    switch (p.action) {
      case 'whoami':    return ok_({ role: role });
      case 'meta':      return ok_(actMeta_());
      case 'state':     return ok_(actState_(p.division_id));
      case 'players':   { const g = needs_(role, 'admin'); return g || ok_(actPlayers_(p.team, p.q)); }
      case 'sheet_url': { const g = needs_(role, 'admin'); return g || ok_({ url: ss_().getUrl() }); }
      default:          return err_('Unknown action: ' + p.action);
    }
  } catch (ex) { return err_(ex.message); }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (ex) { return err_('Busy. Please retry in a few seconds.'); }
  try {
    const p = JSON.parse(e.postData.contents);
    const role = roleOf_(p.k);
    if (!role) return err_('Invalid key');
    if (p.action === 'save_result' || p.action === 'undo_result') {
      const gate = needs_(role, 'edit'); if (gate) return gate;
    } else {
      const gate = needs_(role, 'admin'); if (gate) return gate;
    }
    switch (p.action) {
      case 'register_player':   return ok_(actRegisterPlayer_(p));
      case 'create_tournament': return ok_(actCreateTournament_(p));
      case 'create_division':   return ok_(actCreateDivision_(p));
      case 'assign_entries':    return ok_(actAssignEntries_(p));
      case 'set_court':         return ok_(actSetCourt_(p));
      case 'set_links':         return ok_(actSetLinks_(p));
      case 'save_result':       return ok_(actSaveResult_(p));
      case 'undo_result':       return ok_(actUndoResult_(p));
      default:                  return err_('Unknown action: ' + p.action);
    }
  } catch (ex) {
    return err_(ex.message);
  } finally {
    lock.releaseLock();
  }
}

function needs_(role, min) {
  if (rank_(role) < rank_(min)) return err_('Permission denied (requires ' + min + ')');
  return null;
}

// ============================================================
// Read actions
// ============================================================
function strip_(o) { delete o._row; return o; }
function actMeta_() {
  return { tournaments: readAll_('Tournaments').map(strip_), divisions: readAll_('Divisions').map(strip_) };
}
function actState_(divisionId) {
  if (!divisionId) throw new Error('division_id required');
  const players = {};
  readAll_('PlayerMaster').forEach(function (p) { players[p.player_id] = p; });
  const entries = readAll_('Entries')
    .filter(function (e) { return e.division_id === divisionId; })
    .map(function (e) {
      const p = players[e.player_id];
      e.name = e.player_id === 'BYE' ? 'BYE' : (p ? p.name : '?');
      e.team = e.player_id === 'BYE' ? '' : (p ? p.team : '');
      delete e._row; return e;
    });
  const matches = readAll_('Matches')
    .filter(function (m) { return m.division_id === divisionId; }).map(strip_);
  const division = readAll_('Divisions')
    .filter(function (d) { return d.division_id === divisionId; }).map(strip_)[0] || null;
  return { division: division, entries: entries, matches: matches, generated_at: now_() };
}
function actPlayers_(team, q) {
  let rows = readAll_('PlayerMaster').filter(function (p) { return p.is_active !== false && p.is_active !== 'FALSE'; });
  if (team) rows = rows.filter(function (p) { return String(p.team).indexOf(team) >= 0; });
  if (q) rows = rows.filter(function (p) { return String(p.name).indexOf(q) >= 0; });
  return rows.map(strip_);
}

// ============================================================
// Write actions
// ============================================================
function actRegisterPlayer_(p) {
  if (!p.name) throw new Error('Player name required');
  const team = p.team || '';
  const dup = readAll_('PlayerMaster').filter(function (r) {
    return r.name === p.name && r.team === team && r.is_active !== false && r.is_active !== 'FALSE';
  })[0];
  if (dup) throw new Error('Duplicate player: "' + p.name + '" in team "' + (team || '(none)') + '" already exists (' + dup.player_id + ')');
  const id = nextId_('PlayerMaster', 'player_id', 'PL', 4);
  appendRow_('PlayerMaster', { player_id: id, name: p.name, team: team, note: p.note || '', created_at: now_(), is_active: true });
  return { player_id: id };
}
function actCreateTournament_(p) {
  if (!p.name) throw new Error('Tournament name required');
  const dup = readAll_('Tournaments').filter(function (t) { return t.name === p.name; })[0];
  if (dup) throw new Error('Duplicate tournament name: "' + p.name + '" already exists (' + dup.tournament_id + ')');
  const id = nextId_('Tournaments', 'tournament_id', 'T', 3);
  appendRow_('Tournaments', { tournament_id: id, name: p.name, date: p.date || '', status: 'draft' });
  return { tournament_id: id };
}
function actCreateDivision_(p) {
  if (!p.tournament_id || !p.name) throw new Error('tournament_id and division name required');
  const dup = readAll_('Divisions').filter(function (d) { return d.tournament_id === p.tournament_id && d.name === p.name; })[0];
  if (dup) throw new Error('Duplicate division name: "' + p.name + '" already exists in this tournament (' + dup.division_id + ')');
  const placement = !!p.placement;
  const divId = nextId_('Divisions', 'division_id', 'D', 3);
  appendRow_('Divisions', {
    division_id: divId, tournament_id: p.tournament_id, name: p.name,
    type: 'individual', placement: placement,
    third_place: placement ? false : !!p.third_place, status: 'setup'
  });
  const courts = Math.max(1, parseInt(p.courts, 10) || 1);
  if (placement) {
    const G = parseInt(p.group_count, 10);
    if (!(G >= 2 && G <= 60)) throw new Error('group_count must be 2..60 (max 120 players)');
    genPlacementBracket_(divId, G, courts);
    return { division_id: divId, slots: G * 2 };
  } else {
    const S = parseInt(p.bracket_size, 10);
    if ([4, 8, 16, 32, 64, 128].indexOf(S) < 0) throw new Error('bracket_size must be 4/8/16/32/64/128');
    genSingleElim_(divId, S, !!p.third_place, courts);
    return { division_id: divId, slots: S };
  }
}
function actAssignEntries_(p) {
  if (!p.division_id || !Array.isArray(p.assignments)) throw new Error('Invalid arguments');
  const existing = {};
  readAll_('Entries').forEach(function (e) { if (e.division_id === p.division_id) existing[String(e.slot)] = e; });
  p.assignments.forEach(function (a) {
    if (!a.slot) return;
    const cur = existing[String(a.slot)];
    if (cur) {
      patchRow_('Entries', cur._row, { player_id: a.player_id || '', comp_no: a.comp_no || '', status: 'active' });
    } else if (a.player_id) {
      appendRow_('Entries', {
        entry_id: nextId_('Entries', 'entry_id', 'E', 4),
        division_id: p.division_id, player_id: a.player_id, comp_no: a.comp_no || '', slot: a.slot, status: 'active'
      });
    }
  });
  resolveDivision_(p.division_id);
  return { assigned: p.assignments.length };
}
function actSetCourt_(p) {
  const m = findMatch_(p.division_id, p.match_id);
  if (!m) throw new Error('Match not found: ' + p.match_id);
  patchRow_('Matches', m._row, { court: p.court || '' });
  return { match_id: p.match_id, court: p.court || '' };
}
/**
 * Edit elim round-1 links (v0.3, case Y). Editable only before any elim result exists.
 * p:{ division_id, links: [ {elim_code, side('R'|'W'), src} ] }
 *   src = 'P{g}:W' | 'P{g}:L' | 'BYE' | 'slot:{n}'
 */
function actSetLinks_(p) {
  if (!p.division_id || !Array.isArray(p.links)) throw new Error('Invalid arguments');
  const matches = readAll_('Matches').filter(function (m) { return m.division_id === p.division_id; });
  // guard: no elim result yet
  const hasElimResult = matches.some(function (m) { return (m.phase === 'elim1' || m.phase === 'elim') && m.winner && m.outcome !== 'bye'; });
  if (hasElimResult) throw new Error('Links are locked: elimination results already exist. Undo them first.');
  const byCode = {}; matches.forEach(function (m) { byCode[m.code] = m; });
  p.links.forEach(function (r) {
    const tgt = byCode[r.elim_code];
    if (!tgt || tgt.phase !== 'elim1') throw new Error('Not an editable round-1 match: ' + r.elim_code);
    let src = r.src || 'BYE';
    if (/^P\d+:(W|L)$/.test(src)) src = 'match:' + src;
    else if (/^slot:\d+$/.test(src) || src === 'BYE') { /* ok */ }
    else throw new Error('Invalid source: ' + src);
    const col = r.side === 'R' ? 'red_source' : 'white_source';
    const o = {}; o[col] = src;
    patchRow_('Matches', tgt._row, o);
  });
  resolveDivision_(p.division_id);
  return { updated: p.links.length };
}
function actSaveResult_(p) {
  const m = findMatch_(p.division_id, p.match_id);
  if (!m) throw new Error('Match not found: ' + p.match_id);
  if (!m.red_entry_id || !m.white_entry_id) throw new Error('Both competitors must be set before entry');
  if (m.red_entry_id === 'BYE' || m.white_entry_id === 'BYE') throw new Error('BYE match auto-resolves');
  if (p.winner !== 'R' && p.winner !== 'W') throw new Error('winner must be R/W');
  const outcome = p.outcome || 'normal';
  let redPts = normPoints_(p.red_points);
  let whitePts = normPoints_(p.white_points);
  if (outcome === 'fusen') {
    redPts = p.winner === 'R' ? FUSEN_MARK : '';
    whitePts = p.winner === 'W' ? FUSEN_MARK : '';
  } else {
    const wPts = p.winner === 'R' ? redPts : whitePts;
    if (!wPts) throw new Error('Winner needs at least one point symbol');
  }
  if (m.winner) cascadeClear_(p.division_id, m.code);
  patchRow_('Matches', m._row, {
    winner: p.winner, red_points: redPts, white_points: whitePts,
    outcome: outcome, updated_at: now_(), updated_by: p.by || ''
  });
  resolveDivision_(p.division_id);
  return { match_id: p.match_id, saved: true };
}
function actUndoResult_(p) {
  const m = findMatch_(p.division_id, p.match_id);
  if (!m) throw new Error('Match not found: ' + p.match_id);
  cascadeClear_(p.division_id, m.code);
  patchRow_('Matches', m._row, { winner: '', red_points: '', white_points: '', outcome: '', updated_at: now_(), updated_by: p.by || '' });
  return { match_id: p.match_id, undone: true };
}
function normPoints_(s) {
  if (!s) return '';
  const arr = String(s).split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(function (x) { return x; });
  arr.forEach(function (x) { if (VALID_POINTS.indexOf(x) < 0) throw new Error('Invalid symbol: ' + x + ' (M/K/D/T/H only)'); });
  if (arr.length > 2) throw new Error('Max 2 points');
  return arr.join(',');
}
function findMatch_(divId, matchId) {
  return readAll_('Matches').filter(function (m) { return m.division_id === divId && m.match_id === matchId; })[0];
}

// ============================================================
// Bracket generation
// ============================================================
function nextPow2_(n) { let s = 1; while (s < n) s *= 2; return s; }
function seedPositions_(size) {
  let r = [1];
  while (r.length < size) {
    const m = r.length * 2 + 1; const next = [];
    r.forEach(function (s) { next.push(s); next.push(m - s); });
    r = next;
  }
  return r;
}
function codeForRound_(playersInRound, idx) {
  if (playersInRound === 2) return 'F';
  if (playersInRound === 4) return 'SF' + idx;
  if (playersInRound === 8) return 'QF' + idx;
  return 'R' + playersInRound + '-' + idx;
}
function newMatch_(divId, seq, code, phase, round, red, white) {
  return {
    match_id: 'M-' + String(seq).padStart(4, '0'),
    division_id: divId, code: code, phase: phase, round: round, court: '',
    red_source: red, white_source: white, red_entry_id: '', white_entry_id: '',
    winner: '', red_points: '', white_points: '', outcome: '', updated_at: '', updated_by: ''
  };
}
function genSingleElim_(divId, size, thirdPlace, courts) {
  const rows = []; let seq = 1; let round = 1;
  let matches = size / 2; let codes = [];
  for (let i = 1; i <= matches; i++) {
    const code = codeForRound_(size, i);
    // mark round-1 as 'elim1' so court split + link editor treat it uniformly
    rows.push(newMatch_(divId, seq++, code, 'elim1', round, 'slot:' + (2 * i - 1), 'slot:' + (2 * i)));
    codes.push(code);
  }
  let prevCodes = [];
  while (matches > 1) {
    round++; prevCodes = codes; codes = []; matches = matches / 2;
    for (let i = 1; i <= matches; i++) {
      const code = codeForRound_(matches * 2, i);
      rows.push(newMatch_(divId, seq++, code, 'elim', round, 'match:' + prevCodes[2 * i - 2] + ':W', 'match:' + prevCodes[2 * i - 1] + ':W'));
      codes.push(code);
    }
  }
  assignCourts_(rows, size, courts);
  if (thirdPlace && size >= 4) rows.push(newMatch_(divId, seq++, '3RD', 'elim', round, 'match:SF1:L', 'match:SF2:L'));
  rows.forEach(function (r) { appendRow_('Matches', r); });
}
/**
 * Placement bracket (v0.3, standard-seed method).
 * Placement winners A_1..A_G = seeds 1..G (strong)
 * Placement losers  B_1..B_G = seeds G+1..2G (weak)
 * Extra seeds (2G+1..S) = BYE, land on top A seeds -> some A get a round-2 bye.
 * Every elim slot links to 'match:P{g}:W' or ':L' (editable via set_links).
 * @param courts number of courts (>=1); round-1..semi split across courts, final merges.
 */
function genPlacementBracket_(divId, G, courts) {
  const rows = []; let seq = 1;
  // Placement round
  for (let g = 1; g <= G; g++) rows.push(newMatch_(divId, seq++, 'P' + g, 'placement', 1, 'slot:' + (2 * g - 1), 'slot:' + (2 * g)));
  // Elimination bracket by standard seed table
  const N = 2 * G;
  const S = nextPow2_(N);
  const seeds = seedPositions_(S);          // seeds[pos-1] = seed number at that vertical position
  function seedLink(seed) {
    if (seed > N) return 'BYE';
    if (seed <= G) return 'match:P' + seed + ':W';         // A_seed = winner of P{seed}
    return 'match:P' + (seed - G) + ':L';                  // B_(seed-G) = loser of P{seed-G}
  }
  // Round 1 (elim1) with links
  let round = 1; let matches = S / 2; let codes = [];
  for (let i = 1; i <= matches; i++) {
    const code = codeForRound_(S, i);
    rows.push(newMatch_(divId, seq++, code, 'elim1', round, seedLink(seeds[2 * i - 2]), seedLink(seeds[2 * i - 1])));
    codes.push(code);
  }
  // Upper rounds
  let prevCodes;
  while (matches > 1) {
    round++; prevCodes = codes; codes = []; matches = matches / 2;
    for (let i = 1; i <= matches; i++) {
      const code = codeForRound_(matches * 2, i);
      rows.push(newMatch_(divId, seq++, code, 'elim', round, 'match:' + prevCodes[2 * i - 2] + ':W', 'match:' + prevCodes[2 * i - 1] + ':W'));
      codes.push(code);
    }
  }
  assignCourts_(rows, S, courts);
  rows.forEach(function (r) { appendRow_('Matches', r); });
}

/**
 * Assign courts to elim matches. Round-1 blocks are split into `courts` contiguous
 * groups; each match keeps the court of its block until the merge round (final).
 * The final (and any round where blocks converge) is left blank (central).
 */
function assignCourts_(rows, S, courts) {
  courts = Math.max(1, parseInt(courts, 10) || 1);
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const r1 = rows.filter(function (m) { return m.phase === 'elim1'; });
  if (!r1.length || courts < 2) return;
  const per = Math.ceil(r1.length / courts);   // round up; remainder on leading courts
  // map round-1 code -> court
  const courtOf = {};
  r1.forEach(function (m, idx) {
    const c = Math.min(courts - 1, Math.floor(idx / per));
    m.court = letters[c]; courtOf[m.code] = letters[c];
  });
  // propagate court up: a match inherits court if all its feeders share one court
  const byCode = {}; rows.forEach(function (m) { byCode[m.code] = m; });
  const upper = rows.filter(function (m) { return m.phase === 'elim'; }).sort(function (a, b) { return a.round - b.round; });
  upper.forEach(function (m) {
    const fc = [m.red_source, m.white_source].map(function (s) {
      const mm = String(s).match(/^match:([^:]+):/); return mm ? courtOf[mm[1]] : null;
    });
    if (fc[0] && fc[0] === fc[1]) { m.court = fc[0]; courtOf[m.code] = fc[0]; }
    else { m.court = ''; courtOf[m.code] = ''; }   // merge point -> central
  });
}

// ============================================================
// Progression resolution
// ============================================================
function resolveDivision_(divId) {
  const entryBySlot = {};
  readAll_('Entries').forEach(function (e) { if (e.division_id === divId && e.status !== 'withdrawn') entryBySlot[String(e.slot)] = e; });
  const all = readAll_('Matches').filter(function (m) { return m.division_id === divId; });
  const byCode = {}; all.forEach(function (m) { byCode[m.code] = m; });
  function resolveSource(src) {
    if (!src) return null;
    if (src === 'BYE') return 'BYE';
    let m = String(src).match(/^slot:(\d+)$/);
    if (m) { const e = entryBySlot[m[1]]; if (!e) return null; return e.player_id === 'BYE' ? 'BYE' : e.entry_id; }
    m = String(src).match(/^match:([^:]+):(W|L)$/);
    if (m) {
      const sm = byCode[m[1]]; if (!sm || !sm.winner) return null;
      const win = sm.winner === 'R' ? sm.red_entry_id : sm.white_entry_id;
      const lose = sm.winner === 'R' ? sm.white_entry_id : sm.red_entry_id;
      return m[2] === 'W' ? win : lose;
    }
    return null;
  }
  let changed = true, guard = 0;
  while (changed && guard++ < 40) {
    changed = false;
    all.forEach(function (mt) {
      const patch = {};
      if (!mt.red_entry_id) { const r = resolveSource(mt.red_source); if (r) { patch.red_entry_id = r; mt.red_entry_id = r; } }
      if (!mt.white_entry_id) { const w = resolveSource(mt.white_source); if (w) { patch.white_entry_id = w; mt.white_entry_id = w; } }
      if (!mt.winner && mt.red_entry_id && mt.white_entry_id && (mt.red_entry_id === 'BYE' || mt.white_entry_id === 'BYE')) {
        const win = mt.red_entry_id === 'BYE' ? 'W' : 'R';
        const w2 = (mt.red_entry_id === 'BYE' && mt.white_entry_id === 'BYE') ? 'R' : win;
        patch.winner = w2; patch.outcome = 'bye'; patch.updated_at = now_();
        mt.winner = w2; mt.outcome = 'bye';
      }
      if (Object.keys(patch).length) { patchRow_('Matches', mt._row, patch); changed = true; }
    });
  }
}
function cascadeClear_(divId, code) {
  const all = readAll_('Matches').filter(function (m) { return m.division_id === divId; });
  const ref = 'match:' + code + ':';
  all.forEach(function (mt) {
    let touched = false; const patch = {};
    if (String(mt.red_source).indexOf(ref) === 0) { patch.red_entry_id = ''; touched = true; }
    if (String(mt.white_source).indexOf(ref) === 0) { patch.white_entry_id = ''; touched = true; }
    if (touched) {
      if (mt.winner) {
        patch.winner = ''; patch.red_points = ''; patch.white_points = ''; patch.outcome = '';
        patchRow_('Matches', mt._row, patch);
        cascadeClear_(divId, mt.code);
      } else {
        patchRow_('Matches', mt._row, patch);
      }
    }
  });
}
