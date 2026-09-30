// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Generates the photograph fixtures used by image-photo-e2e.browser.test.mjs.
//
// The fixtures are rendered with a real browser canvas rather than a
// hand-rolled PNG encoder so the text is anti-aliased the way a real
// photographed document is. Tesseract's accuracy on a synthetic glyph-per-pixel
// bitmap is not representative, and a fixture that is unrealistically easy would
// make the E2E test meaningless.
//
// The PII is deliberately synthetic and non-routable:
//   SSN   219-09-9999     (invalid: 999-99-9999 is never issued)
//   card  4111111111111111 (valid Luhn, but a documented test number)
//   email test.person@example.test (.test is reserved by RFC 2606)
// No real person's data is used anywhere in this repository.
//
// Region boxes are MEASURED from the rendered glyph metrics, never hand-written.
// Each value's x position depends on the rendered width of its label prefix, so
// a guessed box silently drifts and the E2E then "fails" against a rectangle the
// text was never in.
//
// Run: node scripts/make-photo-fixtures.mjs
import { chromium } from '@playwright/test';
import { browserChannelArgs } from './browser-launch.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'tests', 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

const WIDTH = 1240;
const HEIGHT = 1754; // ~A4 at 150dpi, a plausible phone photo of a document
const FONT = '"DejaVu Sans", "Liberation Sans", Arial, sans-serif';
const MARGIN = 150;

/**
 * Sensitive values, drawn as "<label><value>" on one line.
 *
 * `key` ties a value to the region the E2E asserts on, and `category` is the
 * detector class that is expected to fire.
 */
const PII_FIELDS = [
  { key: 'ssn', label: 'Social Security Number: ', value: '219-09-9999', y: 470, size: 30, category: 'ssn' },
  { key: 'dob', label: 'Date of Birth: ', value: '03/14/1975', y: 540, size: 30, category: 'dob' },
  { key: 'email', label: 'Contact Email: ', value: 'test.person@example.test', y: 610, size: 30, category: 'email' },
  { key: 'phone', label: 'Phone: ', value: '210-555-0147', y: 680, size: 30, category: 'phone' },
  { key: 'member_id', label: 'Insurance Member ID: ', value: '4471-8820-33', y: 750, size: 30, category: 'member_id' }
];

// Prose that must survive redaction untouched is declared inline in the block
// list below with `keep: '<label>'`. Those lines deliberately contain nothing a
// detector could reasonably claim is sensitive: no names, no numbers, no
// contact details. A name-like string there would be flagged and redacted for
// good reason, which would make the assertion wrong rather than the code.

const ORDINARY_LINES = [
  { text: 'Community Garden Newsletter', x: MARGIN, y: 220, size: 44, weight: 700 },
  { text: 'Spring 2026', x: MARGIN, y: 280, size: 28 },
  { text: 'This month the volunteers planted tomatoes,', x: MARGIN, y: 400, size: 30 },
  { text: 'herbs, and a row of marigolds along the', x: MARGIN, y: 450, size: 30 },
  { text: 'south fence. The bees arrived early.', x: MARGIN, y: 500, size: 30 },
  { text: 'Saturday work days begin at nine.', x: MARGIN, y: 600, size: 30 },
  { text: 'Bring gloves. We have spare tools.', x: MARGIN, y: 650, size: 30 },
  { text: 'The shed roof was repaired in March.', x: MARGIN, y: 750, size: 30 },
  { text: 'Watering rota is pinned inside the door.', x: MARGIN, y: 800, size: 30 }
];

/**
 * Draws the document and returns the PNG plus the measured ink box of every
 * value and keep region. Blocks are drawn in order, so a section heading can sit
 * between fields in the same pass.
 */
async function renderDocument({ background, blocks, noise }) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  const result = await page.evaluate(
    ({ background, blocks, noise, width, height, margin, font }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      if (noise) {
        // Deterministic speckle so the fixture is not a pristine synthetic
        // bitmap. Seeded, not random, so the fixture is reproducible.
        let seed = 1337;
        const rand = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x7fffffff;
        };
        for (let i = 0; i < 9000; i++) {
          const x = rand() * width;
          const y = rand() * height;
          const g = 200 + Math.floor(rand() * 40);
          ctx.fillStyle = `rgba(${g},${g},${g},0.35)`;
          ctx.fillRect(x, y, 1.4, 1.4);
        }
      }

      ctx.fillStyle = '#141414';
      ctx.textBaseline = 'alphabetic';
      const setFont = (size, weight) => {
        ctx.font = `${weight ?? 400} ${size}px ${font}`;
      };

      /**
       * Ink box of `text` drawn at (x, baselineY) in the CURRENT font, from real
       * glyph metrics rather than an assumed line box.
       */
      const inkBox = (text, x, baselineY) => {
        const m = ctx.measureText(text);
        const ascent = m.actualBoundingBoxAscent ?? 0;
        const descent = m.actualBoundingBoxDescent ?? 0;
        // The ink runs from (x - actualBoundingBoxLeft) to (x + actualBoundingBoxRight).
        // m.width is the ADVANCE, which already spans the whole string, so adding
        // it on top of the bounding boxes would double-count and report a region
        // about twice as wide as the glyphs actually are.
        const left = m.actualBoundingBoxLeft ?? 0;
        const right = m.actualBoundingBoxRight ?? m.width;
        return {
          x: Math.round(x - left),
          y: Math.round(baselineY - ascent),
          width: Math.round(left + right),
          height: Math.round(ascent + descent)
        };
      };

      const measured = { regions: [], mustRemainUnchanged: [] };
      for (const b of blocks) {
        setFont(b.size, b.weight);
        if (b.kind === 'line') {
          ctx.fillText(b.text, margin, b.y);
          if (b.keep) measured.mustRemainUnchanged.push({ label: b.keep, ...inkBox(b.text, margin, b.y) });
        } else {
          const labelWidth = ctx.measureText(b.label).width;
          ctx.fillText(b.label + b.value, margin, b.y);
          measured.regions.push({
            label: b.key,
            category: b.category,
            text: b.value,
            ...inkBox(b.value, margin + labelWidth, b.y)
          });
        }
      }

      return { dataUrl: canvas.toDataURL('image/png'), measured };
    },
    { background, blocks, noise, width: WIDTH, height: HEIGHT, margin: MARGIN, font: FONT }
  );
  await page.close();
  return { png: Buffer.from(result.dataUrl.split(',')[1], 'base64'), measured: result.measured };
}

const browser = await chromium.launch({ ...browserChannelArgs() });

const pii = await renderDocument({
  background: '#f7f5f0',
  noise: true,
  blocks: [
    { kind: 'line', text: 'ACME HEALTH SERVICES', y: 200, size: 44, weight: 700 },
    { kind: 'line', text: 'PATIENT INTAKE SUMMARY', y: 260, size: 28 },
    { kind: 'line', text: 'Patient Name: TEST PERSON', y: 400, size: 30 },
    ...PII_FIELDS.map((f) => ({ kind: 'field', ...f })),
    { kind: 'line', text: 'Billing', y: 900, size: 34, weight: 700 },
    { kind: 'field', key: 'card', category: 'payment_card', label: 'Card on file: ', value: '4111111111111111', y: 970, size: 30 },
    { kind: 'line', text: 'Amount Due: $248.00', y: 1040, size: 30, keep: 'amount-due' },
    { kind: 'line', text: 'Notes', y: 1180, size: 34, weight: 700 },
    { kind: 'line', text: 'Patient reports mild seasonal allergies.', y: 1250, size: 28, keep: 'notes-prose-1' },
    { kind: 'line', text: 'Follow up with the care team in six weeks.', y: 1300, size: 28, keep: 'notes-prose-2' },
    { kind: 'line', text: 'No acute distress observed during intake.', y: 1350, size: 28, keep: 'notes-prose-3' }
  ]
});

const ordinary = await renderDocument({
  background: '#fbfaf6',
  noise: true,
  blocks: [
    { kind: 'line', text: 'Community Garden Newsletter', y: 220, size: 44, weight: 700 },
    { kind: 'line', text: 'Spring 2026', y: 280, size: 28 },
    ...ORDINARY_LINES.map((l) => ({ kind: 'line', ...l }))
  ]
});

writeFileSync(join(fixturesDir, 'photo-pii.png'), pii.png);
writeFileSync(join(fixturesDir, 'photo-ordinary.png'), ordinary.png);

const regions = {
  widthPx: WIDTH,
  heightPx: HEIGHT,
  note:
    'Measured ink boxes for synthetic sensitive values in photo-pii.png. Generated by ' +
    'scripts/make-photo-fixtures.mjs from real glyph metrics - do not hand-edit.',
  regions: pii.measured.regions,
  mustRemainUnchanged: pii.measured.mustRemainUnchanged
};
writeFileSync(join(fixturesDir, 'photo-pii.regions.json'), JSON.stringify(regions, null, 2) + '\n');

await browser.close();

console.log(`photo-pii.png        ${(pii.png.length / 1024).toFixed(1)} KB  ${WIDTH}x${HEIGHT}`);
console.log(`photo-ordinary.png   ${(ordinary.png.length / 1024).toFixed(1)} KB  ${WIDTH}x${HEIGHT}`);
console.log('photo-pii.regions.json written:');
for (const r of regions.regions) console.log(`  ${r.label.padEnd(11)} x=${String(r.x).padStart(4)} y=${String(r.y).padStart(4)} w=${String(r.width).padStart(3)} h=${r.height}`);
for (const r of regions.mustRemainUnchanged) console.log(`  (keep) ${r.label.padEnd(14)} x=${String(r.x).padStart(4)} y=${String(r.y).padStart(4)} w=${String(r.width).padStart(3)} h=${r.height}`);
