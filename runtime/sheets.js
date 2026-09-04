/**
 * Reading a spreadsheet somebody already keeps.
 *
 * The workforce could see competitors and not the business it belonged to,
 * which is a strange kind of assistant. Most small commerce operations already
 * keep orders, stock and ad spend in a Google Sheet, so the shortest path to a
 * tool that reads real numbers is to read that.
 *
 * No OAuth. A sheet shared as "anyone with the link can view" serves CSV from
 * an export endpoint, and that is the whole integration.
 *
 * The trade is worth stating plainly rather than burying: link sharing means
 * anybody holding the link can read the sheet, us included. That is fine for a
 * tab of yesterday's totals and wrong for anything with names or card details
 * in it. A proper OAuth flow is the answer for private data and is not this.
 */

import { fetchPublicPage } from './web.js';

const ID = /\/spreadsheets\/d\/([\w-]{20,})/;
const GID = /[#&?]gid=(\d+)/;

/** Pull the document id and tab out of whatever form of link was pasted. */
export function parseSheetUrl(input) {
  const url = new URL(input);
  if (!/(^|\.)google\.com$/.test(url.hostname)) {
    throw new Error('that is not a Google Sheets link');
  }
  const id = ID.exec(url.pathname)?.[1];
  if (!id) throw new Error('no spreadsheet id in that link');
  const gid = GID.exec(url.hash + url.search)?.[1] ?? null;
  return { id, gid };
}

/**
 * @returns {{headers: string[], rows: object[], count: number}}
 */
export async function readSheet(input) {
  const { id, gid } = parseSheetUrl(input);
  const target = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv` +
    (gid ? `&gid=${gid}` : '');

  const res = await fetchPublicPage(target);

  // A sheet that is not shared answers with a sign-in page rather than an
  // error, so the failure has to be recognised by shape or it reads as a
  // spreadsheet full of HTML.
  if (/^\s*</.test(res.html) || res.html.includes('<!DOCTYPE')) {
    throw new Error('that sheet is not shared. Set it to "anyone with the link can view".');
  }

  const table = parseCsv(res.html);
  if (!table.length) return { headers: [], rows: [], count: 0 };

  const headers = table[0].map((h, i) => h.trim() || `column ${i + 1}`);
  const rows = table.slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));

  return { headers, rows, count: rows.length };
}

/**
 * CSV, done properly rather than by splitting on commas.
 *
 * A product called "Jacket, black" and a note containing a newline are both
 * ordinary things to find in a shop's spreadsheet, and both destroy a naive
 * split. Quotes double to escape themselves.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Find the column that holds a thing, given the names people actually use.
 *
 * A shop's own spreadsheet says "訂單金額" or "Total" or "amount", never the one
 * name a schema would have picked. Guessing is better than demanding, as long
 * as the guess is reported so a wrong column can be seen rather than trusted.
 */
export function findColumn(headers, candidates) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
  const wanted = candidates.map(norm);
  for (const h of headers) {
    const n = norm(h);
    if (wanted.some((w) => n === w)) return h;
  }
  for (const h of headers) {
    const n = norm(h);
    if (wanted.some((w) => n.includes(w))) return h;
  }
  return null;
}

/** A number out of a cell that might be "NT$1,280" or "1 280.50" or blank. */
export function toNumber(cell) {
  if (cell === undefined || cell === null) return null;
  const cleaned = String(cell).replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
