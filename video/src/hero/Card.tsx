// The trend card of the hero film, laid out to match the source film's cards: avatar, name and handle,
// TREND %, $ MCAP, a lavender sparkline ending in a dot, VOL in USDC and the 1.0x pill.
// Every measure is in the card's base pixels (540 x 305, as on the flat grid) times `s`.
import React from 'react';

import { H, HF } from './look';

export type Icon = 'btc' | 'eth' | 'near' | 'hype' | 'ball' | 'agent' | 'sun' | 'dollar' | 'rate' | 'planet' | 'film' | 'chip';

export type Trend = { name: string; handle: string; trend: string; mcap: string; vol: string; spark: number[]; icon: Icon };

export const CARD_W = 540;
export const CARD_H = 305;

// Every figure is illustrative, as in the source film.
export const TRENDS: Record<string, Trend> = {
  worldCup: { name: 'World Cup Final', handle: 'worldCupFinal', trend: '6.1%', mcap: '$48.2K', vol: '12.4K USDC', spark: [0.12, 0.42, 0.42, 0.66, 0.86, 0.92], icon: 'ball' },
  agents: { name: 'AI Agents', handle: 'aiAgents', trend: '4.8%', mcap: '$36.5K', vol: '9.1K USDC', spark: [0.1, 0.55, 0.48, 0.3, 0.42, 0.6], icon: 'agent' },
  heatwave: { name: 'Heatwave', handle: 'heatwave', trend: '3.9%', mcap: '$31.0K', vol: '7.6K USDC', spark: [0.12, 0.52, 0.66, 0.24, 0.36, 0.52], icon: 'sun' },
  stables: { name: 'Stablecoins', handle: 'stablecoins', trend: '2.9%', mcap: '$22.7K', vol: '5.3K USDC', spark: [0.5, 0.62, 0.38, 0.28, 0.2, 0.46], icon: 'dollar' },
  rates: { name: 'Fed Rate Cut', handle: 'fedRateCut', trend: '2.4%', mcap: '$18.9K', vol: '4.2K USDC', spark: [0.82, 0.78, 0.55, 0.47, 0.44, 0.6], icon: 'rate' },
  mars: { name: 'Mars Landing', handle: 'marsLanding', trend: '1.7%', mcap: '$12.8K', vol: '2.9K USDC', spark: [0.85, 0.66, 0.66, 0.66, 0.66, 0.85], icon: 'planet' },
  btc: { name: 'BTC', handle: 'bitcoin', trend: '6.4%', mcap: '$64.1K', vol: '18.2K USDC', spark: [0.7, 0.42, 0.34, 0.5, 0.72, 0.95], icon: 'btc' },
  eth: { name: 'ETH', handle: 'ethereum', trend: '5.4%', mcap: '$41.9K', vol: '11.7K USDC', spark: [0.56, 0.3, 0.36, 0.52, 0.66, 0.74], icon: 'eth' },
  near: { name: 'NEAR', handle: 'near', trend: '4.2%', mcap: '$29.6K', vol: '8.8K USDC', spark: [0.42, 0.3, 0.42, 0.3, 0.2, 0.44], icon: 'near' },
  hype: { name: 'HYPE', handle: 'hyperliquid', trend: '3.1%', mcap: '$27.3K', vol: '6.9K USDC', spark: [0.12, 0.46, 0.4, 0.5, 0.62, 0.88], icon: 'hype' },
  film: { name: 'Box Office Week', handle: 'boxOffice', trend: '1.9%', mcap: '$14.1K', vol: '3.4K USDC', spark: [0.38, 0.28, 0.28, 0.28, 0.38, 0.52], icon: 'film' },
  chips: { name: 'Chip Exports', handle: 'chipExports', trend: '1.3%', mcap: '$9.7K', vol: '2.1K USDC', spark: [0.66, 0.55, 0.55, 0.55, 0.55, 0.66], icon: 'chip' },
};

/** The round avatar: a flat colour disc with a simple mark (no third-party logos on cards). */
export function Avatar({ icon, size }: { icon: Icon; size: number }) {
  const disc = (fill: string, body: React.ReactNode, ring?: string) => (
    <svg width={size} height={size} viewBox="0 0 44 44" style={{ display: 'block' }}>
      <circle cx="22" cy="22" r="22" fill={fill} />
      {ring ? <circle cx="22" cy="22" r="21.4" fill="none" stroke={ring} strokeWidth="1.2" /> : null}
      {body}
    </svg>
  );
  const letter = (ch: string, color: string, fs = 24, dy = 0) => (
    <text x="22" y={22 + fs * 0.36 + dy} textAnchor="middle" fontFamily={HF.sans} fontWeight={800} fontSize={fs} fill={color}>{ch}</text>
  );
  switch (icon) {
    case 'btc':
      return disc('#F7931A', (
        <g transform="rotate(14 22 22)">
          <rect x="18.2" y="9.5" width="2.4" height="25" rx="1" fill="#fff" />
          <rect x="23.4" y="9.5" width="2.4" height="25" rx="1" fill="#fff" />
          {letter('B', '#fff', 23, 0.5)}
        </g>
      ));
    case 'eth':
      return disc('#ECECEC', (
        <g>
          <polygon points="22,7.5 30.5,22.4 22,27.4" fill="#3C3C3D" />
          <polygon points="22,7.5 13.5,22.4 22,27.4" fill="#8C8C8C" />
          <polygon points="22,29.2 30.5,24.2 22,36.5" fill="#3C3C3D" />
          <polygon points="22,29.2 13.5,24.2 22,36.5" fill="#8C8C8C" />
        </g>
      ));
    case 'near':
      return disc('#101012', letter('N', '#F2F4F2', 22), 'rgba(255,255,255,0.18)');
    case 'hype':
      return disc('#97FCE4', letter('H', '#062A24', 22));
    case 'ball':
      return disc('#F4F4F2', (
        <g fill="#1B1B1D">
          <polygon points="22,14.5 29.1,19.7 26.4,28.1 17.6,28.1 14.9,19.7" />
          <polygon points="22,0.8 27.4,2 22,6.4 16.6,2" />
          <polygon points="42.2,15.4 43.4,21.4 37.4,22.6 38.6,16.2" />
          <polygon points="34.6,39.6 29.4,42.6 27.8,36.6 33.6,35.6" />
          <polygon points="9.4,39.6 14.6,42.6 16.2,36.6 10.4,35.6" />
          <polygon points="1.8,15.4 0.6,21.4 6.6,22.6 5.4,16.2" />
          <path d="M22 14.5V6.4M29.1 19.7L38 19M26.4 28.1L31 35.8M17.6 28.1L13 35.8M14.9 19.7L6 19" stroke="#1B1B1D" strokeWidth="1.3" />
        </g>
      ));
    case 'agent':
      return disc('#4C6FFF', (
        <g>
          <rect x="21.2" y="8" width="1.6" height="5" fill="#fff" />
          <circle cx="22" cy="8" r="2" fill="#fff" />
          <rect x="11" y="13" width="22" height="18" rx="6" fill="#fff" />
          <circle cx="17.5" cy="22" r="2.6" fill="#4C6FFF" />
          <circle cx="26.5" cy="22" r="2.6" fill="#4C6FFF" />
          <rect x="17" y="34" width="10" height="2.4" rx="1.2" fill="#fff" opacity="0.85" />
        </g>
      ));
    case 'sun':
      return disc('#FF5A36', (
        <g fill="#FFD43B">
          <circle cx="22" cy="22" r="7.2" />
          {Array.from({ length: 8 }, (_, i) => <rect key={i} x="20.8" y="5.5" width="2.4" height="6" rx="1.2" transform={`rotate(${i * 45} 22 22)`} />)}
        </g>
      ));
    case 'dollar':
      return disc('#2BB673', letter('$', '#fff', 26));
    case 'rate':
      return disc('#3D5AFE', letter('%', '#fff', 22));
    case 'planet':
      return disc('#C1440E', (
        <g fill="#8E2F08">
          <circle cx="15" cy="16" r="4" />
          <circle cx="28" cy="27" r="5.5" />
          <circle cx="27" cy="12" r="2.2" />
          <circle cx="14" cy="30" r="2.6" />
        </g>
      ));
    case 'film':
      return disc('#E0B23C', (
        <g>
          <rect x="11" y="14" width="22" height="16" rx="2" fill="#2A2112" />
          {[0, 1, 2, 3].map((i) => <rect key={i} x={13 + i * 5.2} y="16" width="2.6" height="2.4" fill="#E0B23C" />)}
          {[0, 1, 2, 3].map((i) => <rect key={i} x={13 + i * 5.2} y="25.6" width="2.6" height="2.4" fill="#E0B23C" />)}
        </g>
      ));
    case 'chip':
      return disc('#1F8A70', (
        <g fill="#E8FFF7">
          <rect x="14" y="14" width="16" height="16" rx="2.5" />
          {[0, 1, 2].map((i) => <rect key={`t${i}`} x={16.8 + i * 4.4} y="9.5" width="1.8" height="4" />)}
          {[0, 1, 2].map((i) => <rect key={`b${i}`} x={16.8 + i * 4.4} y="30.5" width="1.8" height="4" />)}
          {[0, 1, 2].map((i) => <rect key={`l${i}`} x="9.5" y={16.8 + i * 4.4} width="4" height="1.8" />)}
          {[0, 1, 2].map((i) => <rect key={`r${i}`} x="30.5" y={16.8 + i * 4.4} width="4" height="1.8" />)}
          <rect x="18" y="18" width="8" height="8" rx="1" fill="#1F8A70" />
        </g>
      ));
  }
}

/** One card; `s` scales every measure. */
export function TrendCard({ d, s = 1, style }: { d: Trend; s?: number; style?: React.CSSProperties }) {
  const u = (n: number) => n * s;
  const mono: React.CSSProperties = { fontFamily: HF.mono, position: 'absolute', whiteSpace: 'nowrap', lineHeight: 1 };
  // The sparkline: six points across the chart box, 1 = top.
  const x0 = 44;
  const x1 = 479;
  const y0 = 136;
  const y1 = 226;
  const pts = d.spark.map((v, i) => [x0 + ((x1 - x0) * i) / (d.spark.length - 1), y1 - v * (y1 - y0)] as const);
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const [ex, ey] = pts[pts.length - 1];
  return (
    <div style={{ position: 'absolute', width: u(CARD_W), height: u(CARD_H), borderRadius: u(18), background: H.card.bg, boxShadow: `inset 0 0 0 ${u(2.2)}px ${H.card.rim}`, overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', left: u(24), top: u(24) }}>
        <Avatar icon={d.icon} size={u(44)} />
      </div>
      <div style={{ position: 'absolute', left: u(80), top: u(29), fontFamily: HF.sans, fontWeight: 500, fontSize: u(18.5), lineHeight: 1, color: H.card.text, whiteSpace: 'nowrap', letterSpacing: '-0.005em' }}>{d.name}</div>
      <div style={{ ...mono, left: u(80), top: u(61), fontSize: u(11.5), color: H.card.handle }}>{d.handle}</div>
      <div style={{ ...mono, right: u(25), top: u(30), fontSize: u(9.5), color: H.card.dim, letterSpacing: '0.06em' }}>TREND</div>
      <div style={{ ...mono, right: u(25), top: u(48), fontSize: u(20), fontWeight: 500, color: H.card.text }}>{d.trend}</div>
      <div style={{ ...mono, left: u(25), top: u(115), fontSize: u(25), fontWeight: 600, color: H.card.text, display: 'flex', alignItems: 'baseline', gap: u(8) }}>
        <span>{d.mcap}</span>
        <span style={{ fontSize: u(11), fontWeight: 400, color: H.card.dim }}>MCAP</span>
      </div>
      <svg width={u(CARD_W)} height={u(CARD_H)} viewBox={`0 0 ${CARD_W} ${CARD_H}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <polyline points={line} fill="none" stroke={H.card.line} strokeOpacity="0.1" strokeWidth="26" strokeLinejoin="round" strokeLinecap="round" transform="translate(0 12)" style={{ filter: `blur(${u(9)}px)` }} />
        <line x1="26" y1="235" x2="514" y2="235" stroke={H.card.base} strokeWidth="1.2" />
        <polyline points={line} fill="none" stroke={H.card.line} strokeOpacity="0.35" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" style={{ filter: `blur(${u(3)}px)` }} />
        <polyline points={line} fill="none" stroke={H.card.line} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={ex} cy={ey} r="4.6" fill={H.card.dot} />
      </svg>
      <div style={{ ...mono, left: u(27), top: u(259), fontSize: u(10.5), color: H.card.dim, display: 'flex', alignItems: 'baseline', gap: u(9) }}>
        <span>VOL</span>
        <span style={{ fontSize: u(12), color: H.card.vol }}>{d.vol}</span>
      </div>
      <div style={{ position: 'absolute', right: u(25), top: u(254), height: u(24), padding: `0 ${u(9)}px`, borderRadius: u(5), background: H.card.pill, color: H.card.pillText, fontFamily: HF.mono, fontSize: u(12), lineHeight: `${u(24)}px` }}>1.0x</div>
    </div>
  );
}
