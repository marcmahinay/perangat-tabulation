// The tabulating team's screen: type a judge's paper scoresheet into the system,
// by hand or from a photo, then check and save it.

import { h, clear, fmt, plain, localTime } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { confirmDialog, toast } from '/shared/ui.js';

const TOKEN_KEY = 'perangat.encoder.token';
const POLL_MS = 2000;
// Long enough edge to read handwriting, small enough to send over Wi-Fi quickly.
const PHOTO_EDGE = 2400;

const root = document.getElementById('app');

let token = readToken();
let setup = null;        // GET /api/encode/setup
let sheet = null;        // GET /api/encode/sheet, the sheet on screen
let pick = { categoryId: null, judgeId: null };
let scan = null;         // { photoUrl, warnings, notes, heading, filled } from the last photo
let view = null;         // element references for the grid on screen
const rowsInputs = [];   // the grid's inputs by row, for moving down a column with Enter
let pollTimer = null;

const keyOf = (contestantId, criterionId) => `${contestantId}:${criterionId}`;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const judgeLabel = (judge) => (judge.name === `Judge ${judge.judge_no}` ? judge.name : `Judge ${judge.judge_no} — ${judge.name}`);

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
    // Private browsing: pairing lasts until the tab is closed.
  }
}

async function api(method, path, body) {
  try {
    return await request(method, `/api/encode${path}`, body, token);
  } catch (error) {
    if (error.status === 401) showPairing(error.message);
    else if (error.status === 403) showWaiting();
    throw error;
  }
}

function parseScore(text, max) {
  const value = text.trim().replace(',', '.');
  if (value === '') return { value: null };
  if (!/^\d{1,3}(\.\d{0,2})?$/.test(value)) return { error: 'Enter a number such as 32.5' };
  const number = Number(value);
  if (number > max) return { error: `The maximum is ${plain(max)}` };
  return { value: number };
}

function card(...children) {
  return h('div', { class: 'center-screen' }, h('div', { class: 'card pair-card' },
    h('img', { class: 'pair-logo', src: '/shared/logos/anniversary-97.png', alt: '97th Provincial Anniversary' }),
    children));
}

// ---- Pairing ----------------------------------------------------------------

function showPairing(notice) {
  clearTimeout(pollTimer);
  storeToken(null);
  setup = null;
  sheet = null;
  const name = h('input', { type: 'text', autocomplete: 'name', required: true });
  const code = h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', required: true });
  const error = h('p', { class: 'form-error', hidden: !notice }, notice || '');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Ask to pair this device');

  clear(root).append(card(h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        const pairing = await request('POST', '/api/encode/pair', { name: name.value, accessCode: code.value });
        storeToken(pairing.token);
        showWaiting();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        submit.disabled = false;
      }
    },
  },
    h('h1', null, 'Encoder'),
    h('p', { class: 'subtitle' }, 'For the tabulating team, to enter the judges\' paper scoresheets.'),
    error,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Your name'), name),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Encoder access code'),
      code,
      h('span', { class: 'field-hint' }, 'The tabulator gives this to the tabulating team. It is not a judge\'s code.'),
    ),
    submit,
  )));
}

async function showWaiting() {
  clearTimeout(pollTimer);
  let status;
  try {
    status = await request('GET', '/api/encode/status', undefined, token);
  } catch (error) {
    if (error.status === 401) showPairing('The tabulator turned this device down, or the request expired. Ask again.');
    else pollTimer = setTimeout(showWaiting, POLL_MS);
    return;
  }
  if (status.status === 'paired') {
    start();
    return;
  }
  clear(root).append(card(
    h('h1', null, 'Waiting for approval'),
    h('p', { class: 'subtitle' }, `Show this pairing code to the tabulator. They approve ${status.name}'s device on the tabulation computer, under Encoding.`),
    h('p', { class: 'pairing-code' }, status.pairingCode),
    h('p', { class: 'muted center' }, 'This page carries on by itself once you are approved.'),
    h('button', { class: 'btn', type: 'button', onclick: unpair }, 'Cancel'),
  ));
  pollTimer = setTimeout(showWaiting, POLL_MS);
}

async function unpair() {
  if (view && changedCells().length) {
    const leave = await confirmDialog({
      title: 'Unsaved changes',
      message: 'Scores typed on this sheet have not been saved and will be lost.',
      confirmLabel: 'Unpair anyway',
      danger: true,
    });
    if (!leave) return;
  }
  await request('POST', '/api/encode/unpair', {}, token).catch(() => {});
  showPairing();
}

// ---- The sheet --------------------------------------------------------------

function judgesFor(categoryId) {
  const category = setup.categories.find((entry) => entry.id === categoryId);
  return category ? setup.judges.filter((judge) => category.judgeIds.includes(judge.id)) : [];
}

async function loadSheet() {
  scan = null;
  sheet = null;
  render();
  if (!pick.categoryId || !pick.judgeId) return;
  try {
    sheet = (await api('GET', `/sheet?categoryId=${pick.categoryId}&judgeId=${pick.judgeId}`)).sheet;
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) toast(error.message, 'error');
    // The judge may have been unassigned from this device: start again from the current assignment.
    if (error.status === 409) {
      pick = { categoryId: null, judgeId: null };
      start();
      return;
    }
  }
  render();
}

/** Cells whose text differs from what the server holds, as the API expects them. Invalid cells are left out. */
function changedCells() {
  if (!view) return [];
  const out = [];
  for (const cell of view.cells.values()) {
    const parsed = parseScore(cell.input.value, cell.criterion.weight);
    if (parsed.error) continue;
    if (parsed.value !== cell.saved) out.push({ contestantId: cell.contestantId, criterionId: cell.criterion.id, score: parsed.value });
  }
  return out;
}

function refreshGrid() {
  if (!view) return;
  let invalid = 0;
  for (const cell of view.cells.values()) {
    const parsed = parseScore(cell.input.value, cell.criterion.weight);
    cell.input.classList.toggle('invalid', Boolean(parsed.error));
    cell.input.classList.toggle('unsaved', !parsed.error && parsed.value !== cell.saved);
    cell.input.title = parsed.error || cell.problem || '';
    if (parsed.error) invalid += 1;
  }
  for (const [contestantId, total] of view.totals) {
    const values = [...view.cells.values()]
      .filter((cell) => cell.contestantId === contestantId)
      .map((cell) => parseScore(cell.input.value, cell.criterion.weight).value)
      .filter((value) => value != null);
    total.textContent = values.length ? fmt(round2(values.reduce((sum, value) => sum + value, 0))) : '–';
  }
  const changed = changedCells().length;
  view.save.disabled = changed === 0 || invalid > 0;
  view.save.textContent = changed ? `Save ${changed} change${changed === 1 ? '' : 's'}` : 'Saved';
  view.status.textContent = invalid ? `${invalid} cell${invalid === 1 ? ' is' : 's are'} not a valid score` : '';
}

async function save() {
  const cells = changedCells();
  if (!cells.length) return;
  view.save.disabled = true;
  try {
    const result = await api('PUT', '/sheet', { categoryId: pick.categoryId, judgeId: pick.judgeId, cells });
    sheet = result.sheet;
    scan = scan && { ...scan, saved: true };
    render();
    toast(`${cells.length} score${cells.length === 1 ? '' : 's'} saved.`, 'ok');
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) toast(error.message, 'error');
    refreshGrid();
  }
}

async function submitSheet() {
  if (changedCells().length) {
    toast('Save your changes first.', 'error');
    return;
  }
  const confirmed = await confirmDialog({
    title: `Submit ${judgeLabel(sheet.judge)}'s ${sheet.category.name} scoresheet?`,
    message: [
      'Do this only when every score matches the judge\'s signed paper sheet.',
      'The scoresheet is then locked as final. The tabulator can reopen it if a correction is needed.',
    ],
    confirmLabel: 'Submit scoresheet',
  });
  if (!confirmed) return;
  try {
    sheet = (await api('POST', '/sheet/submit', { categoryId: pick.categoryId, judgeId: pick.judgeId })).sheet;
    render();
    toast('Scoresheet submitted.', 'ok');
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) toast(error.message, 'error');
  }
}

/** Shrinks a phone photo before sending it, and returns it as a data URL. */
async function photoDataUrl(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { url, data: canvas.toDataURL('image/jpeg', 0.85) };
}

async function scanPhoto(file) {
  if (!file) return;
  let photo;
  try {
    photo = await photoDataUrl(file);
  } catch {
    toast('That file could not be opened as a photo.', 'error');
    return;
  }
  scan = { photoUrl: photo.url, reading: true };
  render();
  try {
    const result = await api('POST', '/scan', { categoryId: pick.categoryId, judgeId: pick.judgeId, image: photo.data });
    // Fill the grid with what was read. Cells the photo could not give a value for keep what was there.
    let filled = 0;
    for (const proposal of result.cells) {
      const cell = view && view.cells.get(keyOf(proposal.contestantId, proposal.criterionId));
      if (!cell) continue;
      cell.problem = proposal.problem;
      cell.input.classList.toggle('flagged', Boolean(proposal.problem));
      if (proposal.value != null) {
        cell.input.value = plain(proposal.value);
        cell.input.classList.add('proposed');
        filled += 1;
      }
    }
    scan = { photoUrl: photo.url, warnings: result.warnings, notes: result.notes, heading: result.heading, filled };
    renderScan();
    refreshGrid();
  } catch (error) {
    scan = { photoUrl: photo.url, failed: error.message };
    renderScan();
  }
}

function renderScan() {
  if (!view) return;
  if (!scan) {
    clear(view.scan);
    return;
  }
  const flagged = view ? [...view.cells.values()].filter((cell) => cell.problem).length : 0;
  clear(view.scan).append(
    h('a', { href: scan.photoUrl, target: '_blank', class: 'photo' }, h('img', { src: scan.photoUrl, alt: 'Photo of the paper sheet' })),
    h('div', { class: 'scan-text' },
      scan.reading && h('p', { class: 'strong' }, 'Reading the photo… this can take up to a minute.'),
      scan.failed && h('p', { class: 'form-error' }, scan.failed),
      scan.saved && h('p', { class: 'strong' }, "The checked scores were saved. Keep the paper sheet with the judge's signature."),
      !scan.saved && scan.filled != null && [
        h('p', { class: 'strong' }, `${scan.filled} score${scan.filled === 1 ? '' : 's'} filled in from the photo.`),
        h('p', null, 'Nothing is saved yet. Check every number against the paper sheet, correct any that are wrong, then press Save.'),
        flagged > 0 && h('p', { class: 'flag-note' }, `${flagged} cell${flagged === 1 ? ' is' : 's are'} outlined in red: tap one to see why.`),
        scan.heading && h('p', { class: 'muted' }, `Heading on the sheet: ${scan.heading}`),
        scan.warnings.length > 0 && h('ul', { class: 'warnings' }, scan.warnings.map((warning) => h('li', null, warning))),
        scan.notes && h('p', { class: 'muted' }, `Note from the reader: ${scan.notes}`),
      ],
      h('p', { class: 'muted' }, 'Tap the photo to see it full size.'),
    ),
  );
}

function sheetPanel() {
  const locked = sheet.status === 'submitted';
  view = { cells: new Map(), totals: new Map(), scan: h('div', { class: 'scan' }), save: null, status: h('span', { class: 'grid-status' }) };

  view.save = h('button', { class: 'btn primary', type: 'button', onclick: save, disabled: true }, 'Saved');
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onchange: () => {
      scanPhoto(fileInput.files[0]);
      fileInput.value = '';
    },
  });

  const head = h('tr', null,
    h('th', null, 'No'),
    h('th', { class: 'name' }, 'Contingent'),
    sheet.criteria.map((criterion) => h('th', null, criterion.name, h('small', null, `max ${plain(criterion.weight)}`))),
    h('th', null, 'Total', h('small', null, `of ${plain(sheet.maxScore)}`)),
  );

  const rows = sheet.rows.map((row, rowIndex) => {
    const inputs = sheet.criteria.map((criterion, columnIndex) => {
      const saved = row.scores[criterion.id] == null ? null : row.scores[criterion.id];
      const input = h('input', {
        class: 'score-input',
        type: 'text',
        inputMode: 'decimal',
        autocomplete: 'off',
        disabled: locked,
        value: plain(saved),
        'aria-label': `${criterion.name} for ${row.contestant.name}, maximum ${plain(criterion.weight)}`,
        oninput: () => {
          input.classList.remove('proposed');
          refreshGrid();
        },
        onfocus: () => {
          input.select();
          const cell = view.cells.get(keyOf(row.contestant.id, criterion.id));
          if (cell.problem) toast(cell.problem);
        },
        onkeydown: (event) => {
          const step = { Enter: 1, ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          const target = rowsInputs[rowIndex + step] && rowsInputs[rowIndex + step][columnIndex];
          if (target) target.focus();
        },
      });
      view.cells.set(keyOf(row.contestant.id, criterion.id), { input, criterion, contestantId: row.contestant.id, saved, problem: null });
      return input;
    });
    rowsInputs.push(inputs);
    const total = h('td', { class: 'computed' });
    view.totals.set(row.contestant.id, total);
    return h('tr', null,
      h('td', { class: 'no' }, row.contestant.contestant_no),
      h('td', { class: 'name' }, row.contestant.name),
      inputs.map((input) => h('td', { class: 'cell' }, input)),
      total,
    );
  });

  return h('section', { class: 'card sheet' },
    h('div', { class: 'sheet-head' },
      h('div', null,
        h('h2', null, `${judgeLabel(sheet.judge)} · ${sheet.category.name}`),
        h('p', { class: 'muted' }, locked
          ? `Submitted ${localTime(sheet.submitted_at)}. Locked; the tabulator can reopen it.`
          : 'Type the scores from the paper sheet, or scan a photo of it. Nothing is saved until you press Save.'),
        sheet.encodedBy.length > 0 && h('p', { class: 'muted' }, `Encoded by ${sheet.encodedBy.join(', ')}.`),
      ),
      h('span', { class: `badge ${locked ? 'ok' : 'warn'}` }, locked ? 'SUBMITTED' : 'DRAFT'),
    ),
    !locked && h('div', { class: 'actions' },
      h('button', { class: 'btn scan-button', type: 'button', onclick: () => fileInput.click() }, 'Scan paper sheet'),
      fileInput,
      view.save,
      h('button', { class: 'btn', type: 'button', onclick: submitSheet }, 'Submit scoresheet'),
      view.status,
    ),
    view.scan,
    sheet.rows.length && sheet.criteria.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'scores' }, h('thead', null, head), h('tbody', null, rows)))
      : h('p', { class: 'empty' }, 'Nothing to score in this category yet.'),
  );
}

function render() {
  rowsInputs.length = 0;
  view = null;
  document.title = `Encoder · ${setup.event.name}`;

  const categorySelect = h('select', {
    onchange: async () => {
      if (!(await leaveSheet())) {
        categorySelect.value = pick.categoryId || '';
        return;
      }
      pick = { categoryId: Number(categorySelect.value) || null, judgeId: null };
      loadSheet();
    },
  },
    h('option', { value: '' }, 'Choose a category…'),
    setup.categories.map((category) => h('option', { value: category.id }, category.name)));
  categorySelect.value = pick.categoryId || '';

  const judgeSelect = h('select', {
    disabled: !pick.categoryId,
    onchange: async () => {
      if (!(await leaveSheet())) {
        judgeSelect.value = pick.judgeId || '';
        return;
      }
      pick = { ...pick, judgeId: Number(judgeSelect.value) || null };
      loadSheet();
    },
  },
    h('option', { value: '' }, 'Choose a judge…'),
    judgesFor(pick.categoryId).map((judge) => h('option', { value: judge.id }, judgeLabel(judge))));
  judgeSelect.value = pick.judgeId || '';

  clear(root).append(
    h('header', { class: 'topbar' },
      h('img', { class: 'mark', src: '/shared/logos/anniversary-97-mark.png', alt: '97th Provincial Anniversary' }),
      h('span', { class: 'event' }, setup.event.name),
      h('span', { class: 'who' }, `Encoding · ${setup.encoder.name}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onclick: unpair }, 'Unpair'),
    ),
    h('div', { class: 'pickers' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Category'), categorySelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Judge'), judgeSelect),
      pick.judgeId && h('button', { class: 'btn', type: 'button', onclick: async () => { if (await leaveSheet()) loadSheet(); } }, 'Reload'),
    ),
    sheet && sheetPanel(),
    !sheet && setup.judges.length === 0 && h('div', { class: 'empty' },
      h('p', { class: 'strong' }, 'No judges are assigned to you yet.'),
      h('p', null, 'The tabulator assigns the judges whose paper sheets you enter, under Encoding on the tabulation computer.'),
      h('button', { class: 'btn', type: 'button', style: 'margin-top: 12px', onclick: start }, 'Check again'),
    ),
    !sheet && setup.judges.length > 0
      && h('p', { class: 'empty' }, pick.judgeId ? 'Loading…' : 'Choose the category and the judge whose paper sheet you are entering.'),
  );
  renderScan();
  refreshGrid();
}

/** Asks before throwing away typed scores. */
async function leaveSheet() {
  if (!changedCells().length) return true;
  return confirmDialog({
    title: 'Unsaved changes',
    message: 'Scores typed on this sheet have not been saved and will be lost.',
    confirmLabel: 'Discard them',
    danger: true,
  });
}

async function start() {
  if (!token) {
    showPairing();
    return;
  }
  try {
    setup = await api('GET', '/setup');
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      clear(root).append(card(h('h1', null, 'Cannot connect'), h('p', { class: 'subtitle' }, error.message),
        h('button', { class: 'btn primary', onclick: start }, 'Try again')));
    }
    return;
  }
  render();
}

window.addEventListener('beforeunload', (event) => {
  if (changedCells().length) event.preventDefault();
});

start();
