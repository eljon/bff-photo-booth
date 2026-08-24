import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { qrMatrix } from '../public/js/qr.mjs';

const digest = (matrix) =>
  crypto.createHash('sha256').update(matrix.map((row) => row.join('')).join('\n')).digest('hex').slice(0, 16);

// Golden matrices, verified module-for-module against the `qrcode` npm
// package (byte mode, versions 1-10, levels L and M) while this encoder was
// written. Any drift here means a scanner would read something different.
const GOLDEN = [
  ['http://192.168.1.42:8080', 'M', 25, '77143765ea46573b'],
  ['http://10.0.0.7:8080', 'L', 25, 'b4b8e20cf75ff4e3'],
  ['https://example.com', 'L', 25, 'c322e4ed0abc70dd'],
  ['A', 'M', 21, 'bc9009ae87ca68f1'],
];

test('encodes known payloads to the expected matrices', () => {
  for (const [text, ecc, size, hash] of GOLDEN) {
    const matrix = qrMatrix(text, { ecc });
    assert.equal(matrix.length, size, `${text} should be ${size} modules wide`);
    assert.equal(digest(matrix), hash, `${text} matrix changed`);
  }
});

test('every symbol carries the three finder patterns', () => {
  const matrix = qrMatrix('http://192.168.1.42:8080', { ecc: 'M' });
  const size = matrix.length;
  const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (const [row, col] of corners) {
    assert.equal(matrix[row][col], 1);
    assert.equal(matrix[row + 1][col + 1], 0);
    assert.equal(matrix[row + 3][col + 3], 1, 'finder core should be dark');
  }
  assert.equal(matrix[size - 8][8], 1, 'the always-dark module is missing');
});

test('timing patterns alternate', () => {
  const matrix = qrMatrix('http://192.168.1.42:8080', { ecc: 'M' });
  for (let i = 8; i < matrix.length - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0);
  }
});

test('grows through the versions it supports and refuses more', () => {
  assert.equal(qrMatrix('u'.repeat(20), { ecc: 'M' }).length, 25); // version 2
  assert.equal(qrMatrix('u'.repeat(120), { ecc: 'M' }).length, 45); // version 7
  assert.equal(qrMatrix('u'.repeat(250), { ecc: 'L' }).length, 57); // version 10
  assert.throws(() => qrMatrix('u'.repeat(400), { ecc: 'M' }), /too long/);
});
