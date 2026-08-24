// Minimal QR encoder (byte mode, versions 1–10, EC levels L and M).
// The booth runs on party Wi-Fi with no internet, so the host screen cannot
// pull a QR service — this generates the code locally in a few hundred lines.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

const bitLength = (value) => 32 - Math.clz32(value);

/** Polynomial division used by both the format and version info fields. */
function bchRemainder(value, generator) {
  const genBits = bitLength(generator);
  let rem = value;
  while (bitLength(rem) >= genBits) rem ^= generator << (bitLength(rem) - genBits);
  return rem;
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLength) {
  const gen = rsGenerator(ecLength);
  const buf = new Uint8Array(data.length + ecLength);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.slice(data.length);
}

// [ecCodewordsPerBlock, [ [blocks, dataCodewords], ... ] ]
const BLOCKS = {
  L: {
    1: [7, [[1, 19]]],
    2: [10, [[1, 34]]],
    3: [15, [[1, 55]]],
    4: [20, [[1, 80]]],
    5: [26, [[1, 108]]],
    6: [18, [[2, 68]]],
    7: [20, [[2, 78]]],
    8: [24, [[2, 97]]],
    9: [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]],
  },
  M: {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
  },
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const ECC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const dataCapacity = (version, ecc) =>
  BLOCKS[ecc][version][1].reduce((sum, [blocks, words]) => sum + blocks * words, 0);

function pickVersion(byteLength, ecc) {
  for (let version = 1; version <= 10; version++) {
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits) / 8) + byteLength;
    if (dataCapacity(version, ecc) >= needed) return version;
  }
  throw new Error('Text is too long for this QR encoder.');
}

function buildCodewords(bytes, version, ecc) {
  const capacity = dataCapacity(version, ecc) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (data.length < capacity / 8) data.push(pad[p++ % 2]);

  // Split into blocks, add error correction, then interleave both.
  const [ecLength, groups] = BLOCKS[ecc][version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [blockCount, words] of groups) {
    for (let i = 0; i < blockCount; i++) {
      const block = Uint8Array.from(data.slice(offset, offset + words));
      offset += words;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLength));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

function blankMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;
  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const edge = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = edge && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = edge && r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y][x] = ring || core ? 1 : 0;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    matrix[6][i] = bit;
    matrix[i][6] = bit;
  }

  const centers = ALIGNMENT[version];
  const last = centers[centers.length - 1];
  for (const row of centers) {
    for (const col of centers) {
      // Only the three that would sit on a finder are dropped; one that
      // crosses a timing line is still drawn, and wins.
      if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const outer = Math.max(Math.abs(r), Math.abs(c));
          matrix[row + r][col + c] = outer === 1 ? 0 : 1;
        }
      }
    }
  }

  matrix[size - 8][8] = 1; // the always-dark module

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === null) matrix[8][i] = 0;
    if (matrix[i][8] === null) matrix[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = 0;
  }

  if (version >= 7) {
    const bits = (version << 12) | bchRemainder(version << 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      matrix[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
      matrix[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
  }
}

function reservedMask(version, size) {
  const reserved = blankMatrix(size);
  placeFunctionPatterns(reserved, version);
  return reserved.map((row) => row.map((cell) => cell !== null));
}

function placeData(matrix, reserved, codewords) {
  const size = matrix.length;
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // the vertical timing column is not data
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (reserved[row][x]) continue;
        const byte = codewords[bitIndex >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        matrix[row][x] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix, reserved, maskIndex) {
  const out = matrix.map((row) => row.slice());
  for (let r = 0; r < out.length; r++) {
    for (let c = 0; c < out.length; c++) {
      if (!reserved[r][c] && MASKS[maskIndex](r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function placeFormat(matrix, ecc, maskIndex) {
  const size = matrix.length;
  const data = (ECC_BITS[ecc] << 3) | maskIndex;
  const bits = ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;

  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // Copy one: around the top-left finder.
    if (i < 6) matrix[i][8] = bit;
    else if (i === 6) matrix[7][8] = bit;
    else if (i === 7) matrix[8][8] = bit;
    else if (i === 8) matrix[8][7] = bit;
    else matrix[8][14 - i] = bit;
    // Copy two: split across the other two finders.
    if (i < 8) matrix[8][size - 1 - i] = bit;
    else matrix[size - 15 + i][8] = bit;
  }
}

function penalty(matrix) {
  const size = matrix.length;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let i = 0; i < size; i++) {
    score += runScore(matrix[i]);
    score += runScore(matrix.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  const hasPattern = (line, start) =>
    patterns.some((pattern) => pattern.every((bit, i) => line[start + i] === bit));
  for (let i = 0; i < size; i++) {
    const row = matrix[i];
    const col = matrix.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (hasPattern(row, j)) score += 40;
      if (hasPattern(col, j)) score += 40;
    }
  }

  const dark = matrix.flat().reduce((sum, bit) => sum + bit, 0);
  score += Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10) * 10;
  return score;
}

/** Encode text as a QR matrix of 0/1 rows. */
export function qrMatrix(text, { ecc = 'M' } = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecc);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, ecc);

  const base = blankMatrix(size);
  placeFunctionPatterns(base, version);
  const reserved = reservedMask(version, size);
  placeData(base, reserved, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, reserved, mask);
    placeFormat(candidate, ecc, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }
  return best.matrix;
}

/** Paint a matrix onto a canvas with a quiet zone. */
export function drawQr(canvas, matrix, { moduleSize = 8, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const size = (matrix.length + quiet * 2) * moduleSize;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = dark;
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) {
        ctx.fillRect((c + quiet) * moduleSize, (r + quiet) * moduleSize, moduleSize, moduleSize);
      }
    }
  }
  return canvas;
}
