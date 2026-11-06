// Tredio's launch film. Flow: "the question" (reference/flows.md #3): one huge question, answered
// beat by beat with real screens, closing on the question turned into a statement.
// One component per scene, chosen by frame from timeline.json; every scene lays itself out for the
// landscape cut (1920x1080) and the vertical cut (1080x1350). Footage is real: public/captures,
// taken signed out from the app on NEAR testnet (scripts/capture.mjs). Overlays sit on real elements
// in capture CSS pixels (public/captures/boxes.json has the boxes).
import React from 'react';
import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from 'remotion';

import { BRAND } from './brand';
import {
  BODY,
  Backdrop,
  type Box,
  C,
  Caption,
  Counter,
  DISPLAY,
  Eyebrow,
  Flash,
  type Key,
  LABEL,
  Label,
  MONO,
  PathCursor,
  Rise,
  Ring,
  Shot,
  Slam,
  TypeLine,
  WordByWord,
  clamp,
  sinceHit,
  t,
  useFormat,
} from './kit';
import { Glyph, Lockup } from './Logo';
import timeline from './timeline.json';

type Scene = (p: { f: number }) => React.ReactElement;

// ---- shared layouts ------------------------------------------------------------------------------

/** The vertical cut's footage card: under the headline, framed like an app card. */
const VBOX: Box = { x: 40, y: 410, w: 1000, h: 880 };

/** A headline with an optional line under it, for the vertical cut's header area. */
function VTitle({ f, at, title, sub, size = 72 }: { f: number; at: number; title: React.ReactNode; sub?: React.ReactNode; size?: number }) {
  return (
    <div style={{ position: 'absolute', left: 40, top: 140, width: 1000 }}>
      <Slam f={f} at={at} size={size} ghost={false} style={{ whiteSpace: 'normal', lineHeight: 1.04 }}>
        {title}
      </Slam>
      {sub && f >= at && <div style={{ ...BODY, fontSize: 30, lineHeight: 1.35, color: C.text2, marginTop: 16, opacity: t(f, at + 8, 14) }}>{sub}</div>}
    </div>
  );
}

/**
 * A footage beat: the capture full frame with a caption plate (landscape), or a framed card under a
 * headline (vertical). `cam` gives the camera keys for each format.
 */
function Footage({ f, label, labelAt, captionAt, title, sub, cam, layers, side = 'left' }: { f: number; label?: [string, string]; labelAt: number; captionAt: number; side?: 'left' | 'right'; title: React.ReactNode; sub?: React.ReactNode; cam: { l: Key[]; v: Key[] }; layers: (box: Box, keys: Key[]) => React.ReactNode }) {
  const { W, H, vertical } = useFormat();
  if (!vertical) {
    return (
      <>
        {layers({ x: 0, y: 0, w: W, h: H }, cam.l)}
        <AbsoluteFill style={{ boxShadow: `inset 0 0 220px 40px ${C.bg}e0`, pointerEvents: 'none' }} />
        <AbsoluteFill style={{ background: `linear-gradient(0deg, ${C.bg}cc 0%, transparent 38%)`, pointerEvents: 'none' }} />
        <Caption f={f} at={captionAt} title={title} sub={sub} eyebrow={label} side={side} />
      </>
    );
  }
  return (
    <>
      {label && <Label f={f} at={labelAt} n={label[0]} text={label[1]} x={40} y={56} />}
      <VTitle f={f} at={captionAt} title={title} sub={sub} />
      <div style={{ position: 'absolute', left: VBOX.x - 1, top: VBOX.y - 1, width: VBOX.w + 2, height: VBOX.h + 2, borderRadius: 29, background: C.surface, border: `1px solid ${C.lineStrong}`, boxShadow: '0 50px 120px -30px rgba(0,0,0,0.95)' }} />
      {layers({ ...VBOX }, cam.v)}
    </>
  );
}

const round = (vertical: boolean) => (vertical ? 28 : 0);

// ---- 1. the question --------------------------------------------------------------------------------

const Hook: Scene = ({ f }) => {
  const { pick } = useFormat();
  const draw = t(f, 120, 70);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <svg width="100%" height={pick('55%', '42%')} viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, bottom: 0, opacity: 0.5 }}>
        <defs>
          <clipPath id="hook-draw">
            <rect x="0" y="0" width={1000 * draw} height="1000" />
          </clipPath>
        </defs>
        <path clipPath="url(#hook-draw)" d="M0 820 L180 815 L260 830 L420 818 L600 816 L700 812 L760 650 L800 470 L840 470 L880 560 L1000 540" fill="none" stroke={C.primary} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: pick(10, 14) }}>
        <Rise f={f} at={-8} size={pick(108, 86)} color={C.text2}>
          What if the internet&rsquo;s
        </Rise>
        <Slam f={f} at={50} size={pick(270, 220)} color={C.primary}>
          attention
        </Slam>
        <Rise f={f} at={100} size={pick(108, 86)}>
          was a <span style={{ color: C.accent }}>market?</span>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

// ---- 2. the reveal ----------------------------------------------------------------------------------

const Reveal: Scene = ({ f }) => {
  const { pick } = useFormat();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: pick(46, 40) }}>
      <Lockup f={f} at={200} wordAt={250} height={pick(150, 104)} />
      <div style={{ textAlign: 'center' }}>
        <Rise f={f} at={300} size={pick(58, 50)} color={C.text2} style={{ whiteSpace: pick('nowrap', 'normal') as 'nowrap' }}>
          Trade the world&rsquo;s attention on NEAR.
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

// ---- 3. markets -------------------------------------------------------------------------------------

const Markets: Scene = ({ f }) => (
  <Footage
    f={f}
    label={['01', 'Markets']}
    side="right"
    labelAt={404}
    captionAt={425}
    title={
      <>
        Every trend is a <span style={{ color: C.accent }}>market.</span>
      </>
    }
    sub="Each card is a live attention index you can trade."
    cam={{
      l: [
        { at: 400, rect: [40, 20, 1520, 855] },
        { at: 470, rect: [250, 20, 1120, 630] },
        { at: 560, rect: [250, 370, 920, 518] },
      ],
      v: [
        { at: 400, rect: [330, 70, 980, 862] },
        { at: 470, rect: [340, 110, 760, 669] },
        { at: 560, rect: [300, 400, 560, 493] },
      ],
    }}
    layers={(box, keys) => (
      <Shot f={f} src="home.png" keys={keys} box={box} round={round(box.w < 1200)}>
        <Ring f={f} at={525} rect={[330, 542, 380, 237]} radius={18} />
      </Shot>
    )}
  />
);

// ---- 4. how a trend becomes a market -------------------------------------------------------------------

const STEPS = [
  { at: 600, n: '01', title: 'An AI radar finds it.', sub: 'It proposes trends from public sources.' },
  { at: 700, n: '02', title: 'NEAR AI Cloud reviews it.', sub: 'Verifiable models. An unsigned answer is refused.' },
  { at: 800, n: '03', title: 'An OutLayer enclave scores it.', sub: 'From 0 to 100, and the score lives on NEAR.' },
];
const SOURCES = ['X', 'Telegram', 'Bluesky', 'News', 'Wikipedia', 'Hacker News', 'Smart money'];

function Chip({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ ...BODY, fontFamily: 'Hanken Grotesk Strong', fontWeight: 500, fontSize: 24, color: C.text, padding: '10px 20px', borderRadius: 999, border: `1px solid ${C.lineStrong}`, background: C.surface2, whiteSpace: 'nowrap', ...style }}>{children}</div>;
}

function Check({ f, at, label, size = 26 }: { f: number; at: number; label: React.ReactNode; size?: number }) {
  const k = t(f, at, 14);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: k, transform: `translateX(${(1 - k) * 20}px)` }}>
      <svg width={size + 8} height={size + 8} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="11" fill={C.primarySoft} stroke={C.primary} strokeWidth="1.2" />
        <path d="M7 12.4l3.2 3.1L17 8.8" fill="none" stroke={C.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - t(f, at + 4, 12)} />
      </svg>
      <div style={{ ...BODY, fontSize: size, color: C.text }}>{label}</div>
    </div>
  );
}

/** The right-hand card of the pipeline: what each step looks like. */
function StepCard({ f, step }: { f: number; step: number }) {
  const at = STEPS[step].at;
  const k = t(f, at, 16);
  const body =
    step === 0 ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        <Eyebrow size={20}>Radar</Eyebrow>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {SOURCES.map((s, i) => {
            const c = t(f, at + 6 + i * 5, 12);
            return (
              <Chip key={s} style={{ opacity: c, transform: `translateY(${(1 - c) * 18}px)` }}>
                {s}
              </Chip>
            );
          })}
        </div>
        <div style={{ marginTop: 6, padding: '24px 26px', borderRadius: 18, background: C.surface2, border: `1px solid ${C.line}`, opacity: t(f, at + 50, 14), transform: `translateY(${(1 - t(f, at + 50, 14)) * 20}px)` }}>
          <div style={{ ...BODY, fontSize: 20, color: C.text3, ...LABEL, letterSpacing: '0.14em' }}>New candidate</div>
          <div style={{ ...DISPLAY, fontSize: 52, color: C.text, marginTop: 8 }}>World Cup</div>
          <div style={{ ...MONO, fontSize: 22, color: C.text2, marginTop: 6 }}>topic:world-cup</div>
        </div>
      </div>
    ) : step === 1 ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <Eyebrow size={20}>NEAR AI Cloud review</Eyebrow>
        <div style={{ display: 'flex' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderRadius: 999, background: C.primarySoft, border: `1px solid ${C.primary}55`, opacity: t(f, at + 6, 12) }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.primary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <div style={{ fontFamily: 'Hanken Grotesk Strong', fontWeight: 500, fontSize: 26, color: C.primaryStrong }}>Verified</div>
          </div>
        </div>
        <Check f={f} at={at + 18} label="Signed by a verifiable model in a TEE" />
        <Check f={f} at={at + 30} label="No provider_tee signature, no listing" />
        <Check f={f} at={at + 42} label="Evidence hash written on the trend" />
        <div style={{ ...MONO, fontSize: 22, color: C.text3, opacity: t(f, at + 54, 12) }}>GET /v1/reviews/:hash</div>
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Eyebrow size={20}>Attention index</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 6 }}>
          <Counter f={f} at={at + 4} to={75.45} dur={46} size={150} decimals={2} />
          <div style={{ ...DISPLAY, fontSize: 56, color: C.text3 }}>/ 100</div>
        </div>
        <div style={{ ...BODY, fontSize: 24, color: C.text2 }}>World Cup, read from the registry on NEAR testnet</div>
        <svg width="100%" height="120" viewBox="0 0 600 120" preserveAspectRatio="none" style={{ marginTop: 18 }}>
          <defs>
            <clipPath id="index-draw">
              <rect x="0" y="0" width={600 * t(f, at + 4, 46)} height="120" />
            </clipPath>
          </defs>
          <path clipPath="url(#index-draw)" d="M0 100 L200 99 L240 104 L380 100 L470 98 L500 40 L530 12 L555 12 L585 34 L600 32" fill="none" stroke={C.up} strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
        <div style={{ display: 'flex', gap: 12, marginTop: 16, opacity: t(f, at + 40, 14) }}>
          <Chip style={{ fontSize: 21 }}>ed25519 report</Chip>
          <Chip style={{ fontSize: 21 }}>checked by registry.tredio.testnet</Chip>
        </div>
      </div>
    );
  return <div style={{ opacity: k, transform: `translateY(${(1 - k) * 24}px)` }}>{body}</div>;
}

const Pipeline: Scene = ({ f }) => {
  const { vertical, pick } = useFormat();
  const step = f >= 800 ? 2 : f >= 700 ? 1 : 0;
  const rows = (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: pick(58, 34) }}>
      <div style={{ position: 'absolute', left: 21, top: 30, bottom: 30, width: 2, background: C.line }} />
      <div style={{ position: 'absolute', left: 21, top: 30, width: 2, height: `${interpolate(f, [600, 820], [0, 100], clamp)}%`, maxHeight: 'calc(100% - 60px)', background: C.primary }} />
      {STEPS.map((s, i) => {
        if (f < s.at) return <div key={s.n} style={{ height: pick(140, 120) }} />;
        const dim = i < step ? 0.38 : 1;
        return (
          <div key={s.n} style={{ display: 'flex', gap: pick(30, 24), alignItems: 'flex-start', opacity: dim, height: pick(140, 120) }}>
            <div style={{ ...LABEL, fontSize: 17, letterSpacing: '0.06em', width: 44, height: 44, borderRadius: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: i === step ? C.onPrimary : C.primary, background: i === step ? C.primary : C.bg, border: `1.5px solid ${C.primary}`, flexShrink: 0, transform: `scale(${interpolate(t(f, s.at, 10), [0, 1], [0.4, 1])})` }}>{s.n}</div>
            <div>
              <Slam f={f} at={s.at} size={pick(70, 54)} ghost={i === step}>
                {s.title}
              </Slam>
              <div style={{ ...BODY, fontSize: pick(28, 26), color: C.text2, marginTop: 10, opacity: t(f, s.at + 8, 14) }}>{s.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
  const card = (
    <div key={step} style={{ padding: pick('44px 48px', '40px 44px'), borderRadius: 26, background: 'rgba(17,17,19,0.94)', border: `1px solid ${C.lineStrong}`, boxShadow: '0 40px 100px -30px rgba(0,0,0,0.9)', height: '100%', boxSizing: 'border-box' }}>
      <StepCard f={f} step={step} />
    </div>
  );
  if (vertical) {
    return (
      <AbsoluteFill>
        <Eyebrow size={20} style={{ position: 'absolute', left: 50, top: 70, opacity: t(f, 604, 14) }}>
          How a trend becomes a market
        </Eyebrow>
        <div style={{ position: 'absolute', left: 40, top: 130, width: 1000 }}>{rows}</div>
        <div style={{ position: 'absolute', left: 40, top: 640, width: 1000, height: 640 }}>{card}</div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <Eyebrow size={22} style={{ position: 'absolute', left: 120, top: 130, opacity: t(f, 604, 14) }}>
        How a trend becomes a market
      </Eyebrow>
      <div style={{ position: 'absolute', left: 110, top: 240, width: 1020 }}>{rows}</div>
      <div style={{ position: 'absolute', left: 1150, top: 220, width: 660, height: 640 }}>{card}</div>
    </AbsoluteFill>
  );
};

// ---- 5. the index on a real trend ---------------------------------------------------------------------

const Trend: Scene = ({ f }) => (
  <Footage
    f={f}
    label={['02', 'The index']}
    labelAt={904}
    captionAt={925}
    title={
      <>
        Attention, scored <span style={{ color: C.accent }}>0 to 100.</span>
      </>
    }
    sub="A real trend on NEAR testnet, updated every few minutes."
    cam={{
      l: [
        { at: 900, rect: [230, 80, 1300, 731] },
        { at: 990, rect: [300, 230, 860, 484] },
        { at: 1070, rect: [760, 90, 800, 450] },
      ],
      v: [
        { at: 900, rect: [320, 130, 800, 704] },
        { at: 990, rect: [330, 250, 740, 651] },
        { at: 1070, rect: [1040, 110, 480, 422] },
      ],
    }}
    layers={(box, keys) => (
      <Shot f={f} src="trend.png" keys={keys} box={box} round={round(box.w < 1200)}>
        <Ring f={f} at={950} until={1040} rect={[343, 335, 700, 232]} radius={10} />
        <Ring f={f} at={1050} rect={[1097, 149, 226, 87]} radius={10} />
      </Shot>
    )}
  />
);

// ---- 6. Face ID -------------------------------------------------------------------------------------

const Passkey: Scene = ({ f }) => (
  <Footage
    f={f}
    labelAt={1100}
    captionAt={1100}
    title={
      <>
        Sign up with <span style={{ color: C.accent }}>Face ID.</span>
      </>
    }
    sub="One passkey prompt, and you are in."
    cam={{
      l: [
        { at: 1100, rect: [280, 80, 1080, 608] },
        { at: 1190, rect: [320, 118, 740, 416] },
      ],
      v: [
        { at: 1100, rect: [330, 90, 860, 757] },
        { at: 1190, rect: [325, 122, 540, 475] },
      ],
    }}
    layers={(box, keys) => (
      <Shot f={f} src="home.png" keys={keys} box={box} round={round(box.w < 1200)}>
        <Ring f={f} at={1150} rect={[371, 292, 202, 48]} radius={14} color={C.accent} />
        <PathCursor
          f={f}
          points={[
            { at: 1108, x: 760, y: 470 },
            { at: 1142, x: 486, y: 322 },
          ]}
          clicks={[1150]}
        />
      </Shot>
    )}
  />
);

/** The passkey moment: a scan frame closes on the eye, then turns lime. */
function Scan({ f, size }: { f: number; size: number }) {
  const close = t(f, 1200, 22);
  const done = f >= 1245;
  const col = done ? C.accent : C.primary;
  const gap = interpolate(close, [0, 1], [size * 0.16, 0]);
  const arm = size * 0.22;
  const sweep = interpolate(f, [1206, 1242], [0.1, 0.9], clamp);
  const corner = (r: number) => (
    <div
      key={r}
      style={{
        position: 'absolute',
        width: arm,
        height: arm,
        borderColor: col,
        borderStyle: 'solid',
        borderWidth: 0,
        ...(r === 0 ? { left: -gap, top: -gap, borderTopWidth: 5, borderLeftWidth: 5, borderTopLeftRadius: 26 } : {}),
        ...(r === 1 ? { right: -gap, top: -gap, borderTopWidth: 5, borderRightWidth: 5, borderTopRightRadius: 26 } : {}),
        ...(r === 2 ? { left: -gap, bottom: -gap, borderBottomWidth: 5, borderLeftWidth: 5, borderBottomLeftRadius: 26 } : {}),
        ...(r === 3 ? { right: -gap, bottom: -gap, borderBottomWidth: 5, borderRightWidth: 5, borderBottomRightRadius: 26 } : {}),
      }}
    />
  );
  return (
    <div style={{ position: 'relative', width: size, height: size, opacity: t(f, 1200, 8) }}>
      {[0, 1, 2, 3].map(corner)}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Glyph f={f} at={1204} size={size * 0.5} />
      </div>
      {!done && f >= 1206 && <div style={{ position: 'absolute', left: size * 0.08, right: size * 0.08, top: size * sweep, height: 3, background: C.primary, boxShadow: `0 0 18px ${C.primary}`, opacity: 0.9 }} />}
      {done && (
        <div style={{ position: 'absolute', right: -size * 0.12, bottom: -size * 0.12, width: size * 0.3, height: size * 0.3, borderRadius: '50%', background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${interpolate(t(f, 1245, 12), [0, 1], [0.3, 1])})`, boxShadow: `0 0 40px ${C.accent}66` }}>
          <svg width="56%" height="56%" viewBox="0 0 24 24">
            <path d="M5 12.5l4.2 4L19 7" fill="none" stroke={C.onAccent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

const ACCOUNT_ID = '0u5rr3y2bqwn16dvh33rwry06bpnyj97j5j9rk2gd0vyj0ncyy5nf0';

const Account: Scene = ({ f }) => {
  const { vertical, pick } = useFormat();
  const lines = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: pick(10, 6), alignItems: vertical ? 'center' : 'flex-start' }}>
      <Slam f={f} at={1200} size={pick(104, 84)}>
        A NEAR account.
      </Slam>
      <Slam f={f} at={1250} size={pick(104, 84)} color={C.text2}>
        No seed phrase.
      </Slam>
      <Slam f={f} at={1300} size={pick(104, 84)} color={C.accent}>
        No gas.
      </Slam>
    </div>
  );
  const id = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: vertical ? 'center' : 'flex-start', opacity: t(f, 1222, 10) }}>
      <Eyebrow size={pick(19, 17)} color={C.text3}>
        An account derived from the passkey itself
      </Eyebrow>
      <TypeLine f={f} at={1225} text={ACCOUNT_ID} style={{ ...MONO, fontSize: pick(27, 20), color: C.primaryStrong }} />
    </div>
  );
  const sub = f >= 1325 && <div style={{ ...BODY, fontSize: pick(32, 30), color: C.text2, opacity: t(f, 1325, 16), textAlign: vertical ? 'center' : 'left' }}>Then a week of trades without another prompt.</div>;
  if (vertical) {
    return (
      <AbsoluteFill style={{ alignItems: 'center' }}>
        <div style={{ position: 'absolute', top: 120 }}>
          <Scan f={f} size={280} />
        </div>
        <div style={{ position: 'absolute', top: 500, width: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 50 }}>
          {lines}
          {id}
          {sub}
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 230, top: 330 }}>
        <Scan f={f} size={380} />
      </div>
      <div style={{ position: 'absolute', left: 820, top: 200, display: 'flex', flexDirection: 'column', gap: 54 }}>
        {lines}
        {id}
        {sub}
      </div>
    </AbsoluteFill>
  );
};

// ---- 7. trade ---------------------------------------------------------------------------------------

const TRADE_CAM = {
  l: [
    { at: 1400, rect: [600, 230, 1100, 619] as [number, number, number, number] },
    { at: 1700, rect: [660, 252, 1000, 562] as [number, number, number, number] },
  ],
  v: [
    { at: 1400, rect: [1056, 258, 520, 458] as [number, number, number, number] },
    { at: 1700, rect: [1081, 282, 470, 414] as [number, number, number, number] },
  ],
};

/** The pointer that switches the trade panel's tabs (real tab positions from boxes.json). */
const tradeCursor = (f: number) => (
  <PathCursor
    f={f}
    points={[
      { at: 1462, x: 1250, y: 560 },
      { at: 1494, x: 1318, y: 306 },
      { at: 1562, x: 1318, y: 306 },
      { at: 1594, x: 1428, y: 306 },
      { at: 1700, x: 1428, y: 306 },
    ]}
    clicks={[1500, 1600]}
  />
);

function TradeShot({ f, box, keys, src, prev, from }: { f: number; box: Box; keys: Key[]; src: string; prev?: string; from: number }) {
  const r = round(box.w < 1200);
  return (
    <>
      {prev && f < from + 10 && <Shot f={f} src={prev} keys={keys} box={box} round={r} />}
      <Shot f={f} src={src} keys={keys} box={box} round={r} fade={prev ? 8 : 0} from={from}>
        {src === 'trend.png' && <Ring f={f} at={1450} rect={[1147, 606, 165, 97]} radius={16} color={C.up} />}
        {src === 'perp.png' && <Ring f={f} at={1550} rect={[1322, 563, 158, 28]} radius={10} />}
        {src === 'coin.png' && <Ring f={f} at={1650} rect={[1143, 388, 184, 58]} radius={10} color={C.accent} />}
        {tradeCursor(f)}
      </Shot>
    </>
  );
}

const Trade: Scene = ({ f }) => {
  const { vertical, pick } = useFormat();
  if (f >= 1700) {
    // Hyperliquid: the world-cup trend has no asset, so this beat is type only.
    return (
      <AbsoluteFill style={{ alignItems: vertical ? 'center' : 'flex-start', justifyContent: 'center', paddingLeft: pick(150, 0) }}>
        <Label f={f} at={1400} n="03" text="Trade" x={pick(80, 40)} y={pick(64, 56)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: pick(14, 10), alignItems: vertical ? 'center' : 'flex-start', textAlign: vertical ? 'center' : 'left' }}>
          <Eyebrow size={pick(22, 20)} style={{ opacity: t(f, 1700, 10), marginBottom: 14 }}>
            And the asset behind the trend
          </Eyebrow>
          <Slam f={f} at={1700} size={pick(116, 88)}>
            Hyperliquid perps,
          </Slam>
          {vertical ? (
            <>
              <Slam f={f} at={1725} size={88}>
                signed by your
              </Slam>
              <Slam f={f} at={1737} size={88} color={C.primary}>
                NEAR account.
              </Slam>
            </>
          ) : (
            <Slam f={f} at={1725} size={116}>
              signed by your <span style={{ color: C.primary }}>NEAR account.</span>
            </Slam>
          )}
          {f >= 1750 && (
            <div style={{ ...BODY, fontSize: pick(32, 29), color: C.text2, marginTop: 26, maxWidth: pick(1500, 960), opacity: t(f, 1750, 14) }}>
              Through Chain Signatures, guarded on chain: within 2% of a fresh mark, 10x at most.
            </div>
          )}
          {f >= 1762 && (
            <div style={{ ...MONO, fontSize: pick(24, 22), color: C.text3, marginTop: 10, opacity: t(f, 1762, 12) }}>
              v1.signer-prod.testnet
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }
  const sub = f >= 1600 ? 2 : f >= 1500 ? 1 : 0;
  const copy = [
    { at: 1425, title: <>Buy <span style={{ color: C.up }}>Up</span> or <span style={{ color: C.down }}>Down.</span></>, sub: 'Each token pays 1 USDC if it is right, on an on-chain order book.' },
    { at: 1525, title: <>Attention perps, up to <span style={{ color: C.accent }}>3x.</span></>, sub: 'Long or short the index itself, with funding from the skew.' },
    { at: 1625, title: <>A <span style={{ color: C.accent }}>coin</span> for every trend.</>, sub: 'A bonding curve whose floor ratchets up with peak attention.' },
  ][sub];
  const src = ['trend.png', 'perp.png', 'coin.png'][sub];
  const prev = sub > 0 ? ['trend.png', 'perp.png', 'coin.png'][sub - 1] : undefined;
  const from = [1400, 1500, 1600][sub];
  return (
    <Footage
      key={sub}
      f={f}
      label={['03', 'Trade']}
      labelAt={1404}
      captionAt={copy.at}
      title={copy.title}
      sub={copy.sub}
      cam={TRADE_CAM}
      layers={(box, keys) => <TradeShot f={f} box={box} keys={keys} src={src} prev={prev} from={from} />}
    />
  );
};

// ---- 8. deposit -------------------------------------------------------------------------------------

const Deposit: Scene = ({ f }) => (
  <Footage
    f={f}
    label={['04', 'Deposit']}
    labelAt={1804}
    captionAt={1825}
    title={
      <>
        Deposit from <span style={{ color: C.accent }}>any chain.</span>
      </>
    }
    sub="Through NEAR Intents 1Click. On testnet, quotes are dry runs."
    cam={{
      l: [
        { at: 1800, rect: [380, 10, 1060, 596] },
        { at: 1900, rect: [470, 20, 880, 495] },
      ],
      v: [
        { at: 1800, rect: [560, 60, 720, 640] },
        { at: 1900, rect: [580, 80, 660, 587] },
      ],
    }}
    layers={(box, keys) => (
      <Shot f={f} src="deposit.png" keys={keys} box={box} round={round(box.w < 1200)}>
        <Ring f={f} at={1850} rect={[615, 276, 60, 23]} radius={11} color={C.warn} />
      </Shot>
    )}
  />
);

// ---- 9. agents --------------------------------------------------------------------------------------

/** The request and the 402 are the API's real answer (GET on the local API, 2026-11-06). */
const TERM: { at: number; text: string; color: string; typed?: boolean }[] = [
  { at: 1925, text: '> GET /v1/x402/trends/topic:world-cup/history', color: C.text, typed: true },
  { at: 1975, text: '< 402 Payment Required', color: C.warn },
  { at: 1983, text: '  scheme exact   network near:testnet', color: C.text2 },
  { at: 1991, text: '  0.01 USDC to tredio-treasury.testnet', color: C.text2 },
  { at: 2000, text: '> PAYMENT-SIGNATURE: one USDC ft_transfer, NEP-366', color: C.text, typed: true },
  { at: 2050, text: '< 200 OK   relayed by tredio-relayer.testnet', color: C.up },
];

const Agents: Scene = ({ f }) => {
  const { vertical, pick } = useFormat();
  const size = pick(31, 22);
  const term = (
    <div style={{ borderRadius: 24, background: 'rgba(17,17,19,0.96)', border: `1px solid ${C.lineStrong}`, boxShadow: '0 40px 100px -30px rgba(0,0,0,0.9)', overflow: 'hidden', opacity: t(f, 1906, 14), transform: `translateY(${(1 - t(f, 1906, 18)) * 30}px)` }}>
      <div style={{ height: pick(58, 50), display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', borderBottom: `1px solid ${C.line}`, background: C.surface2 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: C.surface3, border: `1px solid ${C.lineStrong}` }} />
        ))}
        <div style={{ ...LABEL, fontSize: pick(17, 15), color: C.text3, marginLeft: 16 }}>An agent calls the Tredio API</div>
      </div>
      <div style={{ padding: pick('34px 40px 40px', '28px 26px 32px'), display: 'flex', flexDirection: 'column', gap: pick(16, 14), minHeight: pick(380, 420) }}>
        {TERM.map((l, i) =>
          f < l.at ? null : l.typed ? (
            <TypeLine key={i} f={f} at={l.at} text={l.text} caret={f < (TERM[i + 1]?.at ?? 9999)} style={{ ...MONO, fontSize: size, color: l.color }} />
          ) : (
            <div key={i} style={{ ...MONO, fontSize: size, color: l.color, whiteSpace: 'pre', opacity: t(f, l.at, 6) }}>
              {l.text}
            </div>
          ),
        )}
      </div>
    </div>
  );
  const head = (
    <>
      <Slam f={f} at={1900} size={pick(104, 76)}>
        Agents pay <span style={{ color: C.accent }}>per call.</span>
      </Slam>
      <div style={{ ...BODY, fontSize: pick(32, 29), color: C.text2, marginTop: 14, opacity: t(f, 1910, 14) }}>x402 in USDC on NEAR, and the relayer pays the gas.</div>
    </>
  );
  if (vertical) {
    return (
      <AbsoluteFill>
        <Label f={f} at={1902} n="05" text="Agents" x={40} y={56} />
        <div style={{ position: 'absolute', left: 40, top: 150, width: 1000 }}>{head}</div>
        <div style={{ position: 'absolute', left: 40, top: 470, width: 1000 }}>{term}</div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <Label f={f} at={1902} n="05" text="Agents" />
      <div style={{ position: 'absolute', left: 150, top: 170 }}>{head}</div>
      <div style={{ position: 'absolute', left: 150, top: 430, width: 1620 }}>{term}</div>
    </AbsoluteFill>
  );
};

// ---- 10. proof: live on testnet ---------------------------------------------------------------------------

const Proof: Scene = ({ f }) => {
  if (f < 2200) {
    return (
      <Footage
        f={f}
        label={['06', 'Live on testnet']}
        labelAt={2104}
        captionAt={2125}
        title={
          <>
            Running on <span style={{ color: C.accent }}>NEAR testnet.</span>
          </>
        }
        sub="The oracle, the chain and every service, checked every ten seconds."
        cam={{
          l: [
            { at: 2100, rect: [250, 0, 1320, 742] },
            { at: 2200, rect: [300, 150, 1040, 585] },
          ],
          v: [
            { at: 2100, rect: [320, 80, 960, 845] },
            { at: 2200, rect: [330, 170, 620, 546] },
          ],
        }}
        layers={(box, keys) => (
          <Shot f={f} src="status.png" keys={keys} box={box} round={round(box.w < 1200)}>
            <Ring f={f} at={2150} rect={[330, 191, 1176, 135]} radius={22} color={C.up} />
          </Shot>
        )}
      />
    );
  }
  if (f < 2300) {
    return (
      <Footage
        f={f}
        label={['06', 'Live on testnet']}
        labelAt={2104}
        captionAt={2225}
        title={
          <>
            Every service on <span style={{ color: C.accent }}>gas keys.</span>
          </>
        }
        sub="Prepaid gas and parallel nonce lanes, refilled from one treasury."
        cam={{
          l: [
            { at: 2200, rect: [300, 1120, 1240, 698] },
            { at: 2300, rect: [320, 1150, 1080, 608] },
          ],
          v: [
            { at: 2200, rect: [330, 1190, 760, 669] },
            { at: 2300, rect: [330, 1270, 600, 528] },
          ],
        }}
        layers={(box, keys) => (
          <Shot f={f} src="status-full.png" keys={keys} box={box} round={round(box.w < 1200)}>
            <Ring f={f} at={2250} rect={[354, 1332, 560, 36]} radius={10} />
          </Shot>
        )}
      />
    );
  }
  return (
    <Footage
      f={f}
      label={['06', 'Live on testnet']}
      labelAt={2104}
      captionAt={2325}
      title={
        <>
          Calls, leaders, <span style={{ color: C.accent }}>copy-trading.</span>
        </>
      }
      sub="Every record comes from settled trades."
      cam={{
        l: [
          { at: 2300, rect: [290, 130, 1020, 574] },
          { at: 2400, rect: [320, 150, 900, 506] },
        ],
        v: [
          { at: 2300, rect: [380, 170, 720, 634] },
          { at: 2400, rect: [400, 190, 670, 596] },
        ],
      }}
      layers={(box, keys) => <Shot f={f} src="leaders-traders.png" keys={keys} box={box} round={round(box.w < 1200)} />}
    />
  );
};

// ---- 11. the statement ------------------------------------------------------------------------------

const Echo: Scene = ({ f }) => {
  const { pick } = useFormat();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: pick(0, 40) }}>
      <WordByWord f={f} at={2400} text="The internet’s attention is a market." size={pick(150, 108)} every={10} brand={[2]} accent={[5]} maxWidth={pick(1500, 1000)} />
      <Flash f={f} at={2450} color={C.accent} strength={0.28} dur={16} />
    </AbsoluteFill>
  );
};

// ---- 12. end card -----------------------------------------------------------------------------------

const End: Scene = ({ f }) => {
  const { vertical, pick } = useFormat();
  const blink = Math.floor(f / 18) % 2 === 0;
  const cta = t(f, 2550, 16);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: pick(40, 36) }}>
      <Lockup f={f} at={2500} wordAt={2512} height={pick(124, 96)} />
      <Rise f={f} at={2526} size={pick(60, 50)} color={C.text2}>
        Trade the world&rsquo;s attention.
      </Rise>
      <div style={{ fontFamily: 'Hanken Grotesk Strong', fontWeight: 500, fontSize: pick(40, 36), letterSpacing: '0.02em', color: C.primary, opacity: t(f, 2538, 14) }}>{BRAND.url}</div>
      {f >= 2550 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: pick('20px 34px', '18px 30px'), marginTop: 10, borderRadius: 999, border: `1px solid ${C.accent}66`, background: C.accentSoft, opacity: cta, transform: `translateY(${(1 - cta) * 24}px)` }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, background: C.accent, opacity: blink ? 1 : 0.3, boxShadow: `0 0 16px ${C.accent}` }} />
          <div style={{ ...LABEL, fontSize: pick(26, 23), color: C.text, letterSpacing: '0.16em' }}>Live on NEAR testnet</div>
        </div>
      )}
      <div style={{ ...BODY, fontSize: pick(26, 24), color: C.text3, opacity: t(f, 2575, 16), textAlign: 'center', maxWidth: vertical ? 900 : undefined }}>
        Up/Down &middot; Attention perps &middot; Trend coins &middot; Hyperliquid &middot; x402 for agents
      </div>
    </AbsoluteFill>
  );
};

const SCENES: Record<string, Scene> = { hook: Hook, reveal: Reveal, markets: Markets, pipeline: Pipeline, trend: Trend, passkey: Passkey, account: Account, trade: Trade, deposit: Deposit, agents: Agents, proof: Proof, echo: Echo, end: End };

export function Film({ mute = false, poster = false }: { mute?: boolean; poster?: boolean }) {
  const frame = useCurrentFrame();
  const f = poster ? timeline.frames - 40 : frame;
  const scene = timeline.scenes.find((s) => f >= s.from && f < s.to) ?? timeline.scenes.at(-1)!;
  const Scene = SCENES[scene.id];
  const since = sinceHit(f);
  const kick = interpolate(since, [0, 6], [1.01, 1], clamp);
  const shake = since < 6 ? Math.sin(f * 2.3) * (6 - since) * 0.7 : 0;
  const fadeOut = interpolate(f, [timeline.frames - 24, timeline.frames], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: 'hidden' }}>
      <Backdrop f={f} />
      <AbsoluteFill style={{ transform: `scale(${kick}) translate(${shake}px, ${shake * 0.6}px)`, opacity: fadeOut }}>{Scene && <Scene f={f} />}</AbsoluteFill>
      {!mute && <Audio src={staticFile('audio/track.wav')} />}
    </AbsoluteFill>
  );
}
