/**
 * Reading somebody's own spreadsheet.
 *
 * These are the shapes a real shop's sheet actually has: a product called
 * "Jacket, black", a header in Chinese, an amount written NT$1,280, a blank row
 * somebody left in the middle. Each of them destroys a naive parse, and each of
 * them turns into a number somebody would act on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, findColumn, toNumber, parseSheetUrl } from '../runtime/sheets.js';

describe('CSV as shops actually write it', () => {
  test('a comma inside quotes is part of the value, not a new column', () => {
    const rows = parseCsv('name,price\n"Jacket, black",1280\n');
    assert.deepEqual(rows[1], ['Jacket, black', '1280']);
  });

  test('a doubled quote is one quote', () => {
    const rows = parseCsv('note\n"she said ""fits"" and kept it"\n');
    assert.equal(rows[1][0], 'she said "fits" and kept it');
  });

  test('a newline inside quotes stays inside the cell', () => {
    const rows = parseCsv('note,total\n"line one\nline two",99\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], 'line one\nline two');
    assert.equal(rows[1][1], '99');
  });

  test('carriage returns from a Windows export do not become content', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    assert.deepEqual(rows[1], ['1', '2']);
  });

  test('a last line without a newline is still a row', () => {
    assert.equal(parseCsv('a,b\n1,2').length, 2);
  });
});

describe('finding the column somebody meant', () => {
  const headers = ['訂單日期', '商品', '訂單金額', 'note'];

  test('a Chinese header is found by a Chinese name', () => {
    assert.equal(findColumn(headers, ['revenue', 'total', '訂單金額']), '訂單金額');
  });

  test('an exact match beats a partial one', () => {
    // "total" must not win "subtotal" when a plain "total" is there.
    const h = ['subtotal', 'total', 'grand total'];
    assert.equal(findColumn(h, ['total']), 'total');
  });

  test('case and spacing do not matter', () => {
    assert.equal(findColumn(['Order Total'], ['ordertotal']), 'Order Total');
  });

  test('nothing plausible returns nothing rather than the first column', () => {
    // Guessing here would put a date where money should be and report it as
    // revenue, which is exactly the number somebody acts on.
    assert.equal(findColumn(['name', 'colour'], ['revenue', 'total']), null);
  });
});

describe('numbers as people type them', () => {
  test('currency and thousands separators come off', () => {
    assert.equal(toNumber('NT$1,280'), 1280);
    assert.equal(toNumber('$1,280.50'), 1280.5);
    assert.equal(toNumber('1 280'), 1280);
  });

  test('a negative stays negative', () => {
    assert.equal(toNumber('-450'), -450);
  });

  test('blank and unparseable are null, never zero', () => {
    // Zero is a fact about a day's trading. Absence is not, and reporting one
    // as the other quietly drags every average down.
    for (const v of ['', '   ', 'n/a', '-', undefined, null]) {
      assert.equal(toNumber(v), null, `${JSON.stringify(v)} should be null`);
    }
  });
});

describe('the link people paste', () => {
  test('an ordinary edit link with a tab', () => {
    const { id, gid } = parseSheetUrl(
      'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=42');
    assert.equal(id, '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
    assert.equal(gid, '42');
  });

  test('anything that is not a sheet is refused before it is fetched', () => {
    for (const bad of ['https://example.com/sheet', 'https://docs.google.com/document/d/abc/edit']) {
      assert.throws(() => parseSheetUrl(bad));
    }
  });
});
