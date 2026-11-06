// The one preview pass: renders stills and tiles them into out/stills/<cut>-sheet.png. Look at the
// sheet once, fix what is wrong, then render.
//
//   node scripts/stills.mjs                    landscape, one frame per scene, 70% of the way through
//   node scripts/stills.mjs Vertical           the vertical cut
//   node scripts/stills.mjs Film 90 330        exactly these frames
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

import t from '../src/timeline.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0] && !/^\d+$/.test(args[0]) ? args.shift() : 'Film';
const dir = join(root, 'out', 'stills');
mkdirSync(dir, { recursive: true });
const frames = args.length ? args.map(Number) : t.scenes.map((s) => Math.round(s.from + (s.to - s.from) * 0.7));

const serveUrl = await bundle({ entryPoint: join(root, 'src', 'index.ts') });
const inputProps = { mute: true };
const composition = await selectComposition({ serveUrl, id, inputProps });
const files = [];
for (const frame of frames) {
  const output = join(dir, `${id}-f${frame}.png`);
  await renderStill({ composition, serveUrl, output, frame, inputProps });
  files.push(output);
}

// Tile: landscape two per row at half size, vertical four per row at half size.
const vertical = composition.height > composition.width;
const tw = composition.width / 2;
const th = composition.height / 2;
const cols = vertical ? 4 : 2;
const rows = Math.ceil(files.length / cols);
const inputs = files.flatMap((f) => ['-i', f]);
const graph = [];
files.forEach((_, i) => graph.push(`[${i}]scale=${tw}:${th}[s${i}]`));
for (let r = 0; r < rows; r++) {
  const row = files.map((_, i) => i).slice(r * cols, r * cols + cols);
  const tiles = row.map((i) => `[s${i}]`).join('');
  graph.push(row.length > 1 ? `${tiles}hstack=inputs=${row.length},pad=${tw * cols}:${th}[r${r}]` : `${tiles}pad=${tw * cols}:${th}[r${r}]`);
}
graph.push(rows > 1 ? `${Array.from({ length: rows }, (_, r) => `[r${r}]`).join('')}vstack=inputs=${rows}` : '[r0]copy');
const sheet = join(dir, `${id}-sheet.png`);
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph.join(';'), sheet], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${sheet}: frames ${frames.join(', ')}`);
