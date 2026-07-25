import type { VitalMetric, VitalsResult } from "@/lib/pipeline/types";
import { type CsvPoint, formatDate, METRIC_META, METRIC_ORDER } from "@/lib/view";

interface Props {
  vitals: VitalsResult | null;
  series: CsvPoint[];
  loading: boolean;
  error: string | null;
  hasPathway: boolean;
}

/**
 * CENTRE column — "How you've been". Deltas against a 7-day baseline, shown as
 * measured change only (never interpreted clinically). The line is the real
 * daily CSV series; the baseline band and inflection marker come from the
 * deterministic vitals joiner. Metric cards summarise each delta.
 */
export default function VitalsPanel({
  vitals,
  series,
  loading,
  error,
  hasPathway,
}: Props) {
  return (
    <section className="flex min-h-0 flex-col">
      <PanelHead kicker="From your Fitbit" title="How you've been" />
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {error ? (
          <ErrorState message={error} />
        ) : loading ? (
          <LoadingState />
        ) : !vitals ? (
          <EmptyState hasPathway={hasPathway} />
        ) : (
          <Populated vitals={vitals} series={series} />
        )}
      </div>
    </section>
  );
}

function Populated({ vitals, series }: { vitals: VitalsResult; series: CsvPoint[] }) {
  const rhr = vitals.deltas.resting_hr;
  const rise = rhr.absolute >= 0;
  return (
    <>
      <p className="mb-3.5 px-1 text-[13px] leading-relaxed text-ink-2">
        These are changes from your own first-week baseline (shaded). We show the
        numbers only — we don&apos;t read anything medical into them.
      </p>

      <div className="mb-4 rounded-2xl border border-line bg-card p-4 pb-3 shadow-card">
        <div className="flex items-baseline justify-between px-1 pb-1.5">
          <span className="text-[14px] font-semibold text-ink">Resting heart rate</span>
          <span className={`text-[14px] font-bold ${rise ? "text-clay" : "text-sage-deep"}`}>
            {rhr.absolute >= 0 ? "+" : ""}
            {rhr.absolute} bpm
          </span>
        </div>
        <Chart series={series} metric="resting_hr" baseline={rhr.baseline} vitals={vitals} />
        <div className="flex flex-wrap gap-3.5 px-1 pt-3 text-[11.5px] text-ink-3">
          <Legend color="#2c332e">Your daily resting HR</Legend>
          <Legend color="#5b8a72">Your baseline ({METRIC_META.resting_hr.format(rhr.baseline)} bpm)</Legend>
          {vitals.inflection && (
            <Legend color="#c56a52">
              Change began · {formatDate(vitals.inflection.date)}
            </Legend>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {METRIC_ORDER.map((m) => (
          <MetricCard key={m} metric={m} vitals={vitals} />
        ))}
      </div>

      <p className="mt-3.5 px-1 text-[11.5px] leading-relaxed text-ink-3">
        Baseline is your first {vitals.baseline_window.days} days of data. Deltas
        are the change across the wait window ({formatDate(vitals.wait_window.start)} –{" "}
        {formatDate(vitals.wait_window.end)}) — measured change only, never a
        clinical finding.
      </p>
    </>
  );
}

/** Inline SVG line chart from the real CSV series. */
function Chart({
  series,
  metric,
  baseline,
  vitals,
}: {
  series: CsvPoint[];
  metric: VitalMetric;
  baseline: number;
  vitals: VitalsResult;
}) {
  const W = 560;
  const H = 150;
  const values = series.map((p) => p[metric]);
  if (values.length < 2) {
    return (
      <div className="grid h-[150px] place-items-center text-[12px] text-ink-3">
        Not enough data to chart.
      </div>
    );
  }
  const lo = Math.min(...values, baseline);
  const hi = Math.max(...values, baseline);
  const pad = (hi - lo) * 0.15 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;

  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const baseY = y(baseline);
  const bandH = Math.max(6, ((max - min) === 0 ? 0 : (H / (max - min)) * 2)); // ~±1 unit
  const inflIdx = vitals.inflection
    ? series.findIndex((p) => p.date === vitals.inflection!.date)
    : -1;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label="Daily resting heart rate against baseline"
    >
      {/* baseline band + line */}
      <rect x="0" y={baseY - bandH / 2} width={W} height={bandH} fill="#5b8a72" opacity="0.1" />
      <line
        x1="0"
        y1={baseY}
        x2={W}
        y2={baseY}
        stroke="#5b8a72"
        strokeWidth="1.5"
        strokeDasharray="4 4"
        opacity="0.5"
        vectorEffect="non-scaling-stroke"
      />
      {/* inflection marker */}
      {inflIdx >= 0 && (
        <line
          x1={x(inflIdx)}
          y1="0"
          x2={x(inflIdx)}
          y2={H}
          stroke="#c56a52"
          strokeWidth="1.5"
          strokeDasharray="3 4"
          opacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* series line */}
      <polyline
        points={line}
        fill="none"
        stroke="#2c332e"
        strokeWidth="2.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MetricCard({ metric, vitals }: { metric: VitalMetric; vitals: VitalsResult }) {
  const meta = METRIC_META[metric];
  const d = vitals.deltas[metric];
  const rise = d.absolute > 0;
  const adverse = meta.riseIsAdverse ? d.absolute > 0 : d.absolute < 0;
  const arrow = rise ? "▲" : d.absolute < 0 ? "▼" : "•";
  const deltaText =
    metric === "sleep_minutes"
      ? `${Math.abs(d.absolute)} min ${rise ? "more" : "less"}`
      : `${rise ? "+" : ""}${d.absolute}${meta.unit ? ` ${meta.unit}` : ""}`;
  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-soft">
      <div className="text-[12px] font-semibold text-ink-3">{meta.label}</div>
      <div className="mt-1.5 font-display text-[26px] font-semibold text-ink">
        {meta.format(d.window_mean)}
        {meta.unit && <span className="ml-1 text-[13px] font-normal text-ink-3">{meta.unit}</span>}
      </div>
      <div className={`mt-0.5 text-[12px] font-semibold ${adverse ? "text-clay" : "text-sage-deep"}`}>
        {arrow} {deltaText} <span className="font-normal text-ink-3">from {meta.format(d.baseline)}</span>
      </div>
    </div>
  );
}

function PanelHead({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-3.5 px-1">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-sage">{kicker}</div>
      <div className="mt-0.5 font-display text-[22px] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </div>
    </div>
  );
}

function Legend({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-[3px] w-3.5 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  );
}

function EmptyState({ hasPathway }: { hasPathway: boolean }) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-2 bg-card-mut p-7 text-center">
      <div className="font-display text-[17px] font-semibold text-ink">
        Add your Fitbit export
      </div>
      <p className="mx-auto mt-2 max-w-[32ch] text-[13px] leading-relaxed text-ink-2">
        {hasPathway
          ? "Use the “Fitbit CSV” button above to see how your resting heart rate, sleep and activity changed across the wait."
          : "Once you’ve loaded a pathway, add your Fitbit CSV to see how you’ve been across the wait."}
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-2 flex flex-col gap-3" aria-busy="true">
      <div className="h-[200px] animate-pulse rounded-2xl bg-black/[0.04]" />
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-2xl bg-black/[0.03]" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-clay-soft bg-[#fff7f4] p-6 text-center">
      <div className="font-display text-[16px] font-semibold text-clay">
        We couldn&apos;t read your Fitbit data
      </div>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] leading-relaxed text-clay-ink">
        {message}
      </p>
    </div>
  );
}
