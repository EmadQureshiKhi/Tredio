// An offline chiptune synthesiser for the launch video's soundtrack. Everything is rendered sample
// by sample at 48 kHz, with no randomness that is not seeded, so every render is bit-identical.
//
// Three families of sound live here:
// - ports of the site's own Web Audio code, 1:1: apps/web/lib/sfx.ts (tone(), noise() and the kit
//   built on them), the Chiptune note() and the XO-CHIP Buzzer from apps/web/lib/audio.ts;
// - the film's NES-style voices: a 25% pulse lead, a triangle bass and a 15-bit LFSR noise channel
//   for the drums;
// - the master: BS.1770 loudness, a 4x oversampled true-peak meter, a look-ahead limiter and a
//   16-bit WAV writer. None of them can put energy where the input is zero.

export const RATE = 48_000;
const TAU = Math.PI * 2;

/** MIDI note number to Hz, as the site computes it. */
export const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

/** Seconds to a whole number of samples. */
export const sec = (s) => Math.round(s * RATE);

// ---- seeded randomness ------------------------------------------------------------------------

/** A seeded xorshift32 in place of Math.random: returns a function giving [0, 1). */
export function xorshift32(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** A 32-bit seed from a list of values (FNV-1a), so each event owns its randomness. */
export function seedOf(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

// ---- tracks -----------------------------------------------------------------------------------

/** A stereo track of `n` samples. Positions are in samples. */
export class Mix {
  constructor(n) {
    this.n = n;
    this.l = new Float64Array(n);
    this.r = new Float64Array(n);
  }

  add(start, samples, { vol = 1, pan = 0 } = {}) {
    const gl = vol * Math.min(1, 1 - pan);
    const gr = vol * Math.min(1, 1 + pan);
    for (let k = 0; k < samples.length; k++) {
      const i = start + k;
      if (i < 0 || i >= this.n) continue;
      this.l[i] += samples[k] * gl;
      this.r[i] += samples[k] * gr;
    }
  }

  /** Hard zero on [from, to). */
  gate(from, to) {
    this.l.fill(0, Math.max(0, from), Math.min(this.n, to));
    this.r.fill(0, Math.max(0, from), Math.min(this.n, to));
  }
}

/** Several [offsetSamples, samples] parts summed into one buffer. */
export function layer(parts) {
  const len = Math.max(...parts.map(([at, s]) => at + s.length));
  const out = new Float64Array(len);
  for (const [at, s] of parts) for (let k = 0; k < s.length; k++) out[at + k] += s[k];
  return out;
}

// ---- oscillators ------------------------------------------------------------------------------

// Web Audio's built-in square and sawtooth are band-limited and normalised to a peak of 1, which puts
// their plateau at 1 / 1.179 (the Gibbs overshoot). The ports scale by this to keep the site's balance.
const WEB_AUDIO_NORM = { square: 1 / 1.17898, sawtooth: 1 / 1.17898, triangle: 1, sine: 1 };

function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/**
 * `n` samples of a band-limited (PolyBLEP) oscillator. `freq` is Hz or a function of the sample
 * index. Phases follow Web Audio: every wave starts at 0 (the square and pulse on their rising edge).
 * The pulse has its DC removed and a peak of 1.
 */
export function oscillator(n, freq, { type = 'square', duty = 0.5 } = {}) {
  const out = new Float64Array(n);
  const f = typeof freq === 'function' ? freq : () => freq;
  const dc = 2 * duty - 1;
  const pulseScale = 1 / (1 + Math.abs(dc));
  let p = 0;
  for (let k = 0; k < n; k++) {
    const dt = Math.min(0.5, f(k) / RATE);
    let v;
    switch (type) {
      case 'sine':
        v = Math.sin(TAU * p);
        break;
      case 'triangle':
        v = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
        break;
      case 'sawtooth': {
        const q = p + 0.5 >= 1 ? p - 0.5 : p + 0.5;
        v = 2 * q - 1 - blep(q, dt);
        break;
      }
      case 'pulse': {
        v = (p < duty ? 1 : -1) + blep(p, dt);
        const q = p + 1 - duty >= 1 ? p - duty : p + 1 - duty;
        v = (v - blep(q, dt) - dc) * pulseScale;
        break;
      }
      default: {
        // square
        v = (p < 0.5 ? 1 : -1) + blep(p, dt);
        const q = p + 0.5 >= 1 ? p - 0.5 : p + 0.5;
        v -= blep(q, dt);
      }
    }
    out[k] = v;
    p += dt;
    if (p >= 1) p -= 1;
  }
  return out;
}

/** Web Audio's exponentialRampToValueAtTime between two points, at sample k of the ramp. */
const ramp = (v0, v1, k, len) => v0 * Math.pow(v1 / v0, k / len);

// ---- ports of the site's audio ----------------------------------------------------------------

/**
 * sfx.ts tone(): the gain goes 0.0001 -> vol over `attack` and back to 0.0001 at `dur`, both
 * exponential; the frequency ramps exponentially to `slide`; the oscillator stops 50 ms after `dur`.
 */
export function tone(freq, dur, { wave = 'square', vol = 0.2, slide, attack = 0.005 } = {}) {
  const nd = dur * RATE;
  const na = attack * RATE;
  const n = sec(dur + 0.05);
  const target = slide ? Math.max(20, slide) : freq;
  const f = slide ? (k) => (k < nd ? ramp(freq, target, k, nd) : target) : freq;
  const s = oscillator(n, f, { type: wave });
  const norm = WEB_AUDIO_NORM[wave] ?? 1;
  for (let k = 0; k < n; k++) {
    const env = k < na ? ramp(0.0001, vol, k, na) : k < nd ? ramp(vol, 0.0001, k - na, nd - na) : 0.0001;
    s[k] *= env * norm;
  }
  return s;
}

/**
 * sfx.ts noise(): white noise through a Web Audio lowpass biquad (Q in dB) whose cutoff ramps
 * exponentially `from` -> `to`, with the gain ramping exponentially vol -> 0.0001 over `dur`.
 * Math.random is a seeded xorshift32. `gain` overrides the gain ramp (the film's swell rises).
 */
export function noise(dur, { vol = 0.3, from = 4000, to = 200, q = 0.7, seed = 1, gain } = {}) {
  const n = Math.ceil(RATE * dur);
  const nd = dur * RATE;
  const [g0, g1] = gain ?? [vol, 0.0001];
  const rnd = xorshift32(seed);
  const out = new Float64Array(n);
  const res = Math.pow(10, q / 20);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let k = 0; k < n; k++) {
    const x = rnd() * 2 - 1;
    const fc = Math.min(ramp(from, to, k, nd), RATE / 2 - 1);
    const w = (TAU * fc) / RATE;
    const alpha = Math.sin(w) / (2 * res);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    const b0 = (1 - cw) / 2 / a0;
    const b1 = (1 - cw) / a0;
    const a1 = (-2 * cw) / a0;
    const a2 = (1 - alpha) / a0;
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[k] = y * ramp(g0, g1, k, nd);
  }
  return out;
}

/** audio.ts Chiptune note(): gain vol at once, exponential to 0.001 at `dur`, stopped 20 ms later. */
export function chipNote(midi, dur, wave, vol) {
  const nd = dur * RATE;
  const n = sec(dur + 0.02);
  const s = oscillator(n, hz(midi), { type: wave });
  const norm = WEB_AUDIO_NORM[wave] ?? 1;
  for (let k = 0; k < n; k++) s[k] *= (k < nd ? ramp(vol, 0.001, k, nd) : 0.001) * norm;
  return s;
}

/** audio.ts Chiptune: its master gain, its bass roots and its arpeggio. */
export const CHIPTUNE = { master: 0.06, bass: [45, 45, 48, 43], arp: [0, 7, 12, 16, 12, 7], tickMs: 125 };

/** sfx.ts: the master gain every effect goes through. */
export const SFX_MASTER = 0.5;

/**
 * audio.ts Buzzer: the 16-byte XO-CHIP pattern as a looped buffer of +-0.18 at
 * 4000 * 2^((pitch - 64) / 48) bits a second, through a 0.35 gain. `offset` is the loop position.
 */
export function buzzer(pattern, pitch, n, offset = 0) {
  const rate = 4000 * 2 ** ((pitch - 64) / 48);
  const samplesPerBit = RATE / rate;
  const length = Math.max(1, Math.round(128 * samplesPerBit));
  const table = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const bit = Math.floor(i / samplesPerBit) % 128;
    table[i] = (pattern[bit >> 3] >> (7 - (bit & 7))) & 1 ? 0.18 : -0.18;
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = table[(offset + k) % length] * 0.35;
  return { samples: out, length };
}

/** The site's effects (sfx.ts), before its 0.5 master. `rnd` is a seeded random for the jitter. */
export const sfx = {
  click: (rnd) => tone(1200 + rnd() * 200, 0.045, { vol: 0.12, slide: 700 }),
  tick: (rnd) => tone(520 + rnd() * 80, 0.03, { wave: 'triangle', vol: 0.1 }),
  /** `freq` pins the pitch (the chart walk); otherwise the site's 1800-2400 Hz jitter. */
  key: (rnd, freq) => tone(freq ?? 1800 + rnd() * 600, 0.012, { wave: 'square', vol: 0.03 }),
  nuke: (seed) =>
    layer([
      [0, tone(150, 1.3, { wave: 'sine', vol: 0.9, slide: 32 })],
      [0, tone(75, 1.6, { wave: 'triangle', vol: 0.6, slide: 25 })],
      [0, tone(300, 0.25, { wave: 'sawtooth', vol: 0.25, slide: 60 })],
      [0, noise(0.5, { vol: 0.6, from: 6000, to: 300, seed })],
      [sec(0.08), noise(2.2, { vol: 0.35, from: 900, to: 60, seed: seed + 1 })],
      [sec(0.9), noise(0.4, { vol: 0.15, from: 3000, to: 800, seed: seed + 2 })],
    ]),
  coin: () => layer([[0, tone(988, 0.08, { vol: 0.16 })], [sec(0.08), tone(1319, 0.38, { vol: 0.16 })]]),
  pop: () => tone(660, 0.06, { wave: 'triangle', vol: 0.12, slide: 990 }),
  denied: () => layer([[0, tone(140, 0.12, { wave: 'sawtooth', vol: 0.18 })], [sec(0.14), tone(110, 0.2, { wave: 'sawtooth', vol: 0.18 })]]),
  powerUp: () => layer([523, 659, 784, 1047, 1319].map((f, k) => [sec(k * 0.055), tone(f, 0.12, { vol: 0.14 })])),
  powerDown: () => layer([1047, 784, 659, 523, 392].map((f, k) => [sec(k * 0.06), tone(f, 0.12, { vol: 0.12, wave: 'triangle' })])),
  /** The sad trombone. `spacing` is the site's 0.34 s; the film re-times it to 8ths. */
  rekt: (spacing = 0.34) =>
    layer(
      [392, 370, 349, 330].map((f, k, all) => {
        const last = k === all.length - 1;
        return [sec(k * spacing), tone(f, last ? 0.9 : 0.3, { wave: 'sawtooth', vol: 0.12, slide: last ? f * 0.92 : undefined, attack: 0.03 })];
      }),
    ),
  /** The blue screen. The film passes `firstChord: false` and a quieter `crash`. */
  bsod: (seed, { firstChord = true, crash = 0.5 } = {}) => {
    const chord = (freqs, at, dur) => freqs.map((f) => [sec(at), tone(f, dur, { wave: 'triangle', vol: 0.12, attack: 0.01 })]);
    return layer([
      [0, noise(0.18, { vol: crash, from: 8000, to: 1500, seed })],
      ...(firstChord ? chord([523, 659, 784], 0.12, 0.35) : []),
      ...chord([392, 494, 587], 0.42, 0.35),
      ...chord([262, 330, 392], 0.72, 0.9),
      [sec(0.1), tone(55, 1.2, { wave: 'sine', vol: 0.4, slide: 40 })],
    ]);
  },
  popup: () => layer([[0, tone(880, 0.05, { vol: 0.1 })], [sec(0.05), tone(1175, 0.09, { vol: 0.1 })]]),
  whoosh: (seed) => noise(0.35, { vol: 0.25, from: 300, to: 6000, seed }),
};

// ---- the film's NES-style voices ----------------------------------------------------------------

/** The NES CPU clock, which the noise channel's periods divide. */
export const NES_CPU = 1_789_773;

/**
 * The NES noise channel: a 15-bit LFSR clocked at `clock` Hz, feedback bit 0 XOR bit 1 (long mode,
 * 32,767 steps) or bit 0 XOR bit 6 (short mode, the 93-step loop). Each output sample is the
 * register's +-1 output averaged over the sample's time, which keeps fast clocks from aliasing.
 */
export function lfsr(n, { short = false, clock = NES_CPU / 64, seed = 1 } = {}) {
  let reg = 1;
  const next = () => {
    const fb = (reg ^ (reg >> (short ? 6 : 1))) & 1;
    reg = (reg >> 1) | (fb << 14);
  };
  // Start somewhere along the sequence that power-on state 1 belongs to (for short mode, the 93 loop).
  const skip = seed % (short ? 93 : 32767);
  for (let i = 0; i < skip; i++) next();
  const step = clock / RATE;
  const out = new Float64Array(n);
  let frac = 0;
  for (let k = 0; k < n; k++) {
    let left = step;
    let sum = 0;
    while (left > 0) {
      const v = reg & 1 ? -1 : 1;
      const room = 1 - frac;
      if (left >= room) {
        sum += room * v;
        left -= room;
        frac = 0;
        next();
      } else {
        sum += left * v;
        frac += left;
        left = 0;
      }
    }
    out[k] = sum / step;
  }
  return out;
}

/** A note on the lead's 25% pulse (or any wave): 2 ms attack, a decay to `sustain`, a release. */
export function voice(midi, dur, { type = 'pulse', duty = 0.25, vol = 1, sustain = 0.55, decay = 0.08, release = 0.008, freq } = {}) {
  const n = sec(dur);
  const nr = sec(release);
  const s = oscillator(n, freq ?? hz(midi), { type, duty });
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    const a = Math.min(1, t / 0.002);
    const d = sustain + (1 - sustain) * Math.exp(-t / decay);
    const r = Math.min(1, (n - k) / nr);
    s[k] *= vol * a * d * r;
  }
  return s;
}

/** A note that decays exponentially to 0.001 over `dur` and then stops (the E6, the boot chord). */
export function pluck(midi, dur, { type = 'pulse', duty = 0.25, vol = 1 } = {}) {
  const n = sec(dur);
  const s = oscillator(n, hz(midi), { type, duty });
  for (let k = 0; k < n; k++) s[k] *= vol * ramp(1, 0.001, k, n);
  return s;
}

/** Kick: a triangle falling 150 -> 45 Hz exponentially over 90 ms, plus a 5 ms noise click. */
export function kick(seed = 1) {
  const n = sec(0.15);
  const nd = 0.09 * RATE;
  const body = oscillator(n, (k) => (k < nd ? ramp(150, 45, k, nd) : 45), { type: 'triangle' });
  const fade = sec(0.005);
  for (let k = 0; k < n; k++) {
    const t = k / RATE;
    body[k] *= (t < 0.02 ? 1 : Math.exp(-(t - 0.02) / 0.03)) * Math.min(1, (n - k) / fade);
  }
  const nc = sec(0.005);
  const click = lfsr(nc, { clock: NES_CPU / 8, seed });
  for (let k = 0; k < nc; k++) body[k] += click[k] * 0.35 * (1 - k / nc);
  return body;
}

/** Snare: 120 ms of long-mode noise plus a 30 ms square at 190 Hz. */
export function snare(seed = 1) {
  const n = sec(0.12);
  const s = lfsr(n, { clock: NES_CPU / 64, seed });
  for (let k = 0; k < n; k++) s[k] *= 0.8 * Math.exp(-k / RATE / 0.04) * Math.min(1, (n - k) / sec(0.004));
  const ns = sec(0.03);
  const sq = oscillator(ns, 190, { type: 'square' });
  for (let k = 0; k < ns; k++) s[k] += sq[k] * 0.5 * (1 - k / ns);
  return s;
}

/** Closed hat: 25 ms of short-mode (93-step) noise. */
export function hat(seed = 1) {
  const n = sec(0.025);
  const s = lfsr(n, { short: true, clock: NES_CPU / 4, seed });
  for (let k = 0; k < n; k++) s[k] *= Math.pow(1 - k / n, 2);
  return s;
}

/** Crash: long-mode noise with a 600 ms decay. */
export function crash(seed = 1) {
  const n = sec(0.6);
  const s = lfsr(n, { clock: NES_CPU / 16, seed });
  for (let k = 0; k < n; k++) s[k] *= Math.exp(-k / RATE / 0.12) * Math.min(1, (n - k) / sec(0.01));
  return s;
}

// ---- master ---------------------------------------------------------------------------------------

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * A one-pole DC blocker (high-pass at `fc` Hz), in place. Chip notes that start on their positive
 * half and decay exponentially carry a net DC area (Web Audio's do too); this takes it out.
 */
export function dcBlock(x, fc = 10) {
  const R = Math.exp((-TAU * fc) / RATE);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - x1 + R * y1;
    x1 = x[i];
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** ITU-R BS.1770-4 integrated loudness in LUFS (48 kHz K-weighting, 400 ms blocks, both gates). */
export function loudness(l, r) {
  const kw = (x) => biquad(biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585), 1, -2, 1, -1.99004745483398, 0.99007225036621);
  const kl = kw(l);
  const kr = kw(r);
  const n = l.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const block = sec(0.4);
  const hop = sec(0.1);
  const z = [];
  for (let s = 0; s + block <= n; s += hop) z.push((cum[s + block] - cum[s]) / block);
  const lk = (e) => -0.691 + 10 * Math.log10(e);
  const abs = z.filter((e) => e > 0 && lk(e) > -70);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = lk(mean(abs)) - 10;
  return lk(mean(abs.filter((e) => lk(e) > rel)));
}

/**
 * Per-sample true peak: the larger of |x| and the 4x oversampled points up to the next sample, on
 * either channel. The interpolator is a Kaiser-windowed sinc, 32 taps per phase.
 */
export function truePeaks(l, r, over = 4, half = 16) {
  const i0 = (x) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k++) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  const beta = 8;
  const phases = [];
  for (let q = 1; q < over; q++) {
    const frac = q / over;
    const taps = [];
    for (let m = -half + 1; m <= half; m++) {
      const u = frac - m;
      const v = u / half;
      const w = i0(beta * Math.sqrt(Math.max(0, 1 - v * v))) / i0(beta);
      taps.push((u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w);
    }
    const sum = taps.reduce((a, b) => a + b, 0);
    phases.push(taps.map((t) => t / sum));
  }
  // The signal is zero outside the file, so the ringing of a hard start before sample 0 counts too
  // (folded into sample 0), as it does for a meter that sees the file from silence.
  const n = l.length;
  const p = new Float64Array(n);
  for (const x of [l, r]) {
    for (let i = -half; i < n; i++) {
      const at = Math.max(0, i);
      if (i >= 0 && Math.abs(x[i]) > p[at]) p[at] = Math.abs(x[i]);
      for (const taps of phases) {
        let acc = 0;
        for (let j = 0; j < taps.length; j++) {
          const idx = i - half + 1 + j;
          if (idx >= 0 && idx < n) acc += x[idx] * taps[j];
        }
        const peak = Math.abs(acc);
        if (peak > p[at]) p[at] = peak;
      }
    }
  }
  return p;
}

/**
 * A look-ahead peak limiter as a per-sample gain curve, computed offline, so the audio is never
 * delayed. `peaks` is truePeaks() of the unscaled mix and `gain` the make-up gain in front of it.
 * The gain reaches each reduction `attack` seconds early (the minimum over the look-ahead, then a
 * moving average of the same length, which never exceeds what any peak needs) and releases
 * exponentially. The result multiplies the signal, so zero stays zero.
 */
export function limiterGain(peaks, gain, ceiling, { attack = 0.0015, release = 0.08 } = {}) {
  const n = peaks.length;
  const L = sec(attack);
  const need = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = peaks[i] * gain;
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  const hold = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1;
    for (let j = i; j <= i + L && j < n; j++) if (need[j] < m) m = need[j];
    hold[i] = m;
  }
  // The moving average runs over [i - L, i]; before the start it sees hold[0], which is at most what
  // any of the first L + 1 samples needs.
  const out = new Float64Array(n);
  const a = 1 - Math.exp(-1 / (release * RATE));
  let sum = hold[0] * (L + 1);
  let g = hold[0];
  for (let i = 0; i < n; i++) {
    sum += hold[i] - (i - L - 1 >= 0 ? hold[i - L - 1] : hold[0]);
    g = Math.min(sum / (L + 1), g + (1 - g) * a);
    out[i] = g * gain;
  }
  return out;
}

/** 16-bit stereo PCM WAV. Rounds without dither, so a zero sample is written as 0. */
export function wav16(l, r) {
  const n = l.length;
  const out = Buffer.alloc(44 + n * 4);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * 4, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(n * 4, 40);
  const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))) | 0;
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(q(l[i]), 44 + i * 4);
    out.writeInt16LE(q(r[i]), 46 + i * 4);
  }
  return out;
}
