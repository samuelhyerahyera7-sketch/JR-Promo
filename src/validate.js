'use strict';

const { HttpError } = require('./auth');

/** Small input helpers; each throws a 400 with a readable message. */

function str(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

function int(value, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number`);
  if (n < min) throw new HttpError(400, `${field} must be at least ${min}`);
  if (n > max) throw new HttpError(400, `${field} must be at most ${max}`);
  return n;
}

function num(value, field, { required = false, min = -Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  if (n < min) throw new HttpError(400, `${field} must be at least ${min}`);
  return n;
}

function oneOf(value, field, options, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (!options.includes(value)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}

function date(value, field, { required = false } = {}) {
  const s = str(value, field, { required, max: 10 });
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  return s;
}

function email(value, field, opts) {
  const s = str(value, field, opts);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${field} must be a valid email`);
  return s;
}

function items(value, field = 'items') {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, `Add at least one product to ${field}`);
  return value;
}

/**
 * Optional phone GPS position {lat, lng, accuracy} (accuracy in metres).
 * Returns nulls when absent so callers can store it straight away.
 */
function geo(value) {
  if (value === undefined || value === null || value === '') return { lat: null, lng: null, accuracy: null };
  const lat = num(value.lat, 'Latitude', { required: true, min: -90 });
  const lng = num(value.lng, 'Longitude', { required: true, min: -180 });
  if (lat > 90 || lng > 180) throw new HttpError(400, 'Location is out of range');
  const accuracy = num(value.accuracy, 'Location accuracy', { min: 0 });
  return { lat, lng, accuracy: accuracy === null ? null : Math.round(accuracy) };
}

/** Throws 404 when a row lookup came back empty. */
function found(row, what) {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
}

module.exports = { str, int, num, oneOf, date, email, items, found, geo };
