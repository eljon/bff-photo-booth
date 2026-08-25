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
  // Zero media margins = the IPP borderless request (works on driverless/AirPrint queues).
  assert.equal(borderless['media-left-margin'], '0');
  assert.equal(borderless['media-right-margin'], '0');
  assert.equal(borderless['media-top-margin'], '0');
  assert.equal(borderless['media-bottom-margin'], '0');
  assert.equal(borderless['fit-to-page'], undefined); // borderless wins over fit-to-page

  const bordered = cups.buildPrintOptions({ borderless: false, fitToPage: true });
  assert.equal(bordered['fit-to-page'], 'true');
  assert.equal(bordered['print-scaling'], undefined);

  const plain = cups.buildPrintOptions({ borderless: false, fitToPage: false });
  assert.equal(plain['print-scaling'], undefined);
  assert.equal(plain['fit-to-page'], undefined);
});

test('flags borderless page sizes across the many driver spellings', () => {
  for (const id of ['4x6.FullBleed', '4x6.bl', 'om_borderless-4x6_4x6in', 'w288h432.fb', '4x6 Borderless', 'Frameless_4x6']) {
    assert.equal(cups.isBorderlessMedia(id), true, `${id} should be borderless`);
  }
  for (const id of ['4x6', 'Custom.4x6in', 'Letter', 'A4', 'w288h432']) {
    assert.equal(cups.isBorderlessMedia(id), false, `${id} should NOT be borderless`);
  }
});

test('reads a printer\'s page sizes from lpoptions output, marking default + borderless', () => {
  const out = [
    'PageSize/Media Size: Letter Legal A4 4x6 *4x6.FullBleed 5x7',
    'ColorModel/Color Mode: *RGB Gray',
  ].join('\n');
  const opts = cups.parseMediaOptions(out);
  assert.deepEqual(opts.map((o) => o.id), ['Letter', 'Legal', 'A4', '4x6', '4x6.FullBleed', '5x7']);
  const fb = opts.find((o) => o.id === '4x6.FullBleed');
  assert.equal(fb.isDefault, true);
  assert.equal(fb.borderless, true);
  assert.equal(opts.find((o) => o.id === '4x6').borderless, false);
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
