// Hand-rolled chart primitives for the admin usage dashboard — deliberately
// dependency-free (inline SVG + divs), matching the house zinc/emerald style.
import { useEffect, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from './ui';

export interface ChartSeries {
  name: string;
  /** Hex fill — SVG segments don't go through Tailwind classes. */
  color: string;
  values: number[];
}

/** Container width via ResizeObserver — keeps the SVG pixel-crisp at any card size. */
function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round an axis maximum up to a friendly 1/2/5×10^k number. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

/** Compact number for axis ticks (tokens, requests). Small decimals kept for cost. */
export function compactNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 100) / 10}K`;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Stacked vertical bar chart. One entry per series, `values` aligned to
 * `labels`. Axes, gridlines and x ticks are drawn automatically (ticks thin
 * to fit); hover shows native tooltips per column.
 */
export function StackedBarChart({
  labels,
  tooltipLabels,
  series,
  height = 190,
  formatValue = compactNum,
}: {
  labels: string[];
  /** Full-text labels for hover tooltips (defaults to `labels`). */
  tooltipLabels?: string[];
  series: ChartSeries[];
  height?: number;
  formatValue?: (n: number) => string;
}) {
  const [ref, width] = useContainerWidth();
  const tips = tooltipLabels ?? labels;
  const n = series[0]?.values.length ?? 0;
  const totals = series.length ? series[0].values.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] ?? 0), 0)) : [];
  const maxTotal = Math.max(...totals, 0);

  const padTop = 8;
  const padRight = 4;
  const padLeft = 46;
  const padBottom = 20;
  const innerW = Math.max(width - padLeft - padRight, 0);
  const innerH = Math.max(height - padTop - padBottom, 0);
  const yMax = niceMax(maxTotal);
  const yTicks = 4;
  const slot = n > 0 ? innerW / n : 0;
  const barW = Math.max(Math.min(slot * 0.68, 36), 1);
  const tickEvery = n > 0 ? Math.max(Math.ceil(n / Math.max(Math.floor(innerW / 72), 1)), 1) : 1;

  const y = (v: number) => padTop + innerH * (1 - Math.min(v / yMax, 1));

  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <svg width={width} height={height} role="img" className="block select-none">
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const v = (yMax / yTicks) * i;
            const gy = y(v);
            return (
              <g key={i}>
                <line x1={padLeft} x2={width - padRight} y1={gy} y2={gy} stroke="#27272a" strokeWidth={1} />
                <text x={padLeft - 6} y={gy + 3} textAnchor="end" fontSize={9} fill="#71717a" fontFamily="ui-monospace, SFMono-Regular, monospace">
                  {formatValue(v)}
                </text>
              </g>
            );
          })}
          {series[0]?.values.map((_, i) => {
            const x = padLeft + i * slot + (slot - barW) / 2;
            let acc = 0;
            const segs = series
              .map((sr) => {
                const v = sr.values[i] ?? 0;
                const y0 = y(acc);
                acc += v;
                return { color: sr.color, top: y(acc), h: Math.max(y0 - y(acc), v > 0 ? 1.5 : 0) };
              })
              .filter((s) => s.h > 0);
            const tip = [tips[i] ?? labels[i] ?? '', ...series.map((sr) => `${sr.name}: ${formatValue(sr.values[i] ?? 0)}`)]
              .filter(Boolean)
              .join('\n');
            return (
              <g key={i}>
                {segs.map((s, si) => (
                  <rect key={si} x={x} y={s.top} width={barW} height={s.h} fill={s.color} rx={1} />
                ))}
                <rect x={padLeft + i * slot} y={padTop} width={slot} height={innerH} fill="transparent">
                  <title>{tip}</title>
                </rect>
              </g>
            );
          })}
          {series[0]?.values.map((_, i) =>
            i % tickEvery === 0 ? (
              <text key={i} x={padLeft + i * slot + slot / 2} y={height - 6} textAnchor="middle" fontSize={9} fill="#71717a">
                {labels[i]}
              </text>
            ) : null,
          )}
          {maxTotal === 0 ? (
            <text x={padLeft + innerW / 2} y={padTop + innerH / 2} textAnchor="middle" fontSize={11} fill="#52525b">
              no data in this window
            </text>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

/** Horizontal bar list (top models, top keys, endpoint split). */
export function HBars({
  items,
  formatValue = compactNum,
  emptyText = 'No data yet.',
}: {
  items: { label: string; value: number; display?: string; sub?: string }[];
  formatValue?: (n: number) => string;
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="py-4 text-center text-[13px] text-zinc-500">{emptyText}</p>;
  const max = Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-mono text-xs text-zinc-300" title={it.label}>
              {it.label}
            </span>
            <span className="shrink-0 font-mono text-xs text-zinc-500">{it.display ?? formatValue(it.value)}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-zinc-800">
            <div
              className="h-1.5 rounded-full bg-emerald-500/80"
              style={{ width: `${max > 0 ? Math.max((it.value / max) * 100, it.value > 0 ? 2 : 0) : 0}%` }}
            />
          </div>
          {it.sub ? <div className="mt-0.5 text-[10px] text-zinc-600">{it.sub}</div> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Period-over-period change badge. `inverse` marks metrics where a DECREASE
 * is good (spend, errors, latency). Renders nothing when both are 0/null.
 */
export function Delta({ current, previous, inverse }: { current: number | null; previous: number | null; inverse?: boolean }) {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0)
    return (
      <span className="ml-1.5 rounded-md bg-emerald-500/10 px-1 py-px text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/30">
        new
      </span>
    );
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return <span className="ml-1.5 text-[10px] text-zinc-500">±0%</span>;
  const up = pct > 0;
  const good = inverse ? !up : up;
  return (
    <span className={cn('ml-1.5 inline-flex items-center gap-px text-[11px] font-medium', good ? 'text-emerald-400' : 'text-red-400')}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(Math.round(pct))}%
    </span>
  );
}
