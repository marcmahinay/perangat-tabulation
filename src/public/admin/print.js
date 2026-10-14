// Print views. Opened by the admin console as
//   print.html?view=results&category=<id|all>
//   print.html?view=judge&category=<id|all>&judge=<id|all>
//   print.html?view=codes
//   print.html?view=blank&category=<id|all>     empty sheets for scoring by hand

import { h, fmt, plain, localTime } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { toast } from '/shared/ui.js';
import { tieNotes, tieRemarks, tieGuidelines, judgeTieNotes } from '/shared/ties.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'results';

/** Reads an id filter from the query string; "all" or nothing means no filter. */
function filterId(name) {
  const value = params.get(name);
  return !value || value === 'all' ? null : Number(value);
}

// Rows printed on a blank sheet for a category that has no contingents entered yet.
const BLANK_ROWS = 10;

// The marks at the top of every sheet: government on the left, the event on the right.
const LOGOS = {
  government: [
    ['province-seal', 'Province of Misamis Occidental official seal'],
    ['bagong-pilipinas', 'Bagong Pilipinas'],
    ['asenso', 'Asenso Misamis Occidental'],
  ],
  event: [
    ['anniversary-97', '97th Provincial Anniversary'],
    ['perangat-festival', 'Përangat Festival'],
  ],
};

const logos = (group) => h('div', { class: `logos ${group}` },
  LOGOS[group].map(([file, alt]) => h('img', { src: `/shared/logos/${file}.png`, alt })));

function header(state, kind, title) {
  const { settings } = state;
  const meta = [settings.event_venue, settings.event_date].filter(Boolean).join(' · ');
  return h('header', { class: 'sheet-header' },
    logos('government'),
    h('div', { class: 'heading' },
      h('h1', null, settings.event_name),
      meta && h('p', { class: 'meta' }, meta),
      h('h2', null, title),
      h('p', { class: 'kind' }, kind),
    ),
    logos('event'),
  );
}

/** The contingents to list on a blank sheet, or empty lines when none are entered yet. */
function blankRows(result) {
  return result.rows.length
    ? result.rows.map((row) => row.contestant)
    : Array.from({ length: BLANK_ROWS }, () => ({ contestant_no: '', name: '' }));
}

/** A table with the contingents filled in and every other cell left empty for writing. */
function blankTable(result, headers) {
  return h('table', { class: 'sheet blank' },
    h('thead', null, h('tr', null, headers)),
    h('tbody', null, blankRows(result).map((contestant) => h('tr', null,
      h('td', { class: 'no' }, contestant.contestant_no),
      h('td', { class: 'name' }, contestant.name),
      headers.slice(2).map(() => h('td')),
    ))),
  );
}

function signature(name, role, detail) {
  return h('div', { class: 'signature' },
    h('div', { class: 'line' }, name || ' '),
    h('div', { class: 'role' }, role),
    detail && h('div', { class: 'detail' }, detail),
  );
}

const judgeName = (judge) => (judge.name === `Judge ${judge.judge_no}` ? '' : judge.name);

/** "Judge 2", or "Judge 2 · Chairman, Board of Judges" for the chairman. */
const judgeRole = (state, judge) =>
  (judge.id === state.chairmanJudgeId ? `Judge ${judge.judge_no} · Chairman, Board of Judges` : `Judge ${judge.judge_no}`);

/**
 * Who signs a category's overall results. The tabulator who prepared the sheet
 * signs on the left; the board of judges certifies it on the right, with the
 * chairman last.
 */
function resultSignatories(state, judges) {
  const chairman = judges.find((judge) => judge.id === state.chairmanJudgeId);
  const members = judges.filter((judge) => judge !== chairman);
  return h('div', { class: 'signatures arranged' },
    h('div', { class: 'sign-group' },
      h('p', { class: 'caption' }, 'Tabulated by:'),
      h('div', { class: 'sign-row' }, signature(state.settings.tabulator_name, 'Head of Tabulation Team')),
    ),
    judges.length > 0 && h('div', { class: 'sign-group' },
      h('p', { class: 'caption' }, 'Certified correct by the Board of Judges:'),
      h('div', { class: 'sign-row' },
        members.map((judge) => signature(judgeName(judge), `Judge ${judge.judge_no}`)),
        chairman && signature(judgeName(chairman), 'Chairman, Board of Judges'),
      ),
    ),
  );
}

/** Deductions are always taken from each judge's raw score for the contingent. */
function deductionSummary(row) {
  return row.deduction ? `${plain(row.deduction)} / judge` : fmt(0);
}

/**
 * Consolidated results of one category, best rank first. With `blank`, the same
 * sheet in order of performance with nothing filled in, for tabulating by hand.
 */
function resultsPage(state, result, { blank = false } = {}) {
  const { category, judges } = result;
  const showDeductions = Boolean(category.apply_deductions);
  const byRankSum = category.ranking_method === 'rank_sum';
  const rows = [...result.rows].sort((a, b) =>
    (a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)
    || a.contestant.contestant_no - b.contestant.contestant_no);

  const notes = tieNotes(result);
  const tied = tieRemarks(result);
  const tieRemark = (row) => {
    const remark = tied.get(row.contestant.id);
    return remark && [remark.label, remark.detail].filter(Boolean).join(': ');
  };
  const remarks = (row) => [row.placement, tieRemark(row), ...row.deductions.map((deduction) => deduction.name)]
    .filter(Boolean).join('; ');
  const dash = (value) => (value == null ? '–' : value);

  const th = (label, small) => h('th', null, label, small && h('small', null, small));
  // Sum-of-ranks sheets follow the festival's own layout: each judge's rank, then the total of the ranks.
  const rankSumHeaders = [
    th('No'), th('Name of contingent'),
    ...judges.map((judge) => th(`Judge ${judge.judge_no}`, 'rank')),
    th('Total'), th('Rank'), th('Remarks'),
    showDeductions && th('Deduction'),
  ].filter(Boolean);
  const averageHeaders = [
    ...judges.map((judge) => th(`Judge ${judge.judge_no}`)),
    showDeductions && th('Deduction'),
    th('Average score', plain(result.maxScore)),
  ].filter(Boolean);

  let table;
  if (blank) {
    table = blankTable(result, byRankSum
      ? rankSumHeaders
      : [th('No'), th('Name of contingent'), ...averageHeaders, th('Rank'), th('Remarks')]);
  } else if (byRankSum) {
    table = h('table', { class: 'sheet' },
      h('thead', null, h('tr', null, rankSumHeaders)),
      h('tbody', null, rows.map((row) => h('tr', { class: row.rank === 1 ? 'winner' : '' },
        h('td', { class: 'no' }, row.contestant.contestant_no),
        h('td', { class: 'name' }, row.contestant.name),
        judges.map((judge) => h('td', null, dash(row.judges[judge.id].rank))),
        h('td', { class: 'final' }, dash(row.rankSum)),
        h('td', { class: 'rank' }, dash(row.rank)),
        h('td', { class: 'remarks' }, remarks(row)),
        showDeductions && h('td', null, deductionSummary(row)),
      ))),
    );
  } else {
    table = h('table', { class: 'sheet' },
      h('thead', null, h('tr', null, th('Rank'), th('No'), th('Name of contingent'), averageHeaders, th('Remarks'))),
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
  }

  let kind = result.isFinal ? 'Official results' : 'Results';
  if (blank) kind = 'Tabulation sheet';

  return h('section', { class: 'page' },
    header(state, kind, category.name),
    !blank && !result.isFinal && h('div', { class: 'stamp' }, 'PROVISIONAL — NOT ALL JUDGES HAVE SUBMITTED THEIR SCORESHEETS'),
    !blank && result.isFinal && result.pendingVotes.length > 0
      && h('div', { class: 'stamp' }, 'NOT FINAL — A TIE IS WAITING FOR THE JUDGES\' VOTE'),
    table,
    !blank && notes.length > 0 && h('div', { class: 'notes ties' },
      h('h3', null, notes.length === 1 ? 'Tie in this category' : 'Ties in this category'),
      h('ul', null, notes.map((note) => h('li', null, note))),
    ),
    h('div', { class: 'notes' },
      h('h3', null, 'Tie-break guidelines'),
      h('ol', null, tieGuidelines(result).map((rule) => h('li', null, rule))),
    ),
    h('p', { class: 'footnote' },
      byRankSum
        ? "Each judge's final score is the raw score less deductions. Each judge ranks the contingents by final score; equal scores share the average of their places. Total = sum of the judges' ranks; the lowest total wins."
        : "Each judge's final score is the raw score" + (showDeductions ? ' less deductions' : '') + ". The highest average of the judges' final scores wins.",
      ` Printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    ),
    resultSignatories(state, judges),
  );
}

/**
 * One judge's detailed scoresheet for one category, in order of performance.
 * With `blank`, the same sheet with nothing filled in, for scoring by hand.
 */
function judgePage(state, result, judge, { blank = false } = {}) {
  const { category, criteria } = result;
  const showDeductions = Boolean(category.apply_deductions);
  const submitted = judge.status === 'submitted';
  // The judge's top contingent is highlighted. A tie for first has a fractional rank such as 1.5, so compare with the best rank given.
  const given = result.rows.map((row) => row.judges[judge.id].rank).filter((rank) => rank != null);
  const bestRank = given.length ? Math.min(...given) : null;
  const notes = judgeTieNotes(result, judge.id);

  const headers = [
    h('th', null, 'No'),
    h('th', null, 'Name of contingent'),
    ...criteria.map((criterion) => h('th', null, criterion.name, h('small', null, plain(criterion.weight)))),
    h('th', null, 'Total score', h('small', null, plain(result.maxScore))),
    showDeductions && h('th', null, 'Deduction'),
    showDeductions && h('th', null, 'Final score', h('small', null, plain(result.maxScore))),
    h('th', null, 'Rank'),
    h('th', null, 'Remarks'),
  ].filter(Boolean);

  if (blank) {
    return h('section', { class: 'page' },
      header(state, `Judge ${judge.judge_no} scoresheet`, category.name),
      blankTable(result, headers),
      h('p', { class: 'footnote' },
        'Write the points you give for each criterion, up to the maximum printed under its name. Up to two decimal places may be used. ',
        'Total score is the sum of the criteria. ',
        showDeductions
          ? 'Deduction, final score and rank are filled in by the tabulator.'
          : 'Rank is filled in by the tabulator.',
      ),
      h('div', { class: 'signatures' },
        signature(judgeName(judge), judgeRole(state, judge), 'Signature over printed name'),
        signature('', 'Date and time'),
      ),
    );
  }

  return h('section', { class: 'page' },
    header(state, `Judge ${judge.judge_no} scoresheet`, category.name),
    !submitted && h('div', { class: 'stamp' }, 'DRAFT — THIS SCORESHEET HAS NOT BEEN SUBMITTED'),
    h('table', { class: 'sheet' },
      h('thead', null, h('tr', null, headers)),
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
    notes.length > 0 && h('div', { class: 'notes ties' },
      h('h3', null, 'Equal scores on this sheet'),
      h('ul', null, notes.map((note) => h('li', null, note))),
    ),
    h('p', { class: 'footnote' },
      submitted ? `Submitted ${localTime(judge.submitted_at)}.` : 'Not yet submitted.',
      ` Printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`,
    ),
    h('div', { class: 'signatures' }, signature(judgeName(judge), judgeRole(state, judge))),
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
  // Per category: one empty scoresheet for each judge to sign, then the empty tabulation sheet.
  if (view === 'blank') {
    return categories.flatMap((result) => [
      ...result.judges.map((judge) => judgePage(state, result, judge, { blank: true })),
      resultsPage(state, result, { blank: true }),
    ]);
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
  const label = { results: 'Results', judge: 'Judge scoresheets', codes: 'Judge access slips', blank: 'Blank sheets' }[view] || 'Print';
  document.title = `${state.settings.event_name} - ${label}`;

  if (built.length === 0) {
    pages.append(h('section', { class: 'page' }, h('p', null, 'There is nothing to print for this selection.')));
  } else {
    pages.append(...built);
  }

  toolbar.append(...[
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
  ].filter(Boolean));
}

main();
