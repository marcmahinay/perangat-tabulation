import { h, clear, fmt, plain, localTime } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { connectLive } from '/shared/live.js';
import { confirmDialog, toast } from '/shared/ui.js';

const TOKEN_KEY = 'perangat.judge.token';
const TYPING_PAUSE_MS = 600;
const RETRY_MS = 3000;

const root = document.getElementById('app');

let token = readToken();
let data = null;        // last response of GET /api/judge/sheets
let activeId = null;    // id of the category on screen
let live = null;
let connected = false;
let view = null;        // element references for the sheet on screen
let frame = {};        // element references for the top bar and tabs

// Score cells are keyed "contestantId:criterionId".
const saved = new Map();    // what the server holds
const pending = new Map();  // typed here, not yet confirmed by the server
const invalid = new Set();  // cells whose text is not a usable score
let pumping = false;
let saveFailed = false;
let pumpTimer = null;
let restoringFocus = false;

const keyOf = (contestantId, criterionId) => `${contestantId}:${criterionId}`;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const judgeLabel = (judge) => (judge.name === `Judge ${judge.judge_no}` ? judge.name : `Judge ${judge.judge_no} — ${judge.name}`);
const activeSheet = () => data.sheets.find((sheet) => sheet.category.id === activeId) || null;

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing: the session simply lasts until the tab is closed.
  }
}

/** The value a cell currently counts as: unsaved typing wins over the server's copy. */
function valueOf(key) {
  if (invalid.has(key)) return null;
  if (pending.has(key)) return pending.get(key);
  const value = saved.get(key);
  return value == null ? null : value;
}

function parseScore(text, max) {
  const value = text.trim().replace(',', '.');
  if (value === '') return { value: null };
  if (!/^\d{1,3}(\.\d{0,2})?$/.test(value)) return { error: 'Enter a number such as 32.5' };
  const number = Number(value);
  if (number > max) return { error: `The maximum is ${plain(max)}` };
  return { value: number };
}

async function api(method, path, body) {
  try {
    return await request(method, `/api/judge${path}`, body, token);
  } catch (error) {
    if (error.status === 401) endSession('Please sign in again.');
    throw error;
  }
}

// ---- Sign-in ----------------------------------------------------------------

function endSession(notice) {
  storeToken(null);
  if (live) live.close();
  live = null;
  data = null;
  view = null;
  frame = {};
  clearTimeout(pumpTimer);
  saved.clear();
  pending.clear();
  invalid.clear();
  showLogin(notice);
}

function messageScreen(message, onRetry) {
  clear(root).append(
    h('div', { class: 'login' },
      h('div', { class: 'card login-card' },
        h('h1', null, 'Cannot connect'),
        h('p', { class: 'subtitle' }, message),
        h('button', { class: 'btn primary', onclick: onRetry }, 'Try again'),
      ),
    ),
  );
}

async function showLogin(notice) {
  let info;
  try {
    info = await request('GET', '/api/public/info');
  } catch (error) {
    messageScreen(error.message, () => showLogin(notice));
    return;
  }

  document.title = `Judge sign-in · ${info.eventName}`;
  const judge = h('select', { required: true },
    h('option', { value: '' }, 'Select your name…'),
    info.judges.map((entry) => h('option', { value: entry.id }, judgeLabel(entry))),
  );
  const code = h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', required: true });
  const error = h('p', { class: 'form-error', hidden: !notice }, notice || '');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        const login = await request('POST', '/api/judge/login', { judgeId: Number(judge.value), accessCode: code.value });
        storeToken(login.token);
        await start();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        submit.disabled = false;
        code.select();
      }
    },
  },
    h('img', { class: 'login-logo', src: '/shared/logos/anniversary-97.png', alt: '97th Provincial Anniversary' }),
    h('h1', null, info.eventName),
    h('p', { class: 'subtitle' }, 'Judge scoresheet'),
    error,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Judge'), judge),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Access code'),
      code,
      h('span', { class: 'field-hint' }, 'The tabulator will give you your code.'),
    ),
    submit,
  );

  clear(root).append(h('div', { class: 'login' }, h('div', { class: 'card login-card' }, form)));
}

// ---- Data -------------------------------------------------------------------

/** Changes when anything about the layout of the sheets changes, as opposed to just scores. */
function signature(source) {
  return JSON.stringify([
    source.event,
    source.judge,
    source.sheets.map((sheet) => [
      sheet.category,
      sheet.status,
      sheet.criteria,
      sheet.rows.map((row) => [row.contestant, row.deductions]),
    ]),
  ]);
}

function rememberSaved(sheet) {
  for (const row of sheet.rows) {
    for (const criterion of sheet.criteria) {
      const value = row.scores[criterion.id];
      saved.set(keyOf(row.contestant.id, criterion.id), value == null ? null : value);
    }
  }
}

function applyData(next, { rebuild = false } = {}) {
  const changed = rebuild || !data || signature(next) !== signature(data);
  data = next;

  saved.clear();
  data.sheets.forEach(rememberSaved);
  // Drop unsaved typing for cells that no longer exist (a criterion or contingent was removed).
  for (const key of [...pending.keys()]) if (!saved.has(key)) pending.delete(key);

  if (!activeSheet()) activeId = data.sheets.length ? data.sheets[0].category.id : null;
  if (changed) render();
  else refresh();
}

function replaceSheet(sheet) {
  data.sheets = data.sheets.map((existing) => (existing.category.id === sheet.category.id ? sheet : existing));
  rememberSaved(sheet);
}

async function loadSheets(options) {
  applyData(await api('GET', '/sheets'), options);
}

// ---- Saving -----------------------------------------------------------------

function schedulePump(delay) {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pump, delay);
}

/** Sends unsaved cells one at a time, oldest first, retrying while the network is down. */
async function pump() {
  if (pumping) return;
  pumping = true;
  while (pending.size) {
    const [key, value] = pending.entries().next().value;
    const [contestantId, criterionId] = key.split(':').map(Number);
    try {
      const { sheet } = await api('PUT', '/scores', { contestantId, criterionId, score: value });
      // Only settle the cell if the judge has not typed something newer meanwhile.
      if (pending.get(key) === value) pending.delete(key);
      saveFailed = false;
      replaceSheet(sheet);
    } catch (error) {
      if (error.status === 401) break;
      if (error.network || error.status >= 500) {
        saveFailed = true;
        refresh();
        await sleep(RETRY_MS);
        continue;
      }
      // The server refused the score (sheet locked, criterion removed...): drop it and resync.
      pending.delete(key);
      toast(error.message, 'error');
      await loadSheets({ rebuild: true }).catch(() => {});
    }
    refresh();
  }
  pumping = false;
  refresh();
}

function onType(key, input, max, commit) {
  const parsed = parseScore(input.value, max);
  input.classList.toggle('invalid', Boolean(parsed.error));
  input.title = parsed.error || '';

  if (parsed.error) {
    invalid.add(key);
    pending.delete(key);
  } else {
    invalid.delete(key);
    if (pending.has(key) || parsed.value !== saved.get(key)) pending.set(key, parsed.value);
  }
  refresh();
  if (pending.size) schedulePump(commit ? 0 : TYPING_PAUSE_MS);
}

// ---- Rendering --------------------------------------------------------------

function sheetProgress(sheet) {
  const done = sheet.rows.filter((row) =>
    sheet.criteria.length > 0 && sheet.criteria.every((criterion) => valueOf(keyOf(row.contestant.id, criterion.id)) != null),
  ).length;
  return { done, total: sheet.rows.length };
}

function topbar() {
  frame.statusDot = h('span', { class: 'dot' });
  frame.statusText = h('span');
  frame.status = h('span', { class: 'save-status' }, frame.statusDot, frame.statusText);
  return h('header', { class: 'topbar' },
    h('img', { class: 'mark', src: '/shared/logos/anniversary-97-mark.png', alt: '97th Provincial Anniversary' }),
    h('span', { class: 'event' }, data.event.name),
    h('span', { class: 'who' }, judgeLabel(data.judge)),
    h('span', { class: 'spacer' }),
    frame.status,
    h('button', { class: 'btn small', onclick: signOut }, 'Sign out'),
  );
}

function tabs() {
  frame.tabs = new Map();
  return h('nav', { class: 'tabs' }, data.sheets.map((sheet) => {
    const badge = h('span', { class: 'badge' });
    frame.tabs.set(sheet.category.id, badge);
    return h('button', {
      class: `tab ${sheet.category.id === activeId ? 'active' : ''}`,
      onclick: () => {
        activeId = sheet.category.id;
        render();
      },
    }, sheet.category.name, badge);
  }));
}

function sheetPanel(sheet) {
  const locked = sheet.status === 'submitted';
  const showDeductions = Boolean(sheet.category.apply_deductions);
  view = { inputs: new Map(), grid: [], rows: new Map(), progress: h('span', { class: 'progress' }), submit: null };

  const head = h('tr', null,
    h('th', null, 'No'),
    h('th', { class: 'name' }, 'Contingent'),
    sheet.criteria.map((criterion) => h('th', null, criterion.name, h('small', null, `max ${plain(criterion.weight)}`))),
    h('th', null, showDeductions ? 'Total score' : 'Total', h('small', null, `of ${plain(sheet.maxScore)}`)),
    showDeductions && h('th', null, 'Deduction'),
    showDeductions && h('th', null, 'Final score'),
    h('th', null, 'Rank'),
  );

  const body = sheet.rows.map((row, rowIndex) => {
    const inputs = sheet.criteria.map((criterion, columnIndex) => {
      const key = keyOf(row.contestant.id, criterion.id);
      const input = h('input', {
        class: 'score-input',
        type: 'text',
        inputMode: 'decimal',
        autocomplete: 'off',
        disabled: locked,
        'aria-label': `${criterion.name} for ${row.contestant.name}, maximum ${plain(criterion.weight)}`,
        oninput: () => onType(key, input, criterion.weight, false),
        onchange: () => onType(key, input, criterion.weight, true),
        onfocus: () => {
          if (!restoringFocus) input.select();
        },
        onkeydown: (event) => {
          const step = { Enter: 1, ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          const target = view.grid[rowIndex + step] && view.grid[rowIndex + step][columnIndex];
          if (target) target.focus();
        },
      });
      input.value = plain(valueOf(key));
      view.inputs.set(key, input);
      return input;
    });
    view.grid.push(inputs);

    const refs = {
      tr: null,
      total: h('td', { class: 'computed' }),
      deduction: showDeductions ? h('td', { class: 'computed' }) : null,
      final: showDeductions ? h('td', { class: 'computed' }) : null,
      rank: h('td', { class: 'rank' }),
    };
    refs.tr = h('tr', null,
      h('td', { class: 'no' }, row.contestant.contestant_no),
      h('td', { class: 'name' },
        row.contestant.name,
        showDeductions && row.deductions.map((deduction) =>
          h('span', { class: 'deduction-note' }, `−${plain(deduction.points)} ${deduction.name}`)),
      ),
      inputs.map((input) => h('td', { class: 'cell' }, input)),
      refs.total,
      refs.deduction,
      refs.final,
      refs.rank,
    );
    view.rows.set(row.contestant.id, refs);
    return refs.tr;
  });

  if (!locked) {
    view.submit = h('button', { class: 'btn primary', onclick: () => submitSheet(sheet) }, 'Submit final scores');
  }

  return h('section', { class: 'card sheet' },
    h('div', { class: 'sheet-head' },
      h('h2', null, sheet.category.name),
      locked
        ? h('p', null, `Submitted ${localTime(sheet.submitted_at)}. This scoresheet is locked; ask the tabulator if a correction is needed.`)
        : h('p', null, 'Scores save automatically as you type. Give points up to the maximum shown under each criterion.'),
      h('span', { class: `badge ${locked ? 'ok' : 'warn'}` }, locked ? 'SUBMITTED' : 'DRAFT'),
    ),
    sheet.rows.length && sheet.criteria.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'scores' }, h('thead', null, head), h('tbody', null, body)))
      : h('p', { class: 'empty' }, 'Nothing to score here yet. The tabulator is still setting up this category.'),
    h('div', { class: 'sheet-foot' }, view.progress, view.submit),
    h('details', { class: 'guide' },
      h('summary', null, 'Criteria guide'),
      h('dl', null, sheet.criteria.map((criterion) => [
        h('dt', null, `${criterion.name} — ${plain(criterion.weight)}%`),
        h('dd', null, criterion.description),
      ])),
    ),
  );
}

function render() {
  document.title = `${judgeLabel(data.judge)} · ${data.event.name}`;
  // A rebuild can be triggered by the tabulator while the judge is mid-entry, so keep their place.
  const focused = view && [...view.inputs].find(([, input]) => input === document.activeElement);
  invalid.clear();
  view = null;
  const sheet = activeSheet();
  clear(root).append(
    topbar(),
    ...(sheet
      ? [tabs(), sheetPanel(sheet)]
      : [h('p', { class: 'empty' }, 'You have not been assigned to a category yet. Please wait for the tabulator.')]),
  );
  refresh();

  const input = focused && view && view.inputs.get(focused[0]);
  if (input && !input.disabled) {
    restoringFocus = true;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    restoringFocus = false;
  }
}

/** Updates everything derived from the scores without touching what the judge is typing. */
function refresh() {
  if (!data || !frame.status) return;

  const stuck = saveFailed || (!connected && pending.size > 0);
  frame.status.classList.toggle('problem', stuck);
  frame.statusDot.className = `dot ${connected && !stuck ? 'on' : 'off'}`;
  if (stuck) frame.statusText.textContent = `${pending.size} score${pending.size === 1 ? '' : 's'} not saved — retrying…`;
  else if (pending.size) frame.statusText.textContent = 'Saving…';
  else if (!connected) frame.statusText.textContent = 'Reconnecting…';
  else frame.statusText.textContent = 'All scores saved';

  for (const sheet of data.sheets) {
    const badge = frame.tabs && frame.tabs.get(sheet.category.id);
    if (!badge) continue;
    const { done, total } = sheetProgress(sheet);
    badge.textContent = sheet.status === 'submitted' ? 'Submitted' : `${done}/${total}`;
    badge.className = `badge ${sheet.status === 'submitted' ? 'ok' : ''}`;
  }

  const sheet = activeSheet();
  if (!sheet || !view) return;

  for (const row of sheet.rows) {
    const refs = view.rows.get(row.contestant.id);
    const keys = sheet.criteria.map((criterion) => keyOf(row.contestant.id, criterion.id));
    const values = keys.map(valueOf).filter((value) => value != null);
    const total = round2(values.reduce((sum, value) => sum + value, 0));
    const complete = keys.length > 0 && values.length === keys.length;
    const settled = !keys.some((key) => pending.has(key) || invalid.has(key));

    refs.tr.classList.toggle('complete', complete);
    refs.total.textContent = values.length ? fmt(total) : '–';
    refs.total.classList.toggle('partial', !complete);
    if (refs.deduction) refs.deduction.textContent = row.deduction ? `−${fmt(row.deduction)}` : fmt(0);
    if (refs.final) refs.final.textContent = complete ? fmt(Math.max(0, total - row.deduction)) : '–';
    // The rank comes from the server, so it is only shown once the row is saved.
    refs.rank.textContent = complete && settled && row.rank != null ? row.rank : '–';
  }

  for (const [key, input] of view.inputs) {
    input.classList.toggle('unsaved', pending.has(key));
    if (document.activeElement !== input && !pending.has(key) && !invalid.has(key)) {
      const text = plain(saved.get(key));
      if (input.value !== text) input.value = text;
    }
  }

  const { done, total } = sheetProgress(sheet);
  view.progress.textContent = `${done} of ${total} contingent${total === 1 ? '' : 's'} fully scored`;
  if (view.submit) {
    view.submit.disabled = total === 0 || done < total || pending.size > 0 || invalid.size > 0;
  }
}

// ---- Actions ----------------------------------------------------------------

async function submitSheet(sheet) {
  const confirmed = await confirmDialog({
    title: `Submit ${sheet.category.name}?`,
    message: [
      'Your scores for this category will be sent to the tabulator as final.',
      'After submitting you cannot change them unless the tabulator reopens your scoresheet.',
    ],
    confirmLabel: 'Submit final scores',
  });
  if (!confirmed) return;
  try {
    const { sheet: updated } = await api('POST', `/categories/${sheet.category.id}/submit`, {});
    replaceSheet(updated);
    render();
    toast('Scoresheet submitted.', 'ok');
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'error');
  }
}

async function signOut() {
  if (pending.size > 0) {
    const leave = await confirmDialog({
      title: 'Some scores are not saved yet',
      message: 'If you sign out now, the scores still waiting to be saved will be lost.',
      confirmLabel: 'Sign out anyway',
      danger: true,
    });
    if (!leave) return;
  }
  await request('POST', '/api/judge/logout', {}, token).catch(() => {});
  endSession();
}

function openLive() {
  live = connectLive({
    query: () => `token=${encodeURIComponent(token)}`,
    onStatus(up) {
      connected = up;
      refresh();
      if (!up || !token) return;
      // Catch up on anything missed while offline, then flush what was typed meanwhile.
      loadSheets().catch(() => {});
      if (pending.size) schedulePump(0);
    },
    onEvent(event) {
      // The tabulator ended this session, or this judge signed in somewhere else.
      if (event.type === 'signed_out') {
        endSession(event.message);
        return;
      }
      const mine = event.type === 'sheets' && data && event.judgeId === data.judge.id;
      if (event.type === 'config' || event.type === 'deductions' || mine) loadSheets().catch(() => {});
    },
  });
}

async function start() {
  if (!token) {
    showLogin();
    return;
  }
  try {
    await loadSheets();
    openLive();
  } catch (error) {
    if (error.status !== 401) messageScreen(error.message, start);
  }
}

window.addEventListener('beforeunload', (event) => {
  if (pending.size > 0) event.preventDefault();
});

start();
