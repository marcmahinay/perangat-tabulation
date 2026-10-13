'use strict';

const { HttpError } = require('./errors');
const { roundTo } = require('./scoring');

function text(value, label, { max = 200, required = true } = {}) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out && required) throw new HttpError(400, `${label} is required.`);
  if (out.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return out;
}

function number(value, label, { min = -Infinity, max = Infinity, integer = false, decimals = null } = {}) {
  let out = NaN;
  if (typeof value === 'number') out = value;
  else if (typeof value === 'string' && value.trim() !== '') out = Number(value);

  if (!Number.isFinite(out)) throw new HttpError(400, `${label} must be a number.`);
  if (integer && !Number.isInteger(out)) throw new HttpError(400, `${label} must be a whole number.`);
  if (out < min) throw new HttpError(400, `${label} must be at least ${min}.`);
  if (out > max) throw new HttpError(400, `${label} must be at most ${max}.`);
  if (decimals != null && roundTo(out, decimals) !== out) {
    throw new HttpError(400, `${label} can have at most ${decimals} decimal places.`);
  }
  return out;
}

const id = (value, label = 'ID') => number(value, label, { integer: true, min: 1 });

function idList(value, label) {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list.`);
  return [...new Set(value.map((entry) => id(entry, label)))];
}

function oneOf(value, label, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

module.exports = { text, number, id, idList, oneOf };
