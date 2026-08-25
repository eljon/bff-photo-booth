import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cups = require('../server/cups.js');

test('recognises a printer while it is mid-print (not just idle)', () => {
  const out = [
    'printer Canon_G4010_series now printing Canon_G4010_series-42.  enabled since Sun Aug 24 10:00:00 2025',
    'system default destination: Canon_G4010_series',
  ].join('\n');

  const { printers, default: fallback } = cups.parsePrinters(out);
  assert.equal(printers.length, 1);
  assert.equal(printers[0].name, 'Canon_G4010_series');
  assert.equal(printers[0].state, 'printing');
  assert.equal(printers[0].ready, true);
  assert.equal(fallback, 'Canon_G4010_series');
});

test('borderless prints fill the sheet; otherwise fit-to-page applies', () => {
  const borderless = cups.buildPrintOptions({ borderless: true, fitToPage: true });
  assert.equal(borderless['print-scaling'], 'fill');
  assert.equal(borderless['fit-to-page'], undefined); // borderless wins over fit-to-page

  const bordered = cups.buildPrintOptions({ borderless: false, fitToPage: true });
  assert.equal(bordered['fit-to-page'], 'true');
  assert.equal(bordered['print-scaling'], undefined);

  const plain = cups.buildPrintOptions({ borderless: false, fitToPage: false });
  assert.equal(plain['print-scaling'], undefined);
  assert.equal(plain['fit-to-page'], undefined);
});

test('parses idle, printing, and disabled printers together', () => {
  const out = [
    'printer A is idle.  enabled since Sun Aug 24 10:00:00 2025',
    'printer B now printing B-7.  enabled since Sun Aug 24 10:00:00 2025',
    'printer C disabled since Sun Aug 24 10:00:00 2025 -',
    'system default destination: B',
  ].join('\n');

  const { printers, default: fallback } = cups.parsePrinters(out);
  const byName = Object.fromEntries(printers.map((p) => [p.name, p]));

  assert.deepEqual(Object.keys(byName).sort(), ['A', 'B', 'C']);
  assert.equal(byName.A.state, 'idle');
  assert.equal(byName.A.ready, true);
  assert.equal(byName.B.state, 'printing');
  assert.equal(byName.B.ready, true);
  assert.equal(byName.C.state, 'disabled');
  assert.equal(byName.C.ready, false);
  assert.equal(fallback, 'B'); // a mid-print default is still resolvable
});
