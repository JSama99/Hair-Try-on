import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/tryon.js';
import { validLook, encodeLook, decodeLook, lookFromHash, lookUrl, lookLabel, readLookbook, addToLookbook, removeFromLookbook, clearLookbook, LOOKBOOK_KEY, LOOKBOOK_MAX } from '../src/look-link.js';

const LOOK = { style: 'knotless_braids', size: 'medium', length: 'armpit', color: '1B/27' };
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('every unlocked catalog look round-trips through a link', () => {
  let n = 0;
  for (const style of T.STYLES) for (const size of style.sizes) for (const len of T.LENGTHS) for (const color of T.COLORS) {
    const look = { style: style.id, size: size.id, length: len.id, color: color.id };
    if (len.requiresBody) { assert.equal(validLook(look), null); assert.throws(() => encodeLook(look)); continue; }
    assert.deepEqual(decodeLook(encodeLook(look)), look);
    n++;
  }
  assert.ok(n > 500);
});

test('a link holds four catalog ids and nothing else', () => {
  const enc = encodeLook({ ...LOOK, notes: 'call me on 555 0100', photo: 'data:image/png;base64,AAAA', preferredDay: 'sat' });
  assert.equal(enc, '1~knotless_braids~medium~armpit~1B%2F27');
  const url = lookUrl(LOOK, 'https://salon.example/tryon/?utm=1&name=Ada#old');
  assert.equal(url, 'https://salon.example/tryon/#look=1~knotless_braids~medium~armpit~1B%2F27');
  assert.ok(!url.includes('?'), 'query parameters are dropped: the look lives in the fragment only');
});

test('pages without a web address have no link', () => {
  assert.equal(lookUrl(LOOK, 'file:///home/x/index.html'), null);
  assert.equal(lookUrl(LOOK, 'about:srcdoc'), null);
  assert.equal(lookUrl(LOOK, 'not a url'), null);
});

test('hostile or stale links are refused', () => {
  for (const bad of ['', '1~knotless_braids~medium~waist~1B', '1~knotless_braids~medium~mid_back~1B', '2~knotless_braids~medium~armpit~1B',
    '1~nope~medium~armpit~1B', '1~locs~jumbo~armpit~1B', '1~knotless_braids~medium~armpit~purple', '1~knotless_braids~medium~armpit',
    '1~knotless_braids~medium~armpit~1B~extra', '1~%E0%A4%A~medium~armpit~1B', '1~<script>~medium~armpit~1B', 'x'.repeat(500), null, 42]) {
    assert.equal(decodeLook(bad), null, String(bad).slice(0, 40));
  }
  assert.equal(validLook({ style: 'knotless_braids', size: 'medium', length: 'armpit', color: { toString: () => '1B' } }), null);
});

test('lookFromHash finds the look among other fragment parameters', () => {
  assert.deepEqual(lookFromHash('#look=1~locs~medium~chin~30'), { style: 'locs', size: 'medium', length: 'chin', color: '30' });
  assert.deepEqual(lookFromHash('#a=1&look=1~locs~medium~chin~30&b=2'), { style: 'locs', size: 'medium', length: 'chin', color: '30' });
  assert.equal(lookFromHash('#outlook=1~locs~medium~chin~30'), null);
  assert.equal(lookFromHash(''), null);
});

test('label uses catalog names', () => {
  assert.equal(lookLabel(LOOK), 'Knotless braids · Medium · Armpit · 1B/27');
});

test('lookbook: add, dedupe, newest first, remove, clear', () => {
  const s = memory();
  assert.deepEqual(readLookbook(s), []);
  assert.equal(addToLookbook(s, LOOK).added, true);
  assert.equal(addToLookbook(s, { ...LOOK }).added, false);
  const second = { style: 'locs', size: 'medium', length: 'chin', color: '30' };
  assert.deepEqual(addToLookbook(s, second).looks, [second, LOOK]);
  assert.deepEqual(removeFromLookbook(s, LOOK), [second]);
  assert.deepEqual(clearLookbook(s), []);
  assert.equal(s.getItem(LOOKBOOK_KEY), null);
});

test('lookbook stores only the four ids, is capped, and survives corrupt or hostile storage', () => {
  const s = memory();
  addToLookbook(s, { ...LOOK, notes: 'secret', image: 'data:image/png;base64,AAAA' });
  assert.equal(s.getItem(LOOKBOOK_KEY), JSON.stringify([LOOK]));
  let i = 0;
  for (const style of T.STYLES) for (const color of T.COLORS) {
    if (i++ > 40) break;
    addToLookbook(s, { style: style.id, size: style.defaultSize, length: 'chin', color: color.id });
  }
  assert.equal(readLookbook(s).length, LOOKBOOK_MAX);
  assert.equal(addToLookbook(s, { style: 'cornrows', size: 'small', length: 'shoulder', color: '613' }).full, true);
  for (const junk of ['{', 'null', '"x"', '[1,2,{"style":"x"}]', JSON.stringify([{ ...LOOK, length: 'waist' }])]) {
    s.setItem(LOOKBOOK_KEY, junk);
    assert.deepEqual(readLookbook(s), []);
  }
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(readLookbook(throwing), []);
  assert.equal(addToLookbook(throwing, LOOK).added, false);
  assert.deepEqual(clearLookbook(throwing), []);
  assert.equal(addToLookbook(null, LOOK).added, false);
});
