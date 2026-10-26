'use strict';

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Guard against spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [[header, key], ...] */
function toCsv(rows, columns) {
  const lines = [columns.map(([h]) => cell(h)).join(',')];
  for (const row of rows) lines.push(columns.map(([, key]) => cell(row[key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv };
