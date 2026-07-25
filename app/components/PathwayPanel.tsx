import type { GraphNode, PathwayGraph, Stall } from "@/lib/pipeline/types";
import { formatDate } from "@/lib/view";

interface Props {
  graph: PathwayGraph | null;
  stall: Stall | null;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  onLoadSample: () => void;
}

/** LEFT column — a readable dependency list, not a force-directed graph. */
export default function PathwayPanel({ graph, stall, loading, error, hasData, onLoadSample }: Props) {
  return (
    <section className="flex min-h-0 flex-col">
      <PanelHead kicker="Critical Path" title="What is holding things up" />
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {error ? <ErrorState message={error} /> : loading ? <LoadingState /> : !hasData || !graph ? (
          <EmptyState onLoadSample={onLoadSample} />
        ) : stall ? (
          <Populated graph={graph} stall={stall} />
        ) : (
          <NoStall graph={graph} />
        )}
      </div>
    </section>
  );
}

function Populated({ graph, stall }: { graph: PathwayGraph; stall: Stall }) {
  const chainIds = new Set(stall.chain.map((node) => node.id));
  const context = graph.nodes.filter((node) => !chainIds.has(node.id));
  return (
    <>
      <StallCard stall={stall} />
      <p className="mb-3 mt-1 px-1 text-[12.5px] text-ink-2">
        Each step below is joined from the dates and dependencies written in your letters.
      </p>
      <div className="flex flex-col gap-0">
        {stall.chain.map((node, index) => (
          <div key={node.id}>
            <NodeCard node={node} stalled={node.id === stall.stalledNode.id} />
            {index < stall.chain.length - 1 && <Connector label="blocks" />}
          </div>
        ))}
      </div>
      {context.length > 0 && (
        <details className="mt-4 overflow-hidden rounded-2xl border border-line bg-card shadow-soft">
          <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-ink hover:bg-black/[0.02]">
            Earlier evidence in the pathway <span className="font-normal text-ink-3">({context.length} nodes)</span>
          </summary>
          <div className="flex flex-col gap-2 border-t border-line px-4 pb-4 pt-3">
            {context.map((node) => <NodeCard key={node.id} node={node} compact />)}
          </div>
        </details>
      )}
    </>
  );
}

function StallCard({ stall }: { stall: Stall }) {
  return (
    <div className="mb-4 rounded-2xl border border-clay-soft bg-gradient-to-b from-[#fff7f4] to-card p-5 shadow-lift">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-clay">Stall identified</div>
      <div className="mt-1 font-display text-[25px] font-semibold tracking-[-0.02em] text-ink">
        {stall.stalledNode.label}
      </div>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
        Owned by <span className="font-semibold text-ink">{stall.owningDept || "an unidentified department"}</span> · holding up the next step.
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Metric label="Ordered" value={formatDate(stall.sinceDate)} />
        <Metric label="Days stalled" value={`${stall.daysStalled}`} accent />
      </div>
      <div className="mt-2.5 rounded-xl bg-clay-soft px-3.5 py-3 text-[12px] leading-relaxed text-clay-ink">
        Expected window: {stall.expectedDays === null ? "not defined" : `${stall.expectedDays} days`}. This is an administrative timing signal, not a clinical assessment.
      </div>
    </div>
  );
}

function NodeCard({ node, stalled = false, compact = false }: { node: GraphNode; stalled?: boolean; compact?: boolean }) {
  return (
    <div className={`rounded-2xl border ${compact ? "p-3" : "p-4"} ${stalled ? "border-clay bg-card shadow-lift" : "border-line bg-card shadow-soft"}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-[12px] font-bold ${stalled ? "bg-clay text-white" : node.status === "reported" || node.status === "done" || node.status === "actioned" ? "bg-sage text-white" : "bg-line-2 text-ink-2"}`}>
          {stalled ? "!" : node.status === "reported" || node.status === "done" || node.status === "actioned" ? "✓" : "·"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${compact ? "text-[13px]" : "text-[15px]"} font-semibold text-ink`}>{node.label}</span>
            {stalled && <span className="rounded-full bg-clay px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-white">Overdue</span>}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            {node.dept || "Department not identified"} · {node.kind}
            {node.ordered_date ? ` · ordered ${formatDate(node.ordered_date)}` : ""}
            {node.report_date ? ` · reported ${formatDate(node.report_date)}` : ""}
          </div>
          {!compact && node.status !== "unknown" && (
            <div className="mt-2 text-[12px] text-ink-2">Status recorded as <span className="font-semibold text-ink">{node.status}</span>.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return <div className="flex h-8 items-center gap-3 pl-3 text-[10px] font-bold uppercase tracking-[0.05em] text-ink-3"><span className="h-full border-l-2 border-dashed border-line-2" /><span>{label} ↓</span></div>;
}

function NoStall({ graph }: { graph: PathwayGraph }) {
  return (
    <div className="rounded-2xl border border-sage-soft bg-sage-soft/60 p-5">
      <div className="font-display text-[20px] font-semibold text-sage-deep">No overdue bottleneck found</div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">The graph contains {graph.nodes.length} nodes, but no open node is beyond its deterministic expected window on the selected date.</p>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="rounded-xl bg-card px-3 py-2.5"><div className="text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-3">{label}</div><div className={`mt-0.5 text-[16px] font-semibold ${accent ? "text-clay" : "text-ink"}`}>{value}</div></div>;
}

function PanelHead({ kicker, title }: { kicker: string; title: string }) {
  return <div className="mb-3.5 px-1"><div className="text-[11px] font-bold uppercase tracking-[0.04em] text-sage">{kicker}</div><div className="mt-0.5 font-display text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</div></div>;
}

function EmptyState({ onLoadSample }: { onLoadSample: () => void }) {
  return <div className="mt-6 rounded-2xl border border-dashed border-line-2 bg-card-mut p-7 text-center"><div className="font-display text-[18px] font-semibold text-ink">Build your dependency path</div><p className="mx-auto mt-2 max-w-[34ch] text-[13px] leading-relaxed text-ink-2">Add your NHS letters and we&apos;ll show which department owns the open step. Not sure? Start with the worked example.</p><button type="button" onClick={onLoadSample} className="mt-4 rounded-full bg-sage px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(91,138,114,0.28)] transition-colors hover:bg-sage-deep">Load sample pathway</button></div>;
}

function LoadingState() {
  return <div className="mt-2 flex flex-col gap-3" aria-busy="true"><div className="h-[150px] animate-pulse rounded-2xl bg-black/[0.04]" />{[0, 1, 2].map((i) => <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-black/[0.03]" />)}<p className="px-1 pt-1 text-[12.5px] text-ink-3">Joining dates across your letters…</p></div>;
}

function ErrorState({ message }: { message: string }) {
  return <div className="mt-6 rounded-2xl border border-clay-soft bg-[#fff7f4] p-6 text-center"><div className="font-display text-[16px] font-semibold text-clay">We couldn&apos;t build the pathway</div><p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] leading-relaxed text-clay-ink">{message}</p></div>;
}
