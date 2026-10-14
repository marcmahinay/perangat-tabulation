'use strict';

// Reads a phone photo of a judge's handwritten scoresheet with Claude.
//
// Nothing read from a photo is ever saved directly: the numbers come back to
// the encoder's screen as proposals, each checked here against the criterion's
// maximum and the total the judge wrote, and the encoder corrects and saves them.

const { default: Anthropic } = require('@anthropic-ai/sdk');
const { HttpError } = require('./errors');

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You read photos of handwritten judges' scoresheets from a dance contest and report exactly what is written.

The sheet is a printed table. Each row is a contingent, identified by the number in its "No" column and its printed name. Each criterion column has its maximum printed under its name. The judge has written a score by hand in each cell, and usually a total in the "Total score" column.

Rules:
- Report what is written, not what you think the judge meant. Never compute, round or correct a score.
- A cell that is empty, crossed out with no replacement, or that you cannot read is null, and its column index goes in "unclear" if anything is written there.
- If a value was crossed out and rewritten, report the rewritten value and list the column in "unclear".
- Decimals are written with a point or a comma; report them as numbers (32.5).
- Columns are numbered from 0 in the order given to you, ignoring the No, name, total and any other printed columns.
- List the rows in the order they appear on the sheet, using the contingent number printed in the No column.`;

/** The JSON shape Claude must answer in. */
const SCHEMA = {
  type: 'object',
  properties: {
    sheet_heading: { type: 'string', description: 'The category and judge printed at the top of the sheet, as written.' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          contestant_no: { type: 'integer' },
          scores: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
          total_written: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          unclear: { type: 'array', items: { type: 'integer' } },
        },
        required: ['contestant_no', 'scores', 'total_written', 'unclear'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string', description: 'Anything the encoder should check, such as a torn or blurred part of the sheet. Empty if none.' },
  },
  required: ['sheet_heading', 'rows', 'notes'],
  additionalProperties: false,
};

function describeLayout(layout) {
  const columns = layout.criteria.map((criterion, index) => `${index}: ${criterion.name} (maximum ${criterion.weight})`);
  const rows = layout.contestants.map((contestant) => `${contestant.contestant_no}. ${contestant.name}`);
  return [
    `This should be the scoresheet of Judge ${layout.judge.judge_no} for ${layout.category.name}.`,
    `Criterion columns, in order:\n${columns.join('\n')}`,
    `Contingents expected on the sheet:\n${rows.join('\n')}`,
    'Read every row you can see and return the scores.',
  ].join('\n\n');
}

/** "data:image/jpeg;base64,...." -> { mediaType, data } */
function parseDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) throw new HttpError(400, 'The photo must be a JPEG, PNG, WebP or GIF image.');
  return { mediaType: match[1], data: match[2] };
}

/**
 * Returns `read(image, layout)`, which asks Claude to read the photo and
 * resolves to its raw answer in the SCHEMA shape. `apiKey()` is read on every
 * call, so a key entered in the admin console takes effect at once.
 */
function createSheetReader({ apiKey, createClient = (key) => new Anthropic({ apiKey: key, timeout: 120000 }) }) {
  return async function read(image, layout) {
    const key = apiKey();
    if (!key) {
      throw new HttpError(503, 'Reading photos is not set up. On the tabulation computer, open Encoding and enter a Claude API key, or type the scores in.');
    }
    const { mediaType, data } = parseDataUrl(image);

    let response;
    try {
      response = await createClient(key).beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // Reading handwriting where a misread digit changes a ranking is worth the extra thinking.
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        // If the model declines, retry on the fallback Anthropic recommends rather than failing the scan.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: describeLayout(layout) },
          ],
        }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new HttpError(502, 'The Claude API key was refused. Check it on the tabulation computer under Encoding.');
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new HttpError(503, 'The photo reader is busy. Wait a minute and try again.');
      }
      if (error instanceof Anthropic.BadRequestError) {
        throw new HttpError(422, `The photo could not be read: ${error.message}`);
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new HttpError(503, 'The tabulation computer cannot reach the internet, which reading photos needs. Type the scores in instead.');
      }
      if (error instanceof Anthropic.APIError) {
        throw new HttpError(502, `The photo reader failed (${error.status || 'no status'}). Try again, or type the scores in.`);
      }
      throw error;
    }

    if (response.stop_reason === 'refusal') {
      throw new HttpError(422, 'The photo reader declined this image. Type the scores in instead.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new HttpError(502, 'The photo reader stopped before finishing. Try again with a photo of one sheet only.');
    }
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'The photo reader gave an answer that could not be understood. Try again.');
    }
  };
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Checks Claude's reading against the sheet it should be and turns it into
 * proposals for the encoder's screen. Pure, so every rule is unit tested.
 *
 * Returns { cells: [{ contestantId, criterionId, value, problem }], warnings, heading, notes }.
 * `value` is null when nothing usable was read; `problem` says why a cell needs a look.
 */
function interpretScan(raw, layout) {
  const byNumber = new Map(layout.contestants.map((contestant) => [contestant.contestant_no, contestant]));
  const warnings = [];
  const cells = [];
  const seen = new Set();

  for (const row of Array.isArray(raw.rows) ? raw.rows : []) {
    const contestant = byNumber.get(row.contestant_no);
    if (!contestant) {
      warnings.push(`The photo has a row numbered ${row.contestant_no}, which is not a contingent in this category. It was ignored.`);
      continue;
    }
    if (seen.has(contestant.id)) {
      warnings.push(`Contingent ${contestant.contestant_no} appears twice on the photo. Only the first row was used.`);
      continue;
    }
    seen.add(contestant.id);

    const unclear = new Set(Array.isArray(row.unclear) ? row.unclear : []);
    let sum = 0;
    let complete = true;
    layout.criteria.forEach((criterion, index) => {
      const read = Array.isArray(row.scores) ? row.scores[index] : null;
      let value = typeof read === 'number' && Number.isFinite(read) ? read : null;
      let problem = null;
      if (value != null && value < 0) {
        problem = `Read as ${value}, which is below zero.`;
        value = null;
      } else if (value != null && value > criterion.weight) {
        problem = `Read as ${value}, above the maximum of ${criterion.weight}.`;
        value = null;
      } else if (value != null && round2(value) !== value) {
        problem = `Read as ${value}; scores have at most two decimals.`;
        value = round2(value);
      } else if (unclear.has(index)) {
        problem = value == null ? 'Something is written here that could not be read.' : 'Hard to read on the photo. Check it.';
      }
      if (value == null) complete = false;
      else sum += value;
      cells.push({ contestantId: contestant.id, criterionId: criterion.id, value, problem });
    });

    if (complete && typeof row.total_written === 'number' && round2(sum) !== round2(row.total_written)) {
      warnings.push(`Contingent ${contestant.contestant_no} (${contestant.name}): the scores add up to ${round2(sum)}, but the judge wrote a total of ${row.total_written}. Check that row.`);
    }
  }

  const missing = layout.contestants.filter((contestant) => !seen.has(contestant.id));
  if (missing.length) {
    warnings.push(`Not found on the photo: ${missing.map((contestant) => `${contestant.contestant_no}. ${contestant.name}`).join(', ')}.`);
  }

  return {
    cells,
    warnings,
    heading: typeof raw.sheet_heading === 'string' ? raw.sheet_heading : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

module.exports = { createSheetReader, interpretScan, parseDataUrl, SCHEMA, MODEL };
