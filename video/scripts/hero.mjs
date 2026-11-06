// The website's hero film: the source film re-edited for Tredio on NEAR (src/hero).
//
//   node scripts/hero.mjs compare 1080 1400      source (left) and the rebuild (right) at these frames: out/hero/compare-<frame>.png
//   node scripts/hero.mjs render                  render, splice, encode, check, poster (about 15 minutes)
//   node scripts/hero.mjs render 1375-1376        re-render only these frames into the last render's frames, then splice
//   node scripts/hero.mjs splice                  splice, encode, check and poster from the last render's frames
//   node scripts/hero.mjs sheet                   one frame a second of the finished film: out/hero/sheet.png
//
// The source is the previous product's film, copied to public/source/hero-src.mp4 (gitignored, never committed).
// Only the rebuilt frames are rendered; the kept frames are the source's own, spliced in without a colour round
// trip, and the soundtrack is the source's AAC stream copied bit for bit, so picture and sound stay where they were.
// The source was encoded with BT.709 but carries no colour tags; the rebuild is converted with BT.709 too and the
// output is tagged, so both halves match on every player.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from '@remotion/bundler';
import { renderFrames, renderStill, selectComposition } from '@remotion/renderer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');
const source = join(root, 'public', 'source', 'hero-src.mp4');
const out = join(root, 'out', 'hero');
const site = join(repo, 'landing-page', 'public', 'assets', 'video');
const FPS = 60;
const FRAMES = 3300;
// Keep in step with src/hero/timing.ts.
const KEEP = [[0, 1030], [2250, 2420]];
const REBUILT = [[1030, 2250], [2420, 3300]];
/** Total size to aim for: the source is 8.7 MB. */
const TARGET_BYTES = 9.2e6;

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr ?? ''}`);
  return r.stdout;
};
const ffmpeg = (args) => run('ffmpeg', ['-v', 'error', '-y', ...args]);

if (!existsSync(source)) throw new Error(`missing ${source}: copy the source film there first (see README.md)`);
mkdirSync(out, { recursive: true });

// The marks and logos in public/ are copies; refuse to render stale ones.
const COPIES = [
  ['public/brand/lockup-white.svg', '../assets/brand/lockup-white.svg'],
  ['public/brand/glyph-white.svg', '../assets/brand/glyph-white.svg'],
  ...['near.svg', 'near-intents.svg', 'near-ai.svg', 'outlayer.png', 'hyperliquid.svg', 'rhea.svg', 'elfa.svg', 'nansen.svg', 'coingecko.svg', 'wikipedia-wordmark.svg', 'bluesky.svg'].map((f) => [`public/logos/${f}`, `../landing-page/public/assets/logos/${f}`]),
];
for (const [copy, from] of COPIES) {
  if (!readFileSync(join(root, copy)).equals(readFileSync(join(root, from)))) throw new Error(`${copy} differs from ${from}: copy it again`);
}

async function serve() {
  const serveUrl = await bundle({ entryPoint: join(root, 'src', 'index.ts') });
  const inputProps = { preview: false };
  const composition = await selectComposition({ serveUrl, id: 'Hero', inputProps });
  return { serveUrl, inputProps, composition };
}

/** One source frame as RGB, decoded the way it was encoded (BT.709, limited range). */
function sourceFrame(frame, file) {
  ffmpeg(['-i', source, '-vf', `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, '-frames:v', '1', file]);
}

async function compare(frames) {
  const { serveUrl, inputProps, composition } = await serve();
  for (const frame of frames) {
    const mine = join(out, `frame-${frame}.png`);
    const theirs = join(out, `source-${frame}.png`);
    await renderStill({ composition, serveUrl, output: mine, frame, inputProps });
    sourceFrame(frame, theirs);
    const sheet = join(out, `compare-${frame}.png`);
    ffmpeg(['-i', theirs, '-i', mine, '-filter_complex', '[0]scale=960:540[a];[1]scale=960:540[b];[a][b]hstack', sheet]);
    console.log(sheet);
  }
}

async function render(only) {
  const { serveUrl, inputProps, composition } = await serve();
  if (only.length) {
    // Patch single frames of the last render, named as renderFrames names them.
    for (const range of only) {
      const [a, b = a] = range.split('-').map(Number);
      const [from] = REBUILT.find(([s, e]) => a >= s && b < e);
      for (let frame = a; frame <= b; frame++) await renderStill({ composition, serveUrl, inputProps, frame, output: join(out, `frames-${from}`, `element-${frame}.png`) });
      console.log(`re-rendered frames ${a} to ${b}`);
    }
    return;
  }
  for (const [from, to] of REBUILT) {
    const dir = join(out, `frames-${from}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await renderFrames({ composition, serveUrl, inputProps, outputDir: dir, imageFormat: 'png', frameRange: [from, to - 1], onStart: () => console.log(`rendering frames ${from} to ${to - 1}`), onFrameUpdate: () => {} });
  }
}

function splice() {
  const dirs = REBUILT.map(([from]) => join(out, `frames-${from}`));
  // Splice: kept frames straight from the source, rebuilt frames converted from RGB with BT.709.
  const pattern = (dir) => {
    const name = run('ls', [dir]).split('\n').find((n) => n.endsWith('.png'));
    const m = name.match(/^(.*?)(\d+)\.png$/);
    return { file: join(dir, `${m[1]}%0${m[2].length}d.png`), start: Number(m[2]) };
  };
  const seqs = dirs.map(pattern);
  // setparams only labels the source's frames as what they are (BT.709, limited range), so concat has
  // nothing to convert; without it ffmpeg treats them as untagged and shifts their colours.
  const tag = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
  const graph = [
    `[0:v]trim=start_frame=${KEEP[0][0]}:end_frame=${KEEP[0][1]},setpts=PTS-STARTPTS,${tag}[k0]`,
    `[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS,${tag}[r0]`,
    `[0:v]trim=start_frame=${KEEP[1][0]}:end_frame=${KEEP[1][1]},setpts=PTS-STARTPTS,${tag}[k1]`,
    `[2:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS,${tag}[r1]`,
    `[k0][r0][k1][r1]concat=n=4:v=1:a=0,setsar=1[v]`,
  ].join(';');
  const audioBytes = Number(JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=bit_rate', '-of', 'json', source])).streams[0].bit_rate) * (FRAMES / FPS) / 8;
  const videoRate = Math.floor(((TARGET_BYTES - audioBytes - 60e3) * 8) / (FRAMES / FPS));
  const film = join(out, 'hero-vid.mp4');
  const inputs = ['-i', source, '-framerate', String(FPS), '-start_number', String(seqs[0].start), '-i', seqs[0].file, '-framerate', String(FPS), '-start_number', String(seqs[1].start), '-i', seqs[1].file];
  const x264 = ['-c:v', 'libx264', '-preset', 'veryslow', '-b:v', String(videoRate), '-maxrate', String(videoRate * 4), '-bufsize', String(videoRate * 4), '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', String(FPS)];
  const log = join(out, 'x264-pass');
  console.log(`encoding at ${(videoRate / 1000).toFixed(0)} kb/s, pass 1`);
  ffmpeg([...inputs, '-filter_complex', graph, '-map', '[v]', ...x264, '-pass', '1', '-passlogfile', log, '-an', '-f', 'mp4', '/dev/null']);
  console.log('pass 2');
  ffmpeg([...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '0:a', ...x264, '-pass', '2', '-passlogfile', log, '-c:a', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', film]);
  check(film);
  copyFileSync(film, join(site, 'hero-vid.mp4'));
  poster(film);
}

/** Length, streams, the soundtrack bit for bit, and the cuts on the same frames as the source's. */
function check(film) {
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,pix_fmt:format=duration,size', '-of', 'json', film]));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  if (v.width !== 1920 || v.height !== 1080 || v.codec_name !== 'h264' || v.pix_fmt !== 'yuv420p' || Number(v.nb_frames) !== FRAMES) throw new Error(`unexpected video stream ${JSON.stringify(v)}`);
  if (Math.abs(Number(probe.format.duration) - FRAMES / FPS) > 0.02) throw new Error(`film runs ${probe.format.duration} s`);
  const md5 = (file, args) => run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', ...args, '-f', 'md5', '-']).trim();
  if (md5(film, ['-c', 'copy']) !== md5(source, ['-c', 'copy'])) throw new Error('the audio packets differ from the source');
  if (md5(film, []) !== md5(source, [])) throw new Error('the decoded audio differs from the source');
  // Frame by frame luma (the Y plane itself, no colour conversion): the kept frames must be the source's,
  // and at every cut the two films must change on the same frame.
  const luma = (file) => run('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=64:36:flags=area,format=yuv420p', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  const A = luma(source);
  const B = luma(film);
  const PLANE = 64 * 36;
  const mean = (buf, n) => { let s = 0; for (let i = n * PLANE * 1.5; i < n * PLANE * 1.5 + PLANE; i++) s += buf[i]; return s / PLANE; };
  for (const [from, to] of KEEP) {
    for (let n = from; n < to; n += 7) if (Math.abs(mean(A, n) - mean(B, n)) > 1.5) throw new Error(`kept frame ${n} differs from the source (${mean(A, n).toFixed(1)} against ${mean(B, n).toFixed(1)})`);
  }
  for (const n of [1361, 1376, 1586, 1722, 2038, 2249, 2250, 2278, 2382, 2420, 2463, 3186]) {
    const step = Math.abs(mean(A, n) - mean(A, n - 1)) > 8 ? 'cut' : '';
    console.log(`frame ${n}: source ${mean(A, n).toFixed(1)}, film ${mean(B, n).toFixed(1)} ${step}`);
    if (step && Math.abs(mean(B, n) - mean(B, n - 1)) < 4) throw new Error(`the source changes at frame ${n} but the film does not`);
    if ([1361, 1376, 1586, 1722, 2038].includes(n) && Math.abs(mean(A, n) - mean(B, n)) > 4) throw new Error(`frame ${n} should be the flash's white`);
  }
  const size = statSync(film).size;
  console.log(`${film}: ${(size / 1e6).toFixed(2)} MB, ${v.width}x${v.height} ${v.codec_name} ${v.pix_fmt} ${v.r_frame_rate} fps, ${v.nb_frames} frames, ${probe.format.duration} s; audio ${a.codec_name} copied from the source bit for bit`);
}

/** The poster: the "Trade" title frame of the finished film. */
function poster(film) {
  const png = join(out, 'poster.png');
  ffmpeg(['-i', film, '-vf', 'select=eq(n\\,100),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24', '-frames:v', '1', png]);
  run('cwebp', ['-quiet', '-q', '85', png, '-o', join(site, 'hero-poster.webp')]);
  console.log(join(site, 'hero-poster.webp'));
}

function sheet() {
  const film = join(out, 'hero-vid.mp4');
  const file = join(out, 'sheet.png');
  ffmpeg(['-i', film, '-vf', 'fps=1,scale=in_color_matrix=bt709:in_range=tv:out_range=pc:w=384:h=216,format=rgb24,tile=8x7', '-frames:v', '1', file]);
  // Each tile is the source (top) over the film (bottom), a second apart from the first rebuilt second on.
  const pairs = join(out, 'pairs.png');
  const one = (input) => `[${input}]trim=start=17,setpts=PTS-STARTPTS,fps=1,scale=in_color_matrix=bt709:in_range=tv:out_range=pc:w=320:h=180,format=rgb24[s${input}]`;
  ffmpeg(['-i', source, '-i', film, '-filter_complex', `${one(0)};${one(1)};[s0][s1]vstack,tile=10x4:padding=6:color=0x333333`, '-frames:v', '1', pairs]);
  console.log(`${file}\n${pairs}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'compare') await compare(rest.map(Number));
else if (cmd === 'render') {
  const started = Date.now();
  await render(rest);
  splice();
  console.log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min`);
} else if (cmd === 'splice') splice();
else if (cmd === 'sheet') sheet();
else throw new Error('use compare <frames...>, render [frames], splice or sheet');
