// Tredio's soundtrack: node scripts/music.mjs [seed] -> public/audio/track.wav (144 BPM, C# minor)
//
// One deterministic render, sample-exact against src/timeline.json. Each scene's `energy` picks the
// arrangement (intro, build, groove, drop, outro); `hits` get a kick, crash and chord stab; `ticks`
// are typing clicks; `clicks` are UI blips; `risers` sweep up for one bar into the next section.
// `key` and the seed change the progression, arp shape and lead so films do not sound the same.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import t from '../src/timeline.json' with { type: 'json' };
import { Mix, RATE, crash, dcBlock, hat, kick, limiterGain, loudness, noise, pluck, snare, tone, truePeaks, voice, wav16, xorshift32 } from './synth.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/audio');
const SPF = t.samplesPerFrame;
const N = t.frames * SPF;
if (SPF * t.fps !== RATE) throw new Error('timeline.json and synth.mjs disagree on the sample rate');
if (t.beat !== (60 * t.fps) / t.bpm) throw new Error(`beat must be ${(60 * t.fps) / t.bpm} frames at ${t.bpm} BPM`);
const at = (frame) => Math.round(frame * SPF);
const BEAT = t.beat;
const S16 = BEAT / 4;
const rnd = xorshift32(Number(process.argv[2] ?? t.seed ?? 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ---- harmony: a key and one of several progressions ------------------------------------------------
const ROOTS = { C: 48, 'C#': 49, D: 50, Eb: 51, E: 52, F: 53, 'F#': 54, G: 55, Ab: 56, A: 57, Bb: 58, B: 59 };
const minor = t.key.endsWith('m');
const tonic = ROOTS[t.key.replace(/m$/, '')] ?? 57;
const MINOR_PROGS = [[0, 8, 3, 10], [0, 5, 8, 7], [0, 3, 10, 8], [0, 8, 10, 7]]; // i VI III VII, i iv VI V ...
const MAJOR_PROGS = [[0, 7, 9, 5], [0, 5, 9, 7], [9, 5, 0, 7], [0, 9, 5, 7]]; // I V vi IV ...
const prog = pick(minor ? MINOR_PROGS : MAJOR_PROGS);
const triad = (root) => {
  const deg = ((root - tonic) % 12 + 12) % 12;
  const isMinorChord = minor ? [0, 5, 7].includes(deg) && deg !== 7 : [2, 4, 9].includes(deg);
  return [root, root + (isMinorChord ? 3 : 4), root + 7];
};
const chordAt = (frame) => triad(tonic + prog[Math.floor(frame / t.bar) % prog.length]);
const bassAt = (frame) => chordAt(frame)[0] - 24;
const ARP = pick([[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1]]);
const leadShape = pick([[0, 2, 4, 7, 6, 4, 2, 0], [7, 4, 2, 4, 0, 2, 4, 2], [0, 4, 7, 9, 7, 4, 2, 4]]);
const scale = minor ? [0, 2, 3, 5, 7, 8, 10, 12, 14, 15] : [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];

const mix = new Mix(N);
const add = (frame, s, o) => mix.add(at(frame), s, o);
const sceneAt = (frame) => t.scenes.find((s) => frame >= s.from && frame < s.to) ?? t.scenes.at(-1);

// ---- hits -------------------------------------------------------------------------------------------
for (const [i, h] of t.hits.entries()) {
  add(h, kick(i + 1), { vol: 0.95 });
  const big = t.scenes.some((s) => s.from === h);
  add(h, crash(i + 7), { vol: big ? 0.3 : 0.12, pan: i % 2 ? 0.3 : -0.3 });
  for (const n of chordAt(h)) add(h, voice(n - 12, 0.32, { type: 'sawtooth', vol: 0.09, sustain: 0.2, decay: 0.12 }), { pan: (n % 3) * 0.2 - 0.2 });
  add(h, voice(bassAt(h), 0.4, { type: 'square', vol: 0.22, sustain: 0.3, decay: 0.15 }));
}

// ---- sections by energy ----------------------------------------------------------------------------
for (const s of t.scenes) {
  for (let f = s.from; f < s.to; f += S16) {
    const step = Math.round((f - s.from) / S16) % 16;
    const ch = chordAt(f);
    if (s.energy === 'intro') {
      if (step % 2 === 0) add(f, voice(bassAt(f) + 12, 0.08, { type: 'pulse', duty: 0.125, vol: 0.06 }));
    } else if (s.energy === 'build') {
      if (step % 4 === 0) add(f, kick(step + 20), { vol: 0.7 });
      add(f, hat(step + 5), { vol: 0.05 + 0.08 * ((f - s.from) / (s.to - s.from)), pan: 0.25 });
      if (step % 2 === 1) add(f, voice(bassAt(f), 0.11, { type: 'pulse', duty: 0.25, vol: 0.16, sustain: 0.4, decay: 0.05 }));
    } else if (s.energy === 'groove' || s.energy === 'drop') {
      const drop = s.energy === 'drop';
      // A soft triangle pad under each bar, so the chip voices sit on something warmer.
      if ((f - s.from) % t.bar === 0) for (const n of ch) add(f, voice(n, t.bar / t.fps, { type: 'triangle', vol: 0.045, sustain: 0.7, decay: 0.4, release: 0.25 }), { pan: (n % 3) * 0.25 - 0.25 });
      if (step % 4 === 0) add(f, kick(step + 11), { vol: 0.9 });
      if (step === 4 || step === 12) add(f, snare(step + 3), { vol: drop ? 0.5 : 0.42 });
      add(f, hat(step + 5), { vol: step % 2 ? 0.07 : 0.12, pan: 0.25 });
      if (step % 2 === 1) add(f, voice(bassAt(f) + (step % 4 === 3 ? 12 : 0), 0.11, { type: 'pulse', duty: 0.25, vol: 0.2, sustain: 0.4, decay: 0.05 }));
      const note = [...ch, ch[1] + 12][ARP[step % 4]] + 12;
      add(f, pluck(note, 0.12, { type: 'pulse', duty: 0.25, vol: 0.05 }), { pan: step % 2 ? 0.35 : -0.35 });
      if (drop && step % 2 === 0) {
        const k = Math.floor(step / 2) % 8;
        add(f, voice(tonic + 12 + scale[leadShape[k]], 0.22, { type: 'square', vol: 0.06, sustain: 0.5 }), { pan: 0.1 });
      }
    } else if (s.energy === 'outro' && f === s.from) {
      for (const n of [...ch, ch[0] + 12]) add(f, voice(n, (s.to - s.from) / t.fps, { type: 'triangle', vol: 0.09, sustain: 0.35, decay: 1.2, release: 0.6 }));
      add(f, voice(ch[0] - 24, Math.min(3.2, (s.to - s.from) / t.fps), { type: 'square', vol: 0.16, sustain: 0.3, decay: 0.8, release: 0.5 }));
    }
    if (s.energy === 'outro' && step % 2 === 0 && f > s.from + BEAT * 2) {
      const k = Math.round((f - s.from) / S16 / 2);
      add(f, pluck([ch[0] + 24, ch[1] + 24, ch[2] + 24, ch[0] + 36][k % 4], 0.3, { type: 'pulse', duty: 0.125, vol: 0.05 * Math.max(0, 1 - k / 20) }), { pan: k % 2 ? 0.4 : -0.4 });
    }
  }
}

// ---- foley and transitions ---------------------------------------------------------------------------
for (const [i, f] of (t.ticks ?? []).entries()) add(f, hat(40 + i), { vol: 0.18, pan: -0.2 });
for (const f of t.clicks ?? []) {
  add(f, tone(1760, 0.05, { wave: 'square', vol: 0.18 }));
  add(f, tone(880, 0.25, { wave: 'triangle', vol: 0.3, slide: 1760 }));
}
for (const f of t.risers ?? []) add(f, noise((t.bar / t.fps), { gain: [0.0005, 0.24], from: 300, to: 10000, seed: 3 + f }));
// a beat of silence before every drop and outro makes the landing hit harder
for (const s of t.scenes) if (s.energy === 'drop' || s.energy === 'outro') mix.gate(at(s.from - 4), at(s.from));

// ---- master: -14 LUFS integrated, -1 dBTP ----------------------------------------------------------
dcBlock(mix.l);
dcBlock(mix.r);
const gain = Math.pow(10, (-14 - loudness(mix.l, mix.r)) / 20);
const g = limiterGain(truePeaks(mix.l, mix.r), gain, Math.pow(10, -1 / 20));
for (let i = 0; i < N; i++) {
  mix.l[i] *= g[i];
  mix.r[i] *= g[i];
}
const fade = at(12);
for (let i = N - fade; i < N; i++) {
  mix.l[i] *= (N - i) / fade;
  mix.r[i] *= (N - i) / fade;
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'track.wav'), wav16(mix.l, mix.r));
console.log(`public/audio/track.wav: ${(N / RATE).toFixed(3)} s, ${loudness(mix.l, mix.r).toFixed(1)} LUFS, key ${t.key}, progression ${prog.join('-')}`);
