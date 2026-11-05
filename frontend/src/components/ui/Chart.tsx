"use client";
import {
  type AreaData,
  AreaSeries,
  type AutoscaleInfo,
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LastPriceAnimationMode,
  LineStyle,
  type Time,
  TickMarkType,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

/**
 * Charts on TradingView's lightweight-charts, drawn in the app's theme tokens. Area for the
 * attention index, candles for prices. The chart and its series are made once: new readings
 * update the series in place, a different history replaces its data, and theme, format and
 * reference changes apply as options, so a live chart never flashes or loses its crosshair.
 */

export interface SeriesPoint {
  t: number;
  v: number;
}
export interface CandlePoint {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

type Row = AreaData<Time> | CandlestickData<Time>;
type Kind = "area" | "candles";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Times on the axis and crosshair in the viewer's own time zone (the library draws UTC). */
const local = (time: Time) => new Date((time as number) * 1000);
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function tickMark(time: Time, type: TickMarkType): string {
  const d = local(time);
  if (type === TickMarkType.Year) return String(d.getFullYear());
  if (type === TickMarkType.Month) return d.toLocaleDateString(undefined, { month: "short" });
  if (type === TickMarkType.DayOfMonth) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return clock(d);
}
const crosshairTime = (time: Time) => `${local(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock(local(time))}`;
const plain = (v: number) => v.toFixed(2);

/**
 * A token color at `a` of its own opacity, in a form the canvas reads. Tokens arrive as the
 * browser serializes them: hex with or without alpha (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb().
 */
export function withAlpha(color: string, a: number): string {
  let hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1];
  if (hex) {
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    const base = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return `#${hex.slice(0, 6)}${Math.round(base * a * 255).toString(16).padStart(2, "0")}`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
  if (!rgb) return color;
  const [r, g, b, x = "1"] = rgb[1]!.split(",").map((p) => p.trim());
  return `rgba(${r}, ${g}, ${b}, ${Number((Number(x) * a).toFixed(3))})`;
}

/** The value range to draw: always the reference, and at least `minRange` wide around the data. */
export function fitRange(min: number, max: number, minRange: number, reference?: number): { minValue: number; maxValue: number } {
  let lo = reference === undefined ? min : Math.min(min, reference);
  let hi = reference === undefined ? max : Math.max(max, reference);
  if (hi - lo < minRange) {
    const mid = (hi + lo) / 2;
    lo = mid - minRange / 2;
    hi = mid + minRange / 2;
  }
  return { minValue: lo, maxValue: hi };
}

/** True when `next` is `prev` with its last point revised or new points after it (a live reading). */
export function extendsSeries(prev: ReadonlyArray<{ time: Time }>, next: ReadonlyArray<{ time: Time }>): boolean {
  if (prev.length === 0 || next.length < prev.length) return false;
  const last = prev.length - 1;
  return next[0]!.time === prev[0]!.time && next[last]!.time === prev[last]!.time;
}

const same = (a: Row, b: Row) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `minRange` keeps the value axis at least that wide, so a flat line never shows a column of
 * identical labels; the reference value always stays in view.
 */
export function Chart({ points, candles, height = 260, reference, valueFormat, minRange = 0 }: { points?: readonly SeriesPoint[]; candles?: readonly CandlePoint[]; height?: number; reference?: { value: number; label: string }; valueFormat?: (v: number) => string; minRange?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<IPriceLine | null>(null);
  /** The rows the series holds, to tell a new reading from a different history. */
  const shownRef = useRef<Row[]>([]);
  /** Read by the autoscaler and the axis formatter, so changing them never rebuilds the chart. */
  const scaleRef = useRef({ minRange, reference: reference?.value });
  const formatRef = useRef(valueFormat);
  const paintRef = useRef<() => void>(() => {});
  const kind: Kind = candles && candles.length > 0 ? "candles" : "area";
  const initialHeight = useRef(height);

  useEffect(() => {
    scaleRef.current = { minRange, reference: reference?.value };
    formatRef.current = valueFormat;
  });

  // The chart and its one series, made once per kind.
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const chart = createChart(host, {
      height: initialHeight.current,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: false },
      grid: { vertLines: { visible: false } },
      // Room above and below the line; edge labels only when they fit whole.
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.1 }, entireTextOnly: true },
      // Every time label in one weight: the library bolds the ones it counts as major.
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickMark, allowBoldLabels: false },
      handleScroll: false,
      handleScale: false,
      localization: { timeFormatter: crosshairTime, priceFormatter: (v: number) => (formatRef.current ?? plain)(v) },
    });
    const series =
      kind === "candles"
        ? chart.addSeries(CandlestickSeries, { borderVisible: false })
        : chart.addSeries(AreaSeries, {
            lineWidth: 2,
            priceLineVisible: false,
            // The live value is the page's headline; an axis tag would cover the scale's labels.
            lastValueVisible: false,
            // A new reading pulses once at the line's end, unless the system asks for less motion.
            lastPriceAnimation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? LastPriceAnimationMode.Disabled : LastPriceAnimationMode.OnDataUpdate,
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
              const info = base();
              if (!info?.priceRange) return info;
              const { minRange: range, reference: ref } = scaleRef.current;
              return { ...info, priceRange: fitRange(info.priceRange.minValue, info.priceRange.maxValue, range, ref) };
            },
          });
    chartRef.current = chart;
    seriesRef.current = series;

    // Colors come from the theme tokens; a flat line is neutral, since no move is not a fall.
    const paint = () => {
      const strong = css("--line-strong");
      chart.applyOptions({
        layout: { textColor: css("--text-3") },
        grid: { horzLines: { color: css("--line") } },
        crosshair: { vertLine: { color: strong, labelBackgroundColor: css("--surface-3") }, horzLine: { color: strong, labelBackgroundColor: css("--surface-3") } },
      });
      if (kind === "candles") {
        (series as ISeriesApi<"Candlestick">).applyOptions({ upColor: css("--up"), downColor: css("--down"), wickUpColor: css("--up"), wickDownColor: css("--down") });
      } else {
        const rows = shownRef.current as AreaData<Time>[];
        const first = rows[0]?.value ?? 0;
        const last = rows[rows.length - 1]?.value ?? 0;
        const flat = last === first;
        const color = flat ? css("--text-3") : last > first ? css("--up") : css("--down");
        // A flat line gets no fill: a band of color under it would read as a level, not a lack of movement.
        (series as ISeriesApi<"Area">).applyOptions({ lineColor: color, topColor: withAlpha(color, flat ? 0 : 0.2), bottomColor: withAlpha(color, 0) });
      }
      lineRef.current?.applyOptions({ color: css("--text-3") });
    };
    paintRef.current = paint;
    paint();

    const resize = new ResizeObserver(() => chart.applyOptions({ width: host.clientWidth }));
    resize.observe(host);
    // Repaint in the new colors when the theme flips.
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", paint);
    return () => {
      resize.disconnect();
      theme.disconnect();
      media.removeEventListener("change", paint);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineRef.current = null;
      shownRef.current = [];
      paintRef.current = () => {};
    };
  }, [kind]);

  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  // Data: a new or revised last reading updates in place; anything else (a range switch, a window
  // that moved past its oldest point) replaces the data on the same series.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const next: Row[] =
      kind === "candles"
        ? dedupe((candles ?? []).map((c) => ({ time: c.t as Time, open: c.o, high: c.h, low: c.l, close: c.c })))
        : dedupe((points ?? []).map((p) => ({ time: p.t as Time, value: p.v })));
    const prev = shownRef.current;
    if (extendsSeries(prev, next)) {
      for (let i = prev.length - 1; i < next.length; i++) {
        if (i >= prev.length || !same(prev[i]!, next[i]!)) (series as ISeriesApi<"Area">).update(next[i] as AreaData<Time>);
      }
    } else {
      (series as ISeriesApi<"Area">).setData(next as AreaData<Time>[]);
    }
    shownRef.current = next;
    paintRef.current();
    chart.timeScale().fitContent();
  }, [points, candles, kind]);

  // The reference: a dashed line with its label in the legend (an axis label of its own would
  // collide with the scale's labels whenever it sits near one).
  const refValue = reference?.value;
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || kind !== "area") return;
    if (refValue === undefined) {
      if (lineRef.current) series.removePriceLine(lineRef.current);
      lineRef.current = null;
    } else if (lineRef.current) {
      lineRef.current.applyOptions({ price: refValue });
    } else {
      lineRef.current = series.createPriceLine({ price: refValue, color: css("--text-3"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
    }
    // The autoscaler keeps the reference in view: let it measure again.
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  }, [refValue, kind]);

  // A new formatter redraws the axis labels; the chart itself stays.
  useEffect(() => {
    chartRef.current?.applyOptions({ localization: { timeFormatter: crosshairTime, priceFormatter: (v: number) => (formatRef.current ?? plain)(v) } });
  }, [valueFormat]);

  return (
    <div className="relative w-full">
      <div ref={el} style={{ height }} className="w-full" />
      {reference?.label && points && points.length > 0 && kind === "area" ? (
        <p className="pointer-events-none absolute left-1.5 top-0 flex items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--surface)_85%,transparent)] px-1.5 py-0.5 text-[11.5px] text-text-3">
          <span aria-hidden className="w-3.5 border-t border-dashed border-text-3" />
          {reference.label} <span className="num text-text-2">{valueFormat ? valueFormat(reference.value) : reference.value}</span>
        </p>
      ) : null}
    </div>
  );
}

/** lightweight-charts needs strictly increasing times. */
function dedupe<T extends { time: Time }>(rows: T[]): T[] {
  const out: T[] = [];
  for (const r of rows.sort((a, b) => (a.time as number) - (b.time as number))) {
    if (out.length && out[out.length - 1]!.time === r.time) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}
