/**
 * Vendors the Lucide glyphs Relay uses into src/assets/icons.
 *
 * Umbra loads Lucide from a CDN. Relay is a desktop application and must draw
 * its interface with the network down, so the SVGs are committed. Run this
 * script when a new glyph name is used; it is not part of the build.
 *
 *   node scripts/sync-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = '0.544.0';
const OUT = join(import.meta.dirname, '..', 'src', 'assets', 'icons');

/** Keep alphabetical. Every name here must exist in Lucide. */
const ICONS = [
  'arrow-left',
  'chevron-down',
  'circle',
  'circle-alert',
  'circle-check',
  'clock',
  'command',
  'copy',
  'download',
  'ellipsis',
  'eye',
  'eye-off',
  'file-text',
  'folder',
  'house',
  'inbox',
  'info',
  'library',
  'loader-circle',
  'lock',
  'minus',
  'moon',
  'panel-left',
  'pencil',
  'plus',
  'search',
  'settings',
  'square',
  'star',
  'sun',
  'trash-2',
  'triangle-alert',
  'x',
];

await mkdir(OUT, { recursive: true });

let failed = 0;
await Promise.all(
  ICONS.map(async (name) => {
    const url = `https://unpkg.com/lucide-static@${VERSION}/icons/${name}.svg`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`  ${name}: ${response.status} ${response.statusText}`);
      failed++;
      return;
    }
    await writeFile(join(OUT, `${name}.svg`), await response.text(), 'utf8');
  }),
);

console.log(`${ICONS.length - failed}/${ICONS.length} icons written to src/assets/icons`);
if (failed > 0) process.exitCode = 1;
