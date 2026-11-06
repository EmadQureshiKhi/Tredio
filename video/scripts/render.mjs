// Renders a cut of the film: node scripts/render.mjs [Film|Vertical|all]
//   Film      -> out/tredio-launch-1920x1080.mp4
//   Vertical  -> out/tredio-launch-1080x1350.mp4
//   all       -> both (the default)
// The picture comes from Remotion; the soundtrack is muxed straight from the WAV, because Remotion's
// own AAC carries its encoder delay uncompensated (about 43 ms late). Then it checks that both
// streams run the full length and that the audio lines up with the WAV to the sample.
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import t from '../src/timeline.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CUTS = { Film: 'tredio-launch-1920x1080', Vertical: 'tredio-launch-1080x1350' };
const which = process.argv[2] ?? 'all';
const ids = which === 'all' ? Object.keys(CUTS) : [which];
for (const id of ids) if (!CUTS[id]) throw new Error(`unknown cut ${id}: use Film, Vertical or all`);
const secs = t.frames / t.fps;
const wav = join(root, 'public', 'audio', 'track.wav');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!existsSync(wav)) run('node', ['scripts/music.mjs']);

const decode = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-f', 's16le', '-ar', '48000', '-t', '6', '-'], { maxBuffer: 1 << 26 }).stdout;
const sample = (buf, i) => (i >= 0 && i * 2 + 1 < buf.length ? buf.readInt16LE(i * 2) : 0);

for (const id of ids) {
  const started = Date.now();
  const out = join(root, 'out', `${CUTS[id]}.mp4`);
  const picture = join(root, 'out', `${CUTS[id]}.picture.mp4`);
  run('npx', ['remotion', 'render', 'src/index.ts', id, picture, '--codec=h264', '--crf=16', '--pixel-format=yuv420p', '--x264-preset=slow', '--image-format=png', '--color-space=bt709', '--muted', '--props={"mute":true}', '--log=error']);
  run('ffmpeg', ['-v', 'error', '-y', '-i', picture, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-t', String(secs), '-movflags', '+faststart', out]);
  rmSync(picture);

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', out], { encoding: 'utf8' });
  for (const st of JSON.parse(probe.stdout).streams) if (Math.abs(Number(st.duration) - secs) > 0.011) throw new Error(`${st.codec_type} runs ${st.duration} s, expected ${secs}`);
  const a = decode(wav);
  const b = decode(out);
  let best = { lag: 0, score: -Infinity };
  for (let lag = -4096; lag <= 4096; lag += 1) {
    let score = 0;
    for (let i = 48000; i < 48000 + 96000; i += 16) score += sample(a, i) * sample(b, i + lag);
    if (score > best.score) best = { lag, score };
  }
  if (best.lag !== 0) throw new Error(`the audio is ${best.lag} samples off the picture`);
  console.log(`${out}: ${secs.toFixed(3)} s, picture and sound aligned to the sample, rendered in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
