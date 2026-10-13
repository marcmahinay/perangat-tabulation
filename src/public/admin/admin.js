import { h, clear, fmt, plain, clock, parseClock } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { connectLive } from '/shared/live.js';
import { confirmDialog, formDialog, toast } from '/shared/ui.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');

const NAV = [
  ['Event', [['monitor', 'Live monitor'], ['results', 'Results'], ['deductions', 'Deductions']]],
  ['Setup', [['contingents', 'Contingents'], ['judges', 'Judges'], ['categories', 'Categories & criteria'], ['settings', 'Settings']]],
];

// Views with inline form fields are not redrawn by live events, so typing is never interrupted.
const INLINE_FORM_VIEWS = new Set(['deductions', 'settings']);

const SCOPE_LABEL = { per_judge: "Each judge's total", final: 'Final score' };
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
  const from = type.scope === 'final' ? 'the final score' : "each judge's total score";
  const limit = clock(type.limit_seconds);
  if (type.unit === 'per_minute') return `${points} per full minute over ${limit}, taken from ${from}.`;
  if (type.unit === 'per_started_minute') return `${points} per started minute over ${limit}, taken from ${from}.`;
  if (limit) return `${points} for any time over ${limit}, taken from ${from}.`;
  return `${points} per violation, taken from ${from}.`;
}

function deductionSummary(row) {
  const parts = [];
  if (row.perJudgeDeduction) parts.push(`−${plain(row.perJudgeDeduction)} per judge`);
  if (row.finalDeduction) parts.push(`−${plain(row.finalDeduction)} final`);
  return parts.join(', ');
}

function deductionCell(row) {
  const text = deductionSummary(row);
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
  if (result.isFinal) return h('span', { class: 'badge ok' }, 'FINAL');
  const submitted = result.judges.filter((judge) => judge.status === 'submitted').length;
  return h('span', { class: 'badge warn' }, `PROVISIONAL · ${submitted}/${result.judges.length} judges submitted`);
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
    !byRankSum && h('td', { class: 'num' }, fmt(row.average, 3)),
    showDeductions && deductionCell(row),
    byRankSum
      ? h('td', { class: 'num strong' }, row.rankSum == null ? '–' : row.rankSum)
      : h('td', { class: 'num strong' }, fmt(row.final, 3)),
    h('td', { class: 'center rank' }, row.rank == null ? '–' : row.rank),
  ));

  let content;
  if (judges.length === 0) content = empty('No judges are assigned to this category.');
  else if (rows.length === 0) content = empty('No contingents are entered in this category yet.');
  else {
    content = table([
      'No', 'Contingent',
      ...judges.map((judge) => judgeHeader(judge, byRankSum)),
      !byRankSum && h('th', { class: 'num' }, 'Average'),
      showDeductions && h('th', null, 'Deductions'),
      h('th', { class: 'num' }, byRankSum ? 'Rank total' : 'Final'),
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

  const body = ordered.map((row) => h('tr', { class: row.rank === 1 ? 'winner' : '' },
    h('td', { class: 'center rank' }, row.rank == null ? '–' : row.rank),
    h('td', { class: 'muted' }, row.contestant.contestant_no),
    h('td', { class: 'strong' }, row.contestant.name),
    judges.map((judge) => judgeCell(row.judges[judge.id], byRankSum, current.criteria.length)),
    byRankSum && h('td', { class: 'num strong' }, row.rankSum == null ? '–' : row.rankSum),
    h('td', { class: 'num' }, fmt(row.average, 3)),
    showDeductions && deductionCell(row),
    !byRankSum && h('td', { class: 'num strong' }, fmt(row.final, 3)),
    h('td', null, row.placement && h('span', { class: `badge ${row.rank === 1 ? 'gold' : 'brand'}` }, row.placement)),
  ));

  const headers = [
    h('th', { class: 'center' }, 'Rank'), 'No', 'Contingent',
    ...judges.map((judge) => judgeHeader(judge, byRankSum)),
    byRankSum && h('th', { class: 'num' }, 'Rank total'),
    h('th', { class: 'num', title: byRankSum ? 'Only used to break a tie in the rank total' : '' }, byRankSum ? 'Avg. score' : 'Average'),
    showDeductions && h('th', null, 'Deductions'),
    !byRankSum && h('th', { class: 'num' }, 'Final score'),
    'Award',
  ].filter(Boolean);

  return [
    pageHead('Results', 'Computed totals and rankings. Provisional until every judge has submitted.',
      button('Print this category', () => openPrint({ view: 'results', category: category.id })),
      button('Print all categories', () => openPrint({ view: 'results', category: 'all' })),
      button('Print judge scoresheets', () => openPrint({ view: 'judge', category: category.id, judge: 'all' })),
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
      h('div', { class: 'card-foot muted' },
        byRankSum
          ? "Each judge's totals are turned into that judge's ranking (shown in the circle). The rank total is the sum of those ranks; the lowest wins. A tie in the rank total goes to the higher average score."
          : "Final score = average of the judges' totals" + (showDeductions ? ', less any final-score deductions' : '') + '. Highest final score wins.',
      ),
    ),
  ];
}

// ---- Deductions -------------------------------------------------------------

function deductionsView() {
  const { state } = store;
  const applying = state.categories.filter((category) => category.apply_deductions);
  const subtitle = (applying.length
    ? `Time and safety penalties. They are applied to: ${applying.map((category) => category.name).join(', ')}.`
    : 'Time and safety penalties. No category currently applies deductions.')
    + (applying.some((category) => category.ranking_method === 'rank_sum')
      ? " With sum-of-ranks scoring, every deduction comes off each judge's total before the judges are ranked."
      : '');

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
      h('td', null, selected ? SCOPE_LABEL[selected.scope] : ''),
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
        ? table(['Contingent', 'Violation', h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Points'), 'Taken from', 'Remarks', ''], rows)
        : empty('No deductions recorded.'),
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
    fields: [
      { name: 'judge_no', label: 'Judge number', type: 'number', hint: existing ? '' : 'Leave blank to use the next number.' },
      { name: 'name', label: 'Name', required: true },
      {
        name: 'access_code', label: 'Access code',
        hint: existing
          ? 'Changing the code signs this judge out of their device.'
          : 'Leave blank to generate a 6-digit code.',
      },
      { name: 'categoryIds', label: 'Scores these categories', type: 'checks', options: categoryOptions() },
    ],
    values: existing || { categoryIds: store.state.categories.map((category) => category.id) },
    onSubmit: (values) => (existing
      ? api('PUT', `/judges/${existing.id}`, values)
      : api('POST', '/judges', values)),
  }).then((saved) => saved && reload());
}

function judgesView() {
  const rows = store.state.judges.map((judge) => h('tr', null,
    h('td', { class: 'strong nowrap' }, `Judge ${judge.judge_no}`),
    h('td', null, judgeName(judge) || h('span', { class: 'muted' }, 'Name not set')),
    h('td', null, h('code', { class: 'secret' }, judge.access_code)),
    h('td', null, categoryBadges(judge.categoryIds)),
    h('td', { class: 'nowrap' },
      h('span', { class: `dot ${store.online.has(judge.id) ? 'on' : ''}` }),
      store.online.has(judge.id) ? ' Connected' : ' Not connected',
    ),
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
    pageHead('Judges', 'Each judge signs in on their own device with the access code shown here.',
      button('Print access slips', () => openPrint({ view: 'codes' })),
      button('Add judge', () => judgeDialog(), 'primary'),
    ),
    h('section', { class: 'card' },
      rows.length ? table(['Judge', 'Name', 'Access code', 'Scores', 'Device', ''], rows) : empty('No judges yet.'),
    ),
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
      { name: 'points', label: 'Points deducted', type: 'number', required: true },
      {
        name: 'scope', label: 'Taken from', type: 'select',
        options: Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label })),
      },
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
    values: existing ? { ...existing, limit: clock(existing.limit_seconds) } : { scope: 'per_judge', unit: 'flat' },
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
    h('td', null, SCOPE_LABEL[type.scope]),
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
          field('Tabulator', inputs.tabulator_name, 'Printed on the signature line of the official results.'),
        ),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save event details'),
      ),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Deduction rules'), button('Add rule', () => ruleDialog(), 'small')),
      ruleRows.length
        ? table(['Violation', h('th', { class: 'num' }, 'Points'), 'Charged', 'Taken from', h('th', { class: 'num' }, 'Limit'), 'Notes', ''], ruleRows)
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
  contingents: contingentsView,
  judges: judgesView,
  categories: categoriesView,
  settings: settingsView,
};

function renderShell() {
  const { settings } = store.state;
  document.title = `${settings.event_name} · Tabulation`;
  document.getElementById('brand-name').textContent = settings.event_name;
  document.getElementById('brand-sub').textContent = settings.event_subtitle || '';

  clear(nav).append(...NAV.flatMap(([group, items]) => [
    h('div', { class: 'nav-group' }, group),
    ...items.map(([view, label]) => h('button', {
      class: `nav-item ${store.view === view ? 'active' : ''}`,
      onclick: () => {
        store.view = view;
        render();
        main.scrollTop = 0;
      },
    }, label)),
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
