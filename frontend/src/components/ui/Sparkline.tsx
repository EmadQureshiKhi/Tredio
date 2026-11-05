import { useId } from "react";

/**
 * A small SVG line of recent values; the stroke follows the direction of change. It draws itself
 * in when it first appears, and a new reading eases the line to its new shape (where the browser
 * animates path data; elsewhere it redraws at once).
 */
export function Sparkline({ values, width = 120, height = 36, className }: { values: readonly number[]; width?: number; height?: number; className?: string }) {
  // Unique per instance: two sparklines with alike values must never share a gradient.
  const id = `spark${useId().replace(/[^\w-]/g, "")}`;
  if (values.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max - min < 1e-9;
  const span = flat ? 1 : max - min;
  const step = width / (values.length - 1);
  // A flat series sits mid-height in a neutral color: no move is not a fall.
  const pts = values.map((v, i) => [i * step, flat ? height / 2 : height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const rising = values[values.length - 1]! >= values[0]!;
  const color = flat ? "var(--text-3)" : rising ? "var(--up)" : "var(--down)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {flat ? null : <path className="spark-fill" d={`${d} L${width},${height} L0,${height} Z`} style={{ d: `path("${d} L${width},${height} L0,${height} Z")` }} fill={`url(#${id})`} />}
      <path className="spark-line" pathLength={1} d={d} style={{ d: `path("${d}")` }} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
