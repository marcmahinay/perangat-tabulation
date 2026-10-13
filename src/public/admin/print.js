// Print views. Opened by the admin console as
//   print.html?view=results&category=<id|all>
//   print.html?view=judge&category=<id|all>&judge=<id|all>
//   print.html?view=codes

import { h, fmt, plain, localTime } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { toast } from '/shared/ui.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'results';

/** Reads an id filter from the query string; "all" or nothing means no filter. */
function filterId(name) {
  const value = params.get(name);
  return !value || value === 'all' ? null : Number(value);
}

function header(state, kind, title) {
  const { settings } = state;
  const meta = [settings.event_venue, settings.event_date].filter(Boolean).join(' · ');
  return h('header', { class: 'sheet-header' },
    h('div', null, h('h1', null, settings.event_name), meta && h('p', { class: 'meta' }, meta)),
    h('div', null, h('p', { class: 'kind' }, kind), h('h2', null, title)),
  );
}

function signature(name, role) {
  return h('div', { class: 'signature' }, h('div', { class: 'line' }, name || ' '), h('div', { class: 'role' }, role));
}

const judgeName = (judge) => (judge.name === `Judge ${judge.judge_no}` ? '' : judge.name);

/** Deductions are always taken from each judge's raw score for the contingent. */
function deductionSummary(row) {
  return row.deduction ? `${plain(row.deduction)} / judge` : fmt(0);
}

/** Consolidated results of one category, best rank first. */
function resultsPage(state, result) {
  const { category, judges } = result;
  const showDeductions = Boolean(category.apply_deductions);
  const byRankSum = category.ranking_method === 'rank_sum';
  const rows = [...result.rows].sort((a, b) =>
    (a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)
    || a.contestant.contestant_no - b.contestant.contestant_no);

  const remarks = (row) => [row.placement, ...row.deductions.map((deduction) => deduction.name)].filter(Boolean).join('; ');
  const dash = (value) => (value == null ? '–' : value);

  // Sum-of-ranks sheets follow the festival's own layout: each judge's rank, then the total of the ranks.
  const table = byRankSum
    ? h('table', { class: 'sheet' },
      h('thead', null, h('tr', null,
        h('th', null, 'No'),
        h('th', null, 'Name of contingent'),
        judges.map((judge) => h('th', null, `Judge ${judge.judge_no}`, h('small', null, 'rank'))),
        h('th', null, 'Total'),
        h('th', null, 'Rank'),
        h('th', null, 'Remarks'),
        showDeductions && h('th', null, 'Deduction'),
      )),
      h('tbody', null, rows.map((row) => h('tr', { class: row.rank === 1 ? 'winner' : '' },
        h('td', { class: 'no' }, row.contestant.contestant_no),
        h('td', { class: 'name' }, row.contestant.name),
        judges.map((judge) => h('td', null, dash(row.judges[judge.id].rank))),
        h('td', { class: 'final' }, dash(row.rankSum)),
        h('td', { class: 'rank' }, dash(row.rank)),
        h('td', { class: 'remarks' }, remarks(row)),
        showDeductions && h('td', null, deductionSummary(row)),
      ))),
    )
    : h('table', { class: 'sheet' },
      h('thead', null, h('tr', null,
        h('th', null, 'Rank'),
        h('th', null, 'No'),
        h('th', null, 'Name of contingent'),
        judges.map((judge) => h('th', null, `Judge ${judge.judge_no}`)),
        showDeductions && h('th', null, 'Deduction'),
        h('th', null, 'Average score', h('small', null, plain(result.maxScore))),
        h('th', null, 'Remarks'),
      )),
      h('tbody', null, rows.map((row) => h('tr', { class: row.rank === 1 ? 'winner' : '' },
        h('td', { class: 'rank' }, dash(row.rank)),
        h('td', { class: 'no' }, row.contestant.contestant_no),
        h('td', { class: 'name' }, row.contestant.name),
        judges.map((judge) => h('td', null, fmt(row.judges[judge.id].net))),
        showDeductions && h('td', null, deductionSummary(row)),
        h('td', { class: 'final' }, fmt(row.average, 3)),
        h('td', { class: 'remarks' }, remarks(row)),
      ))),
    );

  return h('section', { class: 'page' },
    header(state, result.isFinal ? 'Official results' : 'Results', category.name),
    !result.isFinal && h('div', { class: 'stamp' }, 'PROVISIONAL — NOT ALL JUDGES HAVE SUBMITTED THEIR SCORESHEETS'),
    table,
    h('p', { class: 'footnote' },
      byRankSum
        ? "Each judge's final score is the raw score less deductions. Each judge ranks the contingents by final score; equal scores share the average of their places. Total = sum of the judges' ranks; the lowest total wins. A tie in the total goes to the higher average score."
        : "Each judge's final score is the raw score" + (showDeductions ? ' less deductions' : '') + ". The highest average of the judges' final scores wins.",
      ` Printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    ),
    h('div', { class: 'signatures' },
      judges.map((judge) => signature(judgeName(judge), `Judge ${judge.judge_no}`)),
      signature(state.settings.tabulator_name, 'Tabulator'),
    ),
  );
}

/** One judge's detailed scoresheet for one category, in order of performance. */
function judgePage(state, result, judge) {
  const { category, criteria } = result;
  const showDeductions = Boolean(category.apply_deductions);
  const submitted = judge.status === 'submitted';
  // The judge's top contingent is highlighted. A tie for first has a fractional rank such as 1.5, so compare with the best rank given.
  const given = result.rows.map((row) => row.judges[judge.id].rank).filter((rank) => rank != null);
  const bestRank = given.length ? Math.min(...given) : null;

  return h('section', { class: 'page' },
    header(state, `Judge ${judge.judge_no} scoresheet`, category.name),
    !submitted && h('div', { class: 'stamp' }, 'DRAFT — THIS SCORESHEET HAS NOT BEEN SUBMITTED'),
    h('table', { class: 'sheet' },
      h('thead', null, h('tr', null,
        h('th', null, 'No'),
        h('th', null, 'Name of contingent'),
        criteria.map((criterion) => h('th', null, criterion.name, h('small', null, plain(criterion.weight)))),
        h('th', null, 'Total score', h('small', null, plain(result.maxScore))),
        showDeductions && h('th', null, 'Deduction'),
        showDeductions && h('th', null, 'Final score', h('small', null, plain(result.maxScore))),
        h('th', null, 'Rank'),
        h('th', null, 'Remarks'),
      )),
      h('tbody', null, result.rows.map((row) => {
        const entry = row.judges[judge.id];
        const reasons = showDeductions
          ? row.deductions.map((deduction) => deduction.name)
          : [];
        return h('tr', { class: entry.rank != null && entry.rank === bestRank ? 'winner' : '' },
          h('td', { class: 'no' }, row.contestant.contestant_no),
          h('td', { class: 'name' }, row.contestant.name),
          criteria.map((criterion) => h('td', null, plain(entry.scores[criterion.id]))),
          h('td', null, entry.filled ? fmt(entry.raw) : ''),
          showDeductions && h('td', null, fmt(entry.deduction)),
          showDeductions && h('td', { class: 'final' }, fmt(entry.net)),
          h('td', { class: 'rank' }, entry.rank == null ? '' : entry.rank),
          h('td', { class: 'remarks' }, reasons.join('; ')),
        );
      })),
    ),
    h('p', { class: 'footnote' },
      submitted ? `Submitted ${localTime(judge.submitted_at)}.` : 'Not yet submitted.',
      ` Printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    ),
    h('div', { class: 'signatures' }, signature(judgeName(judge), `Judge ${judge.judge_no}`)),
  );
}

/** Cut-apart slips telling each judge where to connect and their access code. */
function codesPage(state) {
  const { urls } = state.server;
  return h('section', { class: 'page' },
    header(state, 'Keep private', 'Judge access slips'),
    h('div', { class: 'slips', style: 'margin-top: 8mm' }, state.judges.map((judge) => h('div', { class: 'slip' },
      h('h3', null, `Judge ${judge.judge_no}`),
      h('p', null, judgeName(judge) || ' '),
      h('p', null, 'Connect to the event Wi-Fi, then open:'),
      urls.length ? urls.map((url) => h('p', { class: 'url' }, url)) : h('p', { class: 'url' }, '(address shown on the tabulation computer)'),
      h('p', null, 'Your access code:'),
      h('p', { class: 'code' }, judge.access_code),
    ))),
  );
}

function buildPages(state, results) {
  if (view === 'codes') return [codesPage(state)];

  const categoryId = filterId('category');
  const categories = results.categories.filter((result) => categoryId == null || result.category.id === categoryId);
  if (view === 'judge') {
    const judgeId = filterId('judge');
    return categories.flatMap((result) => result.judges
      .filter((judge) => judgeId == null || judge.id === judgeId)
      .map((judge) => judgePage(state, result, judge)));
  }
  return categories.map((result) => resultsPage(state, result));
}

async function main() {
  const toolbar = document.getElementById('toolbar');
  const pages = document.getElementById('pages');

  let state;
  let results;
  try {
    [state, results] = await Promise.all([request('GET', '/api/admin/state'), request('GET', '/api/admin/results')]);
  } catch (error) {
    pages.append(h('section', { class: 'page' }, h('p', null, error.message)));
    return;
  }

  const built = buildPages(state, results);
  const label = { results: 'Results', judge: 'Judge scoresheets', codes: 'Judge access slips' }[view] || 'Print';
  document.title = `${state.settings.event_name} - ${label}`;

  if (built.length === 0) {
    pages.append(h('section', { class: 'page' }, h('p', null, 'There is nothing to print for this selection.')));
  } else {
    pages.append(...built);
  }

  toolbar.append(
    h('span', { class: 'summary' }, `${label} · ${built.length} page${built.length === 1 ? '' : 's'}`),
    h('button', { class: 'btn', onclick: () => window.print() }, 'Print'),
    // Only the desktop app can write a PDF directly; in a browser, "Print" offers "Save as PDF".
    window.desktop && h('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const name = `${document.title.replace(/[^\w\- ]+/g, '').trim()}.pdf`;
          const outcome = await window.desktop.savePdf({ suggestedName: name, landscape: true });
          if (outcome.saved) toast(`Saved ${outcome.filePath}`, 'ok');
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    }, 'Save as PDF'),
    h('button', { class: 'btn', onclick: () => window.close() }, 'Close'),
  );
}

main();
