import { h, clear, fmt, plain, clock, parseClock, localTime } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { connectLive } from '/shared/live.js';
import { confirmDialog, formDialog, toast } from '/shared/ui.js';
import { tieNotes, tieRemarks, tieGuidelines } from '/shared/ties.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');

const NAV = [
  ['Event', [['monitor', 'Live monitor'], ['results', 'Results'], ['deductions', 'Deductions'], ['encoding', 'Encoding']]],
  ['Setup', [['contingents', 'Contingents'], ['judges', 'Judges'], ['categories', 'Categories & criteria'], ['settings', 'Settings']]],
];

// Views with inline form fields are not redrawn by live events, so typing is never interrupted.
const INLINE_FORM_VIEWS = new Set(['deductions', 'settings']);

const UNIT_LABEL = { flat: 'Once', per_minute: 'Per full minute over', per_started_minute: 'Per started minute over' };
const METHOD_LABEL = { rank_sum: "Sum of judges' ranks", average: 'Average of judge scores' };

const store = {
  state: null,      // GET /api/admin/state   - the setup
  results: null,    // GET /api/admin/results - the computed tabulation
  online: new Set(),
  connected: false,
  view: 'monitor',
  resultsTab: null,
};

const api = (method, path, body) => request(method, `/api/admin${path}`, body);

/** `setup: false` re-reads only the tabulation, which is all a saved score can change. */
async function refresh({ setup = true } = {}) {
  const [state, results] = await Promise.all([setup ? api('GET', '/state') : store.state, api('GET', '/results')]);
  store.state = state;
  store.results = results;
  store.online = new Set(results.onlineJudgeIds);
}

async function reload() {
  await refresh();
  render();
}

/** Runs an admin action, then redraws; failures become a toast. */
async function act(action, successMessage) {
  try {
    await action();
    await reload();
    if (successMessage) toast(successMessage, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openPrint(params) {
  window.open(`/admin/print.html?${new URLSearchParams(params)}`, '_blank');
}

// ---- Small building blocks --------------------------------------------------

const button = (label, onclick, variant = '') => h('button', { class: `btn ${variant}`, type: 'button', onclick }, label);
const field = (label, control, hint) => h('label', { class: 'field' },
  h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));
const empty = (text) => h('p', { class: 'empty' }, text);
const typeById = (id) => store.state.deductionTypes.find((type) => type.id === id);
const judgeName = (judge) => (judge.name === `Judge ${judge.judge_no}` ? '' : judge.name);

function pageHead(title, subtitle, ...actions) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', null, title), h('p', null, subtitle)),
    h('div', { class: 'actions' }, actions),
  );
}

function table(headers, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('thead', null, h('tr', null, headers.map((header) => (header instanceof Node ? header : h('th', null, header))))),
      h('tbody', null, rows),
    ),
  );
}

function categoryBadges(categoryIds) {
  const { categories } = store.state;
  if (categories.length > 0 && categoryIds.length === categories.length) return h('span', { class: 'muted' }, 'All categories');
  if (categoryIds.length === 0) return h('span', { class: 'badge danger' }, 'None');
  return categories.filter((category) => categoryIds.includes(category.id))
    .map((category) => [h('span', { class: 'badge brand' }, category.name), ' ']);
}

const categoryOptions = () => store.state.categories.map((category) => ({ value: category.id, label: category.name }));

function ruleSummary(type) {
  const points = `${plain(type.points)} point${type.points === 1 ? '' : 's'}`;
  const from = "taken from each judge's raw score";
  const limit = clock(type.limit_seconds);
  if (type.unit === 'per_minute') return `${points} per full minute over ${limit}, ${from}.`;
  if (type.unit === 'per_started_minute') return `${points} per started minute over ${limit}, ${from}.`;
  if (limit) return `${points} for any time over ${limit}, ${from}.`;
  return `${points} per violation, ${from}.`;
}

/** Deductions are always taken from each judge's raw score for the contingent. */
function deductionCell(row) {
  const text = row.deduction ? `−${plain(row.deduction)} per judge` : '';
  return h('td', {
    class: text ? 'deducted nowrap' : 'muted',
    title: row.deductions.map((deduction) => `${deduction.name}: −${plain(deduction.points)}`).join('\n'),
  }, text || '–');
}

function judgeHeader(judge, byRankSum) {
  return h('th', { class: 'num', title: judge.name }, `Judge ${judge.judge_no}`, byRankSum && ' · rank');
}

/** One judge's total for one contingent; with sum-of-ranks scoring, also the rank that judge gave. */
function judgeCell(entry, byRankSum, criteriaCount) {
  if (entry.complete) {
    return h('td', { class: 'num' }, fmt(entry.net), byRankSum && h('span', { class: 'judge-rank' }, entry.rank));
  }
  if (entry.filled) return h('td', { class: 'num partial' }, `${entry.filled}/${criteriaCount}`);
  return h('td', { class: 'num muted' }, '·');
}

function statusBadge(result) {
  const vote = result.pendingVotes.length > 0 && h('span', { class: 'badge danger' }, 'TIE · JUDGES TO VOTE');
  if (result.isFinal) return [vote, ' ', h('span', { class: 'badge ok' }, 'FINAL')];
  const submitted = result.judges.filter((judge) => judge.status === 'submitted').length;
  return [vote, ' ', h('span', { class: 'badge warn' }, `PROVISIONAL · ${submitted}/${result.judges.length} judges submitted`)];
}

// ---- Live monitor -----------------------------------------------------------

function monitorCard(result) {
  const { category, judges, rows, criteria } = result;
  const showDeductions = Boolean(category.apply_deductions);

  const chips = judges.map((judge) => h('span', { class: 'judge-chip' },
    h('span', { class: `dot ${store.online.has(judge.id) ? 'on' : ''}`, title: store.online.has(judge.id) ? 'Connected' : 'Not connected' }),
    `Judge ${judge.judge_no}`,
    h('span', { class: 'count' }, `${judge.completed}/${judge.total}`),
    judge.status === 'submitted'
      ? [
        h('span', { class: 'badge ok' }, 'Submitted'),
        button('Reopen', async () => {
          const confirmed = await confirmDialog({
            title: `Reopen Judge ${judge.judge_no}'s scoresheet?`,
            message: `Judge ${judge.judge_no} will be able to change their ${category.name} scores and must submit again.`,
            confirmLabel: 'Reopen scoresheet',
          });
          if (confirmed) act(() => api('POST', '/scoresheets/reopen', { judgeId: judge.id, categoryId: category.id }));
        }, 'small'),
      ]
      : h('span', { class: 'badge' }, 'Scoring'),
  ));

  const byRankSum = category.ranking_method === 'rank_sum';

  const body = rows.map((row) => h('tr', { class: row.rank === 1 && result.isFinal ? 'winner' : '' },
    h('td', { class: 'muted' }, row.contestant.contestant_no),
    h('td', { class: 'strong' }, row.contestant.name),
    judges.map((judge) => judgeCell(row.judges[judge.id], byRankSum, criteria.length)),
    showDeductions && deductionCell(row),
    byRankSum
      ? h('td', { class: 'num strong' }, row.rankSum == null ? '–' : row.rankSum)
      : h('td', { class: 'num strong' }, fmt(row.average, 3)),
    h('td', { class: 'center rank' }, row.rank == null ? '–' : row.rank),
  ));

  let content;
  if (judges.length === 0) content = empty('No judges are assigned to this category.');
  else if (rows.length === 0) content = empty('No contingents are entered in this category yet.');
  else {
    content = table([
      'No', 'Contingent',
      ...judges.map((judge) => judgeHeader(judge, byRankSum)),
      showDeductions && h('th', null, 'Deductions'),
      h('th', { class: 'num' }, byRankSum ? 'Rank total' : 'Average'),
      h('th', { class: 'center' }, 'Rank'),
    ].filter(Boolean), body);
  }

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, category.name), statusBadge(result)),
    judges.length > 0 && h('div', { class: 'judge-chips' }, chips),
    content,
  );
}

function monitorView() {
  const { state, results } = store;
  const { urls } = state.server;
  return [
    pageHead('Live monitor', 'Scores appear here the moment a judge enters them.'),
    h('section', { class: 'card connect' },
      h('div', null,
        h('h2', null, 'Judges connect here'),
        h('p', null, 'Put every judge device on the same Wi-Fi or LAN as this computer, then open this address in its browser.'),
      ),
      h('div', { class: 'connect-urls' },
        urls.length
          ? urls.map((url) => h('code', null, url))
          : h('p', null, 'No network found. Connect this computer to the Wi-Fi or LAN first.'),
      ),
    ),
    results.categories.length
      ? results.categories.map(monitorCard)
      : h('section', { class: 'card' }, empty('No categories yet. Add one under Categories & criteria.')),
  ];
}

// ---- Results ----------------------------------------------------------------

function resultsView() {
  const { results } = store;
  if (results.categories.length === 0) {
    return [pageHead('Results', 'Computed totals and rankings.'), h('section', { class: 'card' }, empty('No categories yet.'))];
  }

  const current = results.categories.find((result) => result.category.id === store.resultsTab) || results.categories[0];
  store.resultsTab = current.category.id;
  const { category, judges } = current;
  const showDeductions = Boolean(category.apply_deductions);
  const byRankSum = category.ranking_method === 'rank_sum';

  const ordered = [...current.rows].sort((a, b) =>
    (a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)
    || a.contestant.contestant_no - b.contestant.contestant_no);

  const notes = tieNotes(current);
  const remarks = tieRemarks(current);

  const body = ordered.map((row) => h('tr', { class: row.rank === 1 ? 'winner' : '' },
    h('td', { class: 'center rank' }, row.rank == null ? '–' : row.rank),
    h('td', { class: 'muted' }, row.contestant.contestant_no),
    h('td', { class: 'strong' }, row.contestant.name),
    judges.map((judge) => judgeCell(row.judges[judge.id], byRankSum, current.criteria.length)),
    byRankSum && h('td', { class: 'num strong' }, row.rankSum == null ? '–' : row.rankSum),
    h('td', { class: byRankSum ? 'num' : 'num strong' }, fmt(row.average, 3)),
    showDeductions && deductionCell(row),
    h('td', null,
      row.placement && [h('span', { class: `badge ${row.rank === 1 ? 'gold' : 'brand'}` }, row.placement), ' '],
      remarks.has(row.contestant.id) && h('span', {
        class: 'badge warn',
        title: remarks.get(row.contestant.id).detail && `Placed by ${remarks.get(row.contestant.id).detail}`,
      }, remarks.get(row.contestant.id).label)),
  ));

  const headers = [
    h('th', { class: 'center' }, 'Rank'), 'No', 'Contingent',
    ...judges.map((judge) => judgeHeader(judge, byRankSum)),
    byRankSum && h('th', { class: 'num' }, 'Rank total'),
    h('th', { class: 'num', title: byRankSum ? 'Only used to break a tie in the rank total' : '' }, 'Avg. score'),
    showDeductions && h('th', null, 'Deductions'),
    'Award',
  ].filter(Boolean);

  return [
    pageHead('Results', 'Computed totals and rankings. Provisional until every judge has submitted.',
      button('Print this category', () => openPrint({ view: 'results', category: category.id })),
      button('Print all categories', () => openPrint({ view: 'results', category: 'all' })),
      button('Print judge scoresheets', () => openPrint({ view: 'judge', category: category.id, judge: 'all' })),
      h('button', {
        class: 'btn',
        type: 'button',
        title: 'Empty scoresheets for each judge to fill in and sign by hand, and an empty tabulation sheet, for this category',
        onclick: () => openPrint({ view: 'blank', category: category.id }),
      }, 'Print blank sheets'),
    ),
    h('nav', { class: 'tabs' }, results.categories.map((result) => h('button', {
      class: `tab ${result.category.id === category.id ? 'active' : ''}`,
      onclick: () => {
        store.resultsTab = result.category.id;
        render();
      },
    }, result.category.name))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, category.name), statusBadge(current)),
      current.rows.length ? table(headers, body) : empty('No contingents are entered in this category yet.'),
      notes.length > 0 && h('div', { class: 'card-notes ties' },
        h('h3', null, notes.length === 1 ? 'Tie in this category' : 'Ties in this category'),
        h('ul', null, notes.map((note) => h('li', null, note))),
        voteRows(current),
      ),
      h('div', { class: 'card-notes' },
        h('h3', null, 'Tie-break guidelines'),
        h('ol', null, tieGuidelines(current).map((rule) => h('li', null, rule))),
      ),
      h('div', { class: 'card-foot muted' },
        byRankSum
          ? "Each judge's score for a contingent is their raw score less its deductions. Those scores are turned into that judge's ranking (shown in the circle). Equal scores share the average of their places, so a rank can be a half such as 2.5. The rank total is the sum of those ranks; the lowest wins."
          : "Each judge's score for a contingent is their raw score" + (showDeductions ? ' less its deductions' : '') + '. The highest average of those scores wins.',
      ),
    ),
  ];
}

/** Records how the judges voted on contingents the tie-break could not separate. */
function voteDialog(result, contestantIds, existing) {
  const { category } = result;
  const titles = category.placement_titles;
  const rows = contestantIds.map((id) => result.rows.find((row) => row.contestant.id === id));
  const first = Math.min(...rows.map((row) => row.rank));
  const options = rows.map((row) => ({ value: row.contestant.id, label: `${row.contestant.contestant_no}. ${row.contestant.name}` }));
  const placeLabel = (index) => `Rank ${first + index}${titles[first + index - 1] ? ` — ${titles[first + index - 1]}` : ''}`;
  return formDialog({
    title: existing ? 'Change the judges\' vote' : 'Record the judges\' vote',
    intro: `${rows.map((row) => row.contestant.name).join(', ')} have the same rank total and the same average score in ${category.name}. Enter the order the judges decided by majority vote (the chairman decides a level vote).`,
    fields: [
      ...rows.map((_, index) => ({ name: `place${index}`, label: placeLabel(index), type: 'select', options })),
      { name: 'note', label: 'Vote count (optional, printed on the results)', placeholder: 'e.g. 3–2, or chairman\'s vote' },
    ],
    values: {
      ...Object.fromEntries(contestantIds.map((id, index) => [`place${index}`, id])),
      note: existing ? existing.note : '',
    },
    submitLabel: 'Save vote',
    onSubmit: (values) => {
      const placing = rows.map((_, index) => Number(values[`place${index}`]));
      if (new Set(placing).size !== placing.length) throw new Error('Each contingent must appear once.');
      return api('POST', '/tie-votes', { categoryId: category.id, placing, note: values.note });
    },
  }).then((saved) => saved && reload().then(() => toast('Vote recorded. The placings follow it.', 'ok')));
}

/** The ties waiting for the judges' vote, and the votes already recorded, with their buttons. */
function voteRows(result) {
  const names = (ids) => ids.map((id) => result.rows.find((row) => row.contestant.id === id).contestant.name).join(', ');
  return [
    ...result.pendingVotes.map((level) => h('div', { class: 'vote-row' },
      h('span', { class: 'badge warn' }, 'Vote needed'),
      h('span', null, `Rank ${level.rank}: ${names(level.contestantIds)}`),
      button("Record judges' vote", () => voteDialog(result, level.contestantIds), 'small primary'),
    )),
    ...result.votes.map((vote) => h('div', { class: 'vote-row' },
      h('span', { class: 'badge ok' }, 'Decided by vote'),
      h('span', null, `From rank ${vote.rank}: ${names(vote.contestantIds)}${vote.note ? ` (${vote.note})` : ''}`),
      button('Change', () => voteDialog(result, vote.contestantIds, vote), 'small'),
      button('Clear', async () => {
        const confirmed = await confirmDialog({
          title: 'Clear this vote?',
          message: 'The contingents go back to sharing the placing until a vote is recorded again.',
          confirmLabel: 'Clear vote',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/tie-votes/${vote.id}`));
      }, 'small danger'),
    )),
  ];
}

// ---- Deductions -------------------------------------------------------------

function deductionsView() {
  const { state } = store;
  const applying = state.categories.filter((category) => category.apply_deductions);
  const subtitle = (applying.length
    ? `Time and safety penalties. They are applied to: ${applying.map((category) => category.name).join(', ')}.`
    : 'Time and safety penalties. No category currently applies deductions.')
    + " Every deduction comes off each judge's raw score for that contingent.";

  const contestant = h('select', null,
    state.contestants.map((entry) => h('option', { value: entry.id }, `${entry.contestant_no}. ${entry.name}`)));
  const type = h('select', null, state.deductionTypes.map((entry) => h('option', { value: entry.id }, entry.name)));
  const time = h('input', { type: 'text', placeholder: 'e.g. 6:15', autocomplete: 'off' });
  const quantity = h('input', { type: 'text', inputMode: 'numeric', value: '1', autocomplete: 'off' });
  const remarks = h('input', { type: 'text', autocomplete: 'off' });
  const timeField = field('Measured time (min:sec)', time);
  const quantityField = field('How many times', quantity);
  const rule = h('p', { class: 'muted' });

  const syncFields = () => {
    const selected = typeById(Number(type.value));
    const timed = Boolean(selected) && selected.limit_seconds != null;
    timeField.hidden = !timed;
    quantityField.hidden = timed;
    rule.textContent = selected ? `Rule: ${ruleSummary(selected)} ${selected.notes}` : '';
  };
  type.addEventListener('change', syncFields);
  syncFields();

  const add = async (event) => {
    event.preventDefault();
    const selected = typeById(Number(type.value));
    const body = { contestantId: Number(contestant.value), typeId: selected.id, remarks: remarks.value };
    if (selected.limit_seconds != null) {
      body.measuredSeconds = parseClock(time.value);
      if (body.measuredSeconds == null) {
        toast('Enter the measured time as minutes:seconds, for example 6:15.', 'error');
        return;
      }
    } else {
      body.quantity = quantity.value;
    }
    await act(() => api('POST', '/deductions', body), 'Deduction recorded.');
  };

  const canAdd = state.contestants.length > 0 && state.deductionTypes.length > 0;
  const contestantById = new Map(state.contestants.map((entry) => [entry.id, entry]));

  const rows = state.deductions.map((deduction) => {
    const selected = typeById(deduction.deduction_type_id);
    const who = contestantById.get(deduction.contestant_id);
    return h('tr', null,
      h('td', { class: 'strong' }, who ? `${who.contestant_no}. ${who.name}` : '—'),
      h('td', null, selected ? selected.name : '—'),
      h('td', { class: 'num' }, deduction.measured_seconds == null ? '–' : clock(deduction.measured_seconds)),
      h('td', { class: 'num deducted' }, `−${plain(deduction.points)}`),
      h('td', { class: 'muted' }, deduction.remarks),
      h('td', { class: 'num' }, button('Remove', async () => {
        const confirmed = await confirmDialog({
          title: 'Remove this deduction?',
          message: `${selected ? selected.name : 'Deduction'} for ${who ? who.name : 'this contingent'} will no longer be taken off.`,
          confirmLabel: 'Remove deduction',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/deductions/${deduction.id}`));
      }, 'small danger')),
    );
  });

  return [
    pageHead('Deductions', subtitle),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Record a deduction')),
      canAdd
        ? h('form', { class: 'card-body', onsubmit: add },
          h('div', { class: 'inline-form' },
            field('Contingent', contestant),
            field('Violation', type),
            h('div', null, timeField, quantityField),
            field('Remarks (optional)', remarks),
            h('button', { class: 'btn primary', type: 'submit' }, 'Add deduction'),
          ),
          h('div', { style: 'margin-top: 12px' }, rule),
        )
        : empty('Add contingents first, then deductions can be recorded here.'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Recorded deductions')),
      rows.length
        ? table(['Contingent', 'Violation', h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Points per judge'), 'Remarks', ''], rows)
        : empty('No deductions recorded.'),
    ),
  ];
}

// ---- Encoding -----------------------------------------------------------------

/** The judges an encoder device may enter sheets for, or a warning that it has none. */
function encoderJudgeBadges(device) {
  const judges = store.state.judges.filter((judge) => device.judgeIds.includes(judge.id));
  if (!judges.length) return h('span', { class: 'badge danger' }, 'None — cannot encode');
  return judges.map((judge) => [h('span', { class: 'badge brand' }, `Judge ${judge.judge_no}`), ' ']);
}

function encoderJudgeField() {
  return {
    name: 'judgeIds', label: 'Judges whose paper sheets this person enters', type: 'checks',
    options: store.state.judges.map((judge) => ({ value: judge.id, label: `Judge ${judge.judge_no}${judgeName(judge) ? ` — ${judgeName(judge)}` : ''}` })),
    hint: 'They cannot open or change any other judge\'s sheet. With none ticked, they cannot encode at all.',
  };
}

function encoderJudgesDialog(device) {
  return formDialog({
    title: `Judges for ${device.name}`,
    fields: [encoderJudgeField()],
    values: { judgeIds: device.judgeIds },
    onSubmit: (values) => api('PUT', `/encoders/${device.id}/judges`, values),
  }).then((saved) => saved && reload().then(() => toast(`${device.name}'s judges saved.`, 'ok')));
}

function encoderDeviceRow(device, actions) {
  return h('tr', null,
    h('td', { class: 'strong' }, device.name),
    device.status === 'pending' && h('td', null, h('code', { class: 'secret' }, device.pairing_code)),
    device.status === 'paired' && h('td', null, encoderJudgeBadges(device)),
    h('td', null, h('span', { class: 'device-detail' }, deviceLabel(device))),
    h('td', { class: 'nowrap muted' }, localTime(device.status === 'pending' ? device.created_at : device.paired_at)),
    h('td', { class: 'num nowrap' }, actions),
  );
}

function scanKeyDialog() {
  return formDialog({
    title: 'Claude API key',
    intro: 'Reading photos of paper scoresheets uses Claude, so this computer needs internet access while a photo is read. The key is kept on this computer and never shown again. Leave the field empty to remove it.',
    fields: [{ name: 'apiKey', label: 'API key', type: 'password', placeholder: 'sk-ant-…' }],
    submitLabel: 'Save key',
    onSubmit: (values) => api('PUT', '/scan-key', values),
  }).then((saved) => saved && reload().then(() => toast(store.state.scan.ready ? 'Photo reading is ready.' : 'API key removed.', 'ok')));
}

function encodingView() {
  const { encoders, scan, server } = store.state;
  const pending = encoders.devices.filter((device) => device.status === 'pending');
  const paired = encoders.devices.filter((device) => device.status === 'paired');

  const approve = (device) => formDialog({
    title: `Approve ${device.name}'s device?`,
    intro: `Approve only if that device is showing the pairing code ${device.pairing_code}. It can then enter and change the scores of the judges you tick, until you unpair it.`,
    fields: [encoderJudgeField()],
    values: { judgeIds: [] },
    submitLabel: 'Approve',
    onSubmit: (values) => api('POST', `/encoders/${device.id}/approve`, values),
  }).then((saved) => saved && reload().then(() => toast(`${device.name}'s device is paired.`, 'ok')));
  const remove = async (device, isPaired) => {
    const confirmed = await confirmDialog({
      title: isPaired ? `Unpair ${device.name}'s device?` : `Turn down ${device.name}'s request?`,
      message: isPaired ? 'It stops working at once. Scores it already saved are kept.' : 'The device is told to ask again.',
      confirmLabel: isPaired ? 'Unpair' : 'Turn down',
      danger: true,
    });
    if (confirmed) act(() => api('DELETE', `/encoders/${device.id}`));
  };

  return [
    pageHead('Encoding', "The tabulating team enters the judges' paper scoresheets on their own phones or laptops: typed in, or read from a photo and checked."),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'How the team connects')),
      h('div', { class: 'card-body signatories' },
        h('div', null,
          h('span', { class: 'field-label' }, 'On the event network, open'),
          server.urls.length
            ? server.urls.map((url) => h('div', null, h('code', { class: 'path' }, `${url}/encode/`)))
            : h('span', { class: 'muted' }, 'No network found.'),
        ),
        h('div', null,
          h('span', { class: 'field-label' }, 'Encoder access code (tabulating team only)'),
          h('code', { class: 'secret' }, encoders.accessCode), ' ',
          button('New code', async () => {
            const confirmed = await confirmDialog({
              title: 'Give the team a new access code?',
              message: 'The old code stops working for new devices. Devices already paired stay paired; unpair them below if needed.',
              confirmLabel: 'Generate new code',
            });
            if (confirmed) act(() => api('POST', '/encoder-code'), 'New encoder access code generated.');
          }, 'small'),
        ),
      ),
      h('div', { class: 'card-foot muted' },
        'A device asks to pair with the access code and then shows a four-digit pairing code. It can do nothing until you approve it here, after checking that the codes match.'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Waiting for approval'), pending.length > 0 && h('span', { class: 'badge warn' }, pending.length)),
      pending.length
        ? table(['Name', 'Pairing code', 'Device', 'Asked', ''], pending.map((device) => encoderDeviceRow(device, [
          button('Approve', () => approve(device), 'small primary'), ' ',
          button('Turn down', () => remove(device, false), 'small danger'),
        ])))
        : empty('No device is waiting.'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Paired devices')),
      paired.length
        ? table(['Name', 'Judges', 'Device', 'Paired', ''], paired.map((device) => encoderDeviceRow(device, [
          button('Judges…', () => encoderJudgesDialog(device), 'small'), ' ',
          button('Unpair', () => remove(device, true), 'small danger'),
        ])))
        : empty('No encoder device is paired.'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, 'Reading photos'),
        h('span', { class: `badge ${scan.ready ? 'ok' : ''}` }, scan.ready ? 'READY' : 'NOT SET UP'),
        !scan.fromEnvironment && button(scan.ready ? 'Change key' : 'Set API key', scanKeyDialog, 'small'),
      ),
      h('div', { class: 'card-body' },
        h('p', null, "An encoder can photograph a judge's paper sheet. Claude reads the handwritten scores and fills them into the grid, marking any it is unsure of. The encoder checks every number against the paper and corrects it before saving; nothing read from a photo is saved without that check."),
        h('p', { class: 'muted' }, scan.fromEnvironment
          ? 'The API key comes from the ANTHROPIC_API_KEY environment variable on this computer.'
          : 'Needs a Claude API key, and internet access on this computer while a photo is read. Photos are sent to Anthropic to be read. Without a key, encoders type the scores in.'),
      ),
    ),
  ];
}

// ---- Contingents ------------------------------------------------------------

function contestantDialog(existing) {
  return formDialog({
    title: existing ? 'Edit contingent' : 'Add contingent',
    fields: [
      { name: 'contestant_no', label: 'Number (order of performance)', type: 'number', hint: existing ? '' : 'Leave blank to use the next number.' },
      { name: 'name', label: 'Name of contingent', required: true },
      { name: 'categoryIds', label: 'Competes in', type: 'checks', options: categoryOptions() },
    ],
    values: existing || { categoryIds: store.state.categories.map((category) => category.id) },
    onSubmit: (values) => (existing
      ? api('PUT', `/contestants/${existing.id}`, values)
      : api('POST', '/contestants', values)),
  }).then((saved) => saved && reload());
}

function bulkContestantDialog() {
  return formDialog({
    title: 'Add several contingents',
    intro: 'Type one contingent per line, in order of performance. They are numbered after the last existing one and entered in every category.',
    fields: [{ name: 'names', label: 'Contingents', type: 'lines', rows: 9, required: true }],
    submitLabel: 'Add all',
    onSubmit: async ({ names }) => {
      for (const name of names) await api('POST', '/contestants', { name });
    },
  }).then(reload);
}

function contingentsView() {
  const rows = store.state.contestants.map((contestant) => h('tr', null,
    h('td', { class: 'muted' }, contestant.contestant_no),
    h('td', { class: 'strong' }, contestant.name),
    h('td', null, categoryBadges(contestant.categoryIds)),
    h('td', { class: 'num nowrap' },
      button('Edit', () => contestantDialog(contestant), 'small'), ' ',
      button('Delete', async () => {
        const confirmed = await confirmDialog({
          title: `Delete ${contestant.name}?`,
          message: 'Every score and deduction recorded for this contingent will be deleted too. This cannot be undone.',
          confirmLabel: 'Delete contingent',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/contestants/${contestant.id}`));
      }, 'small danger'),
    ),
  ));

  return [
    pageHead('Contingents', 'The competing groups, numbered in order of performance.',
      button('Add several', bulkContestantDialog),
      button('Add contingent', () => contestantDialog(), 'primary'),
    ),
    h('section', { class: 'card' },
      rows.length ? table(['No', 'Name of contingent', 'Competes in', ''], rows) : empty('No contingents yet.'),
    ),
  ];
}

// ---- Judges -----------------------------------------------------------------

function judgeDialog(existing) {
  return formDialog({
    title: existing ? `Edit Judge ${existing.judge_no}` : 'Add judge',
    intro: existing ? '' : 'The judge is numbered automatically, with the lowest number not already in use.',
    fields: [
      // A new judge is numbered by the server; the number can still be changed afterwards.
      existing && { name: 'judge_no', label: 'Judge number', type: 'number' },
      { name: 'name', label: 'Name', required: true },
      {
        name: 'access_code', label: 'Access code',
        hint: existing
          ? 'Changing the code signs this judge out of their device.'
          : 'Leave blank to generate a 6-digit code.',
      },
      {
        name: 'device_mac', label: 'Registered device (MAC address)', placeholder: 'e.g. A4:83:E7:12:34:56',
        hint: 'Leave blank to allow any device. While the device lock is on, a judge with no registered device cannot sign in.',
      },
      { name: 'categoryIds', label: 'Scores these categories', type: 'checks', options: categoryOptions() },
    ],
    values: existing || { categoryIds: store.state.categories.map((category) => category.id) },
    onSubmit: (values) => (existing
      ? api('PUT', `/judges/${existing.id}`, values)
      : api('POST', '/judges', values)),
  }).then((saved) => saved && reload());
}

const isThisComputer = (ip) => ip === '127.0.0.1' || ip === '::1' || store.state.server.urls.some((url) => url.includes(`//${ip}:`));

/** A session is on the right device when the judge has no registered device, or it is that one. */
const onRegisteredDevice = (judge) => !judge.device_mac || judge.session.mac === judge.device_mac;

function deviceLabel(device) {
  if (isThisComputer(device.ip)) return 'This computer';
  return `${device.mac || 'MAC address unknown'} · ${device.ip}`;
}

const registerDevice = (judge, mac) => act(
  () => api('PUT', `/judges/${judge.id}`, { name: judge.name, device_mac: mac }),
  `Judge ${judge.judge_no} is registered to ${mac}.`,
);

/** The device a judge is signed in on, with the button that ends that session. */
function sessionCell(judge) {
  const { session } = judge;
  if (!session) return h('td', { class: 'muted nowrap' }, 'Not signed in');
  const online = store.online.has(judge.id);
  return h('td', null,
    h('div', { class: 'nowrap' },
      h('span', { class: `dot ${online ? 'on' : ''}` }),
      online ? ' Connected' : ' Signed in, not connected',
      !onRegisteredDevice(judge) && [' ', h('span', { class: 'badge warn' }, 'Not the registered device')],
      judge.phone_linked && [' ', h('span', { class: 'badge brand', title: 'A phone is linked to send photos of this judge\'s paper sheet. It cannot change scores.' }, 'Phone linked')],
    ),
    h('div', { class: 'device-detail' }, `${deviceLabel(session)} · since ${localTime(session.since)}`),
    button('Disconnect', async () => {
      const confirmed = await confirmDialog({
        title: `Disconnect Judge ${judge.judge_no}'s device?`,
        message: [
          `The device signed in as Judge ${judge.judge_no} is signed out at once, and another device can then sign in. Scores already saved are kept.`,
          'Anyone who knows the access code can sign in again. If the wrong person has the code, use New code instead.',
        ],
        confirmLabel: 'Disconnect',
        danger: true,
      });
      if (confirmed) act(() => api('POST', `/judges/${judge.id}/disconnect`), `Judge ${judge.judge_no}'s device was disconnected.`);
    }, 'small danger'),
  );
}

function registeredCell(judge) {
  const { session } = judge;
  let registered = h('span', { class: 'muted' }, 'Any device');
  if (judge.device_mac) {
    registered = [
      h('code', { class: 'mac' }, judge.device_mac),
      store.state.server.macs.includes(judge.device_mac) && [' ', h('span', { class: 'badge warn', title: 'The tabulation computer itself is registered to this judge.' }, 'This computer')],
    ];
  }
  else if (store.state.deviceLock) registered = h('span', { class: 'badge danger' }, 'None — cannot sign in');
  return h('td', null,
    h('div', { class: 'nowrap' }, registered),
    session && session.mac && session.mac !== judge.device_mac
      && h('div', { style: 'margin-top: 6px' }, button('Use signed-in device', () => registerDevice(judge, session.mac), 'small')),
  );
}

function registerBlockedDialog(device) {
  const { judges } = store.state;
  return formDialog({
    title: `Register ${device.mac}`,
    intro: 'This device will be the only one that can sign in as the judge you choose. A device already registered to that judge is replaced.',
    fields: [{
      name: 'judgeId', label: 'Register to', type: 'select',
      options: judges.map((judge) => ({
        value: judge.id,
        label: `Judge ${judge.judge_no}${judgeName(judge) ? ` — ${judgeName(judge)}` : ''}${judge.device_mac ? ` (now ${judge.device_mac})` : ''}`,
      })),
    }],
    submitLabel: 'Register device',
    onSubmit: ({ judgeId }) => {
      const judge = judges.find((entry) => entry.id === Number(judgeId));
      return api('PUT', `/judges/${judge.id}`, { name: judge.name, device_mac: device.mac });
    },
  }).then((saved) => saved && reload());
}

function deviceLockCard() {
  const { judges, deviceLock, blockedDevices } = store.state;
  const numbers = (list) => list.map((judge) => `Judge ${judge.judge_no}`).join(', ');
  const unregistered = judges.filter((judge) => !judge.device_mac);

  const toggle = async () => {
    if (!deviceLock) {
      const signedOut = judges.filter((judge) => judge.session
        && !(judge.session.mac && judge.session.mac === judge.device_mac));
      const confirmed = await confirmDialog({
        title: 'Turn on the device lock?',
        message: [
          'Only a device registered to a judge will be able to open the judge scoresheet, and only as that judge. Every other device on the network is turned away.',
          unregistered.length > 0 && `No device is registered for ${numbers(unregistered)}, so they will not be able to sign in.`,
          signedOut.length > 0 && `${numbers(signedOut)} will be signed out now, because the device in use is not the registered one.`,
        ].filter(Boolean),
        confirmLabel: 'Turn on device lock',
      });
      if (!confirmed) return;
    }
    act(() => api('PUT', '/device-lock', { enabled: !deviceLock }), deviceLock ? 'Device lock turned off.' : 'Device lock turned on.');
  };

  const blockedRows = blockedDevices.map((device) => h('tr', null,
    h('td', null, device.mac ? h('code', { class: 'mac' }, device.mac) : h('span', { class: 'muted' }, 'Unknown')),
    h('td', null, device.ip),
    h('td', null, new Date(device.at).toLocaleTimeString([], { timeStyle: 'short' })),
    h('td', { class: 'num nowrap' }, device.mac && button('Register to a judge…', () => registerBlockedDialog(device), 'small')),
  ));

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', null, 'Device lock'),
      h('span', { class: `badge ${deviceLock ? 'ok' : ''}` }, deviceLock ? 'ON' : 'OFF'),
      button(deviceLock ? 'Turn off' : 'Turn on', toggle, 'small'),
    ),
    h('div', { class: 'card-body' },
      h('p', null, deviceLock
        ? 'Only a device registered to a judge can open the judge scoresheet, and only as that judge. Every other device is turned away.'
        : 'Any device on the network can open the judge sign-in page. Turn the lock on to allow only the device registered to each judge, identified by its MAC address.'),
      h('p', { class: 'muted' }, deviceLock
        ? 'To register a device, have the judge open the judge address on it. It is turned away and listed below under Devices turned away; press Register to a judge… there. You can also type its MAC address under Edit.'
        : 'To register a device, have the judge sign in on it and press Use signed-in device, or type its MAC address under Edit.'),
      deviceLock && unregistered.length > 0
        && h('p', null, h('span', { class: 'badge danger' }, `${numbers(unregistered)}: no registered device, cannot sign in`)),
    ),
    blockedRows.length > 0 && [
      h('div', { class: 'card-notes' }, h('h3', null, 'Devices turned away')),
      table(['MAC address', 'Address', 'Last tried', ''], blockedRows),
    ],
  );
}

/** The chairman of the board of judges and the tabulator: who signs each category's overall results. */
function signatoriesDialog() {
  const { judges, settings, chairmanJudgeId } = store.state;
  return formDialog({
    title: 'Signatories',
    intro: 'These people sign the overall results of every category, with the other judges. The chairman also signs as a judge.',
    fields: [
      {
        name: 'chairmanJudgeId', label: 'Chairman of the board of judges', type: 'select',
        options: [
          { value: '', label: 'No chairman' },
          ...judges.map((judge) => ({ value: judge.id, label: `Judge ${judge.judge_no}${judgeName(judge) ? ` — ${judgeName(judge)}` : ''}` })),
        ],
      },
      { name: 'tabulatorName', label: 'Head of Tabulation Team', hint: 'Printed on the tabulator\'s signature line. Also under Settings.' },
    ],
    values: { chairmanJudgeId: chairmanJudgeId == null ? '' : chairmanJudgeId, tabulatorName: settings.tabulator_name || '' },
    onSubmit: (values) => api('PUT', '/signatories', values),
  }).then((saved) => saved && reload().then(() => toast('Signatories saved.', 'ok')));
}

function signatoriesCard() {
  const { judges, settings } = store.state;
  const chairman = judges.find((judge) => judge.is_chairman);
  const person = (text, fallback) => (text ? h('strong', null, text) : h('span', { class: 'muted' }, fallback));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', null, 'Signatories'),
      button('Edit', signatoriesDialog, 'small'),
    ),
    h('div', { class: 'card-body signatories' },
      h('div', null,
        h('span', { class: 'field-label' }, 'Chairman of the board of judges'),
        chairman
          ? person(`Judge ${chairman.judge_no}${judgeName(chairman) ? ` — ${judgeName(chairman)}` : ''}`)
          : person('', 'Not chosen. The results are signed by the judges and the tabulator only.'),
      ),
      h('div', null,
        h('span', { class: 'field-label' }, 'Head of Tabulation Team'),
        person(settings.tabulator_name, 'Not set. The line is printed blank.'),
      ),
    ),
  );
}

function judgesView() {
  const rows = store.state.judges.map((judge) => h('tr', null,
    h('td', { class: 'strong nowrap' },
      `Judge ${judge.judge_no}`,
      judge.is_chairman && [h('br'), h('span', { class: 'badge gold' }, 'Chairman')]),
    h('td', null, judgeName(judge) || h('span', { class: 'muted' }, 'Name not set')),
    h('td', null, h('code', { class: 'secret' }, judge.access_code)),
    h('td', null, categoryBadges(judge.categoryIds)),
    sessionCell(judge),
    registeredCell(judge),
    h('td', { class: 'num nowrap' },
      button('New code', async () => {
        const confirmed = await confirmDialog({
          title: `Give Judge ${judge.judge_no} a new access code?`,
          message: 'A new six-digit code is generated. The old code stops working and this judge is signed out of their device. Their scores are kept.',
          confirmLabel: 'Generate new code',
        });
        if (confirmed) act(() => api('PUT', `/judges/${judge.id}`, { name: judge.name, new_code: true }), 'New access code generated.');
      }, 'small'), ' ',
      button('Edit', () => judgeDialog(judge), 'small'), ' ',
      button('Delete', async () => {
        const confirmed = await confirmDialog({
          title: `Delete Judge ${judge.judge_no}?`,
          message: 'Every score this judge has entered will be deleted too. This cannot be undone.',
          confirmLabel: 'Delete judge',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/judges/${judge.id}`));
      }, 'small danger'),
    ),
  ));

  return [
    pageHead('Judges', 'Each judge signs in with the access code shown here, on one device at a time.',
      button('Print access slips', () => openPrint({ view: 'codes' })),
      button('Add judge', () => judgeDialog(), 'primary'),
    ),
    h('section', { class: 'card' },
      rows.length
        ? table(['Judge', 'Name', 'Access code', 'Scores', 'Signed-in device', 'Registered device', ''], rows)
        : empty('No judges yet.'),
    ),
    signatoriesCard(),
    deviceLockCard(),
  ];
}

// ---- Categories and criteria ------------------------------------------------

function categoryDialog(existing) {
  return formDialog({
    title: existing ? `Edit ${existing.name}` : 'Add category',
    fields: [
      { name: 'name', label: 'Category name', required: true },
      { name: 'sort_order', label: 'Display order', type: 'number' },
      {
        name: 'ranking_method', label: 'Ranking method', type: 'select',
        options: Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label })),
      },
      { name: 'apply_deductions', label: 'Deductions', type: 'checkbox', text: 'Apply time and safety deductions to this category' },
      {
        name: 'placement_titles', label: 'Award titles', type: 'lines', rows: 5,
        hint: 'One per line, starting with 1st place. Contingents ranked below the last line get no title.',
      },
    ],
    values: existing || { ranking_method: 'rank_sum', apply_deductions: true, placement_titles: [] },
    onSubmit: (values) => (existing
      ? api('PUT', `/categories/${existing.id}`, values)
      : api('POST', '/categories', values)),
  }).then((saved) => saved && reload());
}

function criterionDialog(category, existing) {
  return formDialog({
    title: existing ? 'Edit criterion' : `Add criterion to ${category.name}`,
    fields: [
      { name: 'name', label: 'Criterion', required: true },
      { name: 'weight', label: 'Weight (%)', type: 'number', required: true, hint: 'Also the maximum points a judge can give for this criterion.' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4 },
      { name: 'sort_order', label: 'Display order', type: 'number' },
    ],
    values: existing || {},
    onSubmit: (values) => (existing
      ? api('PUT', `/criteria/${existing.id}`, values)
      : api('POST', '/criteria', { ...values, categoryId: category.id })),
  }).then((saved) => saved && reload());
}

function categoryCard(category) {
  const total = Math.round(category.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) * 100) / 100;

  const rows = category.criteria.map((criterion, index) => h('tr', null,
    h('td', { class: 'muted' }, index + 1),
    h('td', { class: 'strong' }, criterion.name),
    h('td', null, h('div', { class: 'description' }, criterion.description)),
    h('td', { class: 'num strong' }, `${plain(criterion.weight)}%`),
    h('td', { class: 'num nowrap' },
      button('Edit', () => criterionDialog(category, criterion), 'small'), ' ',
      button('Delete', async () => {
        const confirmed = await confirmDialog({
          title: `Delete "${criterion.name}"?`,
          message: 'Every score judges have given on this criterion will be deleted too. This cannot be undone.',
          confirmLabel: 'Delete criterion',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/criteria/${criterion.id}`));
      }, 'small danger'),
    ),
  ));

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', null, category.name),
      h('span', { class: 'badge' }, METHOD_LABEL[category.ranking_method]),
      h('span', { class: `badge ${category.apply_deductions ? 'brand' : ''}` }, category.apply_deductions ? 'Deductions apply' : 'No deductions'),
      button('Edit', () => categoryDialog(category), 'small'),
      button('Delete', async () => {
        const confirmed = await confirmDialog({
          title: `Delete ${category.name}?`,
          message: 'Its criteria and every score entered in this category will be deleted too. This cannot be undone.',
          confirmLabel: 'Delete category',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/categories/${category.id}`));
      }, 'small danger'),
    ),
    rows.length ? table(['#', 'Criterion', 'Description', h('th', { class: 'num' }, 'Weight'), ''], rows) : empty('No criteria yet.'),
    h('div', { class: 'card-foot' },
      button('Add criterion', () => criterionDialog(category), 'small'),
      h('span', { class: `badge ${total === 100 ? 'ok' : 'warn'}` },
        total === 100 ? 'Weights total 100%' : `Weights total ${plain(total)}% — should be 100%`),
      category.placement_titles.length > 0
        && h('span', { class: 'muted' }, `Awards: ${category.placement_titles.join(' · ')}`),
    ),
  );
}

function categoriesView() {
  const { categories } = store.state;
  return [
    pageHead('Categories & criteria', 'Each category is judged on its own criteria. A criterion\'s weight is the most points a judge can give for it.',
      categories.length > 0 && button('Print blank sheets, all categories', () => openPrint({ view: 'blank', category: 'all' })),
      button('Add category', () => categoryDialog(), 'primary'),
    ),
    categories.length ? categories.map(categoryCard) : h('section', { class: 'card' }, empty('No categories yet.')),
  ];
}

// ---- Settings ---------------------------------------------------------------

function ruleDialog(existing) {
  return formDialog({
    title: existing ? 'Edit deduction rule' : 'Add deduction rule',
    fields: [
      { name: 'name', label: 'Violation', required: true },
      { name: 'points', label: 'Points deducted', type: 'number', required: true, hint: "Taken from each judge's raw score for the contingent." },
      {
        name: 'unit', label: 'Charged', type: 'select',
        options: [
          { value: 'flat', label: 'Once per violation' },
          { value: 'per_minute', label: 'Per full minute over the time limit' },
          { value: 'per_started_minute', label: 'Per started minute over the time limit' },
        ],
      },
      { name: 'limit', label: 'Time limit (min:sec)', placeholder: 'e.g. 5:00', hint: 'Leave blank for violations that are not timed.' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    values: existing ? { ...existing, limit: clock(existing.limit_seconds) } : { unit: 'flat' },
    onSubmit: ({ limit, ...values }) => {
      const seconds = limit === '' ? null : parseClock(limit);
      if (limit !== '' && seconds == null) throw new Error('Enter the time limit as minutes:seconds, for example 5:00.');
      const body = { ...values, limit_seconds: seconds };
      return existing ? api('PUT', `/deduction-types/${existing.id}`, body) : api('POST', '/deduction-types', body);
    },
  }).then((saved) => saved && reload());
}

function settingsView() {
  const { state } = store;
  const inputs = {
    event_name: h('input', { type: 'text', required: true }),
    event_subtitle: h('input', { type: 'text' }),
    event_venue: h('input', { type: 'text' }),
    event_date: h('input', { type: 'text', placeholder: 'e.g. November 16, 2026' }),
    tabulator_name: h('input', { type: 'text' }),
  };
  for (const [key, input] of Object.entries(inputs)) input.value = state.settings[key] || '';

  const saveEvent = (event) => {
    event.preventDefault();
    const body = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    act(() => api('PUT', '/settings', body), 'Event details saved.');
  };

  const ruleRows = state.deductionTypes.map((type) => h('tr', null,
    h('td', { class: 'strong' }, type.name),
    h('td', { class: 'num' }, plain(type.points)),
    h('td', null, type.unit === 'flat' ? UNIT_LABEL.flat : `${UNIT_LABEL[type.unit]} ${clock(type.limit_seconds)}`),
    h('td', { class: 'num' }, type.limit_seconds == null ? '–' : clock(type.limit_seconds)),
    h('td', null, h('div', { class: 'description' }, type.notes)),
    h('td', { class: 'num nowrap' },
      button('Edit', () => ruleDialog(type), 'small'), ' ',
      button('Delete', async () => {
        const confirmed = await confirmDialog({
          title: `Delete "${type.name}"?`,
          message: 'This rule will no longer be available when recording deductions.',
          confirmLabel: 'Delete rule',
          danger: true,
        });
        if (confirmed) act(() => api('DELETE', `/deduction-types/${type.id}`));
      }, 'small danger'),
    ),
  ));

  const backup = async () => {
    try {
      const { file } = await api('POST', '/backup');
      toast(`Backup saved to ${file}`, 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const resetScores = () => formDialog({
    title: 'Clear all scores?',
    intro: 'This deletes every score, every submission and every recorded deduction. Judges, contingents, categories and criteria are kept. Use it after a rehearsal, before the real event. It cannot be undone.',
    fields: [{ name: 'confirm', label: 'Type RESET to confirm', required: true }],
    submitLabel: 'Clear all scores',
    onSubmit: (values) => api('POST', '/reset-scores', values),
  }).then((saved) => saved && reload().then(() => toast('All scores cleared.', 'ok')));

  return [
    pageHead('Settings', 'Event details, the deduction rule book and data maintenance.'),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Event details')),
      h('form', { class: 'card-body', onsubmit: saveEvent },
        h('div', { class: 'settings-form' },
          field('Event name', inputs.event_name),
          field('Subtitle', inputs.event_subtitle),
          field('Venue', inputs.event_venue),
          field('Date', inputs.event_date),
          field('Head of Tabulation Team', inputs.tabulator_name, 'Printed on the signature line of the official results. Also under Judges → Signatories.'),
        ),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save event details'),
      ),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Deduction rules'), button('Add rule', () => ruleDialog(), 'small')),
      ruleRows.length
        ? table(['Violation', h('th', { class: 'num' }, 'Points'), 'Charged', h('th', { class: 'num' }, 'Limit'), 'Notes', ''], ruleRows)
        : empty('No deduction rules.'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Data')),
      h('div', { class: 'card-body' },
        h('p', null, 'Everything is stored in one file on this computer: ', h('code', { class: 'path' }, state.server.dbPath)),
        h('p', { class: 'muted', style: 'margin: 6px 0 14px' }, 'Back it up before the event starts and again once results are final.'),
        h('div', { class: 'actions' },
          button('Back up now', backup),
          button('Clear all scores…', resetScores, 'danger'),
        ),
      ),
    ),
  ];
}

// ---- Shell ------------------------------------------------------------------

const VIEWS = {
  monitor: monitorView,
  results: resultsView,
  deductions: deductionsView,
  encoding: encodingView,
  contingents: contingentsView,
  judges: judgesView,
  categories: categoriesView,
  settings: settingsView,
};

const pendingEncoders = () => store.state.encoders.devices.filter((device) => device.status === 'pending').length;

function renderShell() {
  const { settings } = store.state;
  document.title = `${settings.event_name} · Tabulation`;
  document.getElementById('brand-name').textContent = settings.event_name;
  document.getElementById('brand-sub').textContent = settings.event_subtitle || '';

  clear(nav).append(...NAV.flatMap(([group, items]) => [
    h('div', { class: 'nav-group' }, group),
    ...items.map(([view, label]) => h('button', {
      class: `nav-item ${store.view === view ? 'active' : ''}`,
      'data-view': view,
      onclick: () => {
        store.view = view;
        render();
        main.scrollTop = 0;
      },
    }, label, view === 'encoding' && pendingEncoders() > 0 && h('span', { class: 'nav-count' }, pendingEncoders()))),
  ]));

  clear(document.getElementById('connection')).append(
    h('span', { class: `dot ${store.connected ? 'on' : 'off'}` }),
    store.connected ? `${store.online.size} of ${store.state.judges.length} judges connected` : 'Reconnecting…',
  );
}

function render() {
  const scroll = main.scrollTop;
  renderShell();
  clear(main).append(...VIEWS[store.view]().flat(Infinity).filter(Boolean));
  main.scrollTop = scroll;
}

let refreshTimer = null;
let setupChanged = false;

/** Live events only say that something changed; the fresh numbers are fetched over HTTP. */
function onLiveEvent(event) {
  if (event.type === 'hello') return;
  if (event.type === 'presence') {
    store.online = new Set(event.onlineJudgeIds);
    if (INLINE_FORM_VIEWS.has(store.view)) renderShell();
    else render();
    return;
  }
  if (event.type !== 'scores' && event.type !== 'sheets') setupChanged = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const setup = setupChanged;
    setupChanged = false;
    try {
      await refresh({ setup });
      if (INLINE_FORM_VIEWS.has(store.view)) renderShell();
      else render();
    } catch {
      // The reconnect handler refreshes again once the server is reachable.
    }
  }, 150);
}

async function start() {
  try {
    await reload();
  } catch (error) {
    clear(main).append(h('section', { class: 'card' }, empty(error.message), h('div', { class: 'card-foot' }, button('Try again', start))));
    return;
  }
  connectLive({
    query: () => 'role=admin',
    onEvent: onLiveEvent,
    onStatus(up) {
      store.connected = up;
      renderShell();
      if (up) onLiveEvent({ type: 'resync' });
    },
  });
}

start();
