import type { ReactNode } from "react";
import type { GraphNode, NoStallReason, PathwayGraph, Stall } from "@/lib/pipeline/types";
import {
  buildPathwayView,
  buildTimeline,
  describeSpan,
  formatDate,
  formatDayMonth,
  isSettled,
  noStallHeadline,
  timelineOrder,
  timelineSpanLabel,
  NO_STALL_FALLBACK,
  type PathwayView,
  type TimelineEntry,
  type TimelineMonth,
  type TimelineView,
} from "@/lib/view";

interface Props {
  graph: PathwayGraph | null;
  stall: Stall | null;
  /** Why there is no stall. Only read when `stall` is null. */
  noStallReason: NoStallReason | null;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  onLoadSample: () => void;
}

/** LEFT column — a readable dependency list, not a force-directed graph. */
export default function PathwayPanel({
  graph,
  stall,
  noStallReason,
  loading,
  error,
  hasData,
  onLoadSample,
}: Props) {
  return (
    <section className="flex min-h-0 flex-col">
      <PanelHead kicker="Critical Path" title="What is holding things up" />
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {/* An extraction error is never swallowed: with no pathway yet it is the
            whole state, and once a pathway exists it stays pinned above it so a
            failed read can't read as an empty or complete pathway. */}
        {error && (!hasData || !graph) ? (
          <ErrorState message={error} />
        ) : loading ? (
          <LoadingState />
        ) : !hasData || !graph ? (
          <EmptyState onLoadSample={onLoadSample} />
        ) : graph.nodes.length === 0 ? (
          <NoStepsState />
        ) : (
          <>
            {error && <ErrorBanner message={error} />}
            <Pathway graph={graph} stall={stall} noStallReason={noStallReason} />
          </>
        )}
      </div>
    </section>
  );
}

function Pathway({
  graph,
  stall,
  noStallReason,
}: {
  graph: PathwayGraph;
  stall: Stall | null;
  noStallReason: NoStallReason | null;
}) {
  const view = buildPathwayView(graph, stall);
  // Built once and shared, so the header's step count and the rail below it
  // can never disagree about the order.
  const timeline = buildTimeline(view, stall);
  const ordered = timelineOrder(timeline);
  return (
    <>
      <GoalHeader
        view={view}
        stalled={Boolean(stall)}
        position={ordered.findIndex((entry) => entry.node.id === view.current?.id)}
        total={ordered.length}
      />
      {stall ? <StallCard stall={stall} /> : <NoStallCard reason={noStallReason} view={view} />}
      {view.chain.length > 0 && <Timeline timeline={timeline} />}
      <OtherItems nodes={view.others} />
    </>
  );
}

/** AC2 — what the pathway is working toward and where it currently sits. */
function GoalHeader({
  view,
  stalled,
  position,
  total,
}: {
  view: PathwayView;
  stalled: boolean;
  /** Index of the current step in timeline order; -1 when it isn't on the rail. */
  position: number;
  total: number;
}) {
  return (
    <div className="mb-4 rounded-2xl border border-line bg-card-mut p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-sage">Working toward</div>
      <div className="mt-1 font-display text-[21px] font-semibold leading-tight tracking-[-0.01em] text-ink">
        {view.goal?.label ?? "No end point named in these letters"}
      </div>
      {view.goal?.dept && (
        <div className="mt-1 text-[12.5px] text-ink-2">
          Owned by <span className="font-semibold text-ink">{view.goal.dept}</span>
        </div>
      )}
      <div className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
        {view.current ? (
          <>
            Currently at{" "}
            <span className={`font-semibold ${stalled ? "text-clay" : "text-ink"}`}>
              {view.current.label}
            </span>
            {position >= 0 && total > 0 && (
              <span className="text-ink-3">
                {" "}
                · step {position + 1} of {total}
              </span>
            )}
          </>
        ) : (
          "No dated step in these letters tells us where the pathway currently sits."
        )}
      </div>
    </div>
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

/**
 * AC1 — when there is no stall the panel says WHY, using the reason the API
 * returns. The chain still renders beneath it, so "nothing overdue" is never
 * the whole answer.
 */
function NoStallCard({ reason, view }: { reason: NoStallReason | null; view: PathwayView }) {
  const openSteps = view.chain.filter((node) => !isSettled(node)).length;
  return (
    <div className="mb-4 rounded-2xl border border-sage-soft bg-sage-soft/60 p-5">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-sage-deep">
        Nothing overdue
      </div>
      <div className="mt-1 font-display text-[21px] font-semibold leading-tight text-sage-deep">
        {noStallHeadline(reason)}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
        {reason?.message || NO_STALL_FALLBACK}
      </p>
      {openSteps > 0 && (
        <p className="mt-2 text-[12.5px] text-ink-2">
          {openSteps === 1 ? "1 step is" : `${openSteps} steps are`} still open on the path below — worth
          keeping an eye on, not chasing yet.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GLD-17 — the chain against a real time axis.
//
// Three columns per row: a date gutter, an unbroken rail, and the card. Every
// month between the first and last step gets a row even when nothing happened
// in it, so a five-week wait reads as a five-week gap instead of collapsing
// into the next card.
// ---------------------------------------------------------------------------

function Timeline({ timeline }: { timeline: TimelineView }) {
  const span = timelineSpanLabel(timeline);
  return (
    <>
      <div className="mb-1 mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
        <p className="text-[12.5px] text-ink-2">Your pathway in order, dated from your letters.</p>
        {span && <span className="flex-none text-[11.5px] font-semibold text-ink-3">{span}</span>}
      </div>
      <div className="flex flex-col">
        {timeline.months.map((month) => (
          <MonthBlock key={month.key} month={month} />
        ))}
        {timeline.undated.length > 0 && <UndatedBlock entries={timeline.undated} />}
        {timeline.destination && <DestinationRow entry={timeline.destination} />}
      </div>
    </>
  );
}

function MonthBlock({ month }: { month: TimelineMonth }) {
  return (
    <div>
      <RailRow gutter={null}>
        <div className="flex items-center gap-2.5 pb-1 pt-3">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink-3">
            {month.label}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      </RailRow>
      {month.entries.length === 0 ? (
        <RailRow gutter={null}>
          <div className="py-1.5 text-[11.5px] italic text-ink-3">nothing recorded</div>
        </RailRow>
      ) : (
        month.entries.map((entry) => <TimelineRow key={entry.node.id} entry={entry} />)
      )}
    </div>
  );
}

/** Steps the letters never dated — kept visible rather than dropped (AC6). */
function UndatedBlock({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div>
      <RailRow gutter={null}>
        <div className="flex items-center gap-2.5 pb-1 pt-3">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink-3">
            No date given
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      </RailRow>
      {entries.map((entry) => (
        <TimelineRow key={entry.node.id} entry={entry} />
      ))}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const tone = entry.overdue ? "overdue" : entry.settled ? "done" : "pending";
  return (
    <RailRow
      dot={tone}
      gutter={
        <span
          className={`text-[11.5px] font-semibold tabular-nums ${
            entry.overdue ? "text-clay" : entry.settled ? "text-ink-2" : "text-ink-3"
          }`}
        >
          {entry.date ? formatDayMonth(entry.date) : "—"}
        </span>
      }
    >
      <div className="pb-2.5 pt-1.5">
        <TimelineCard entry={entry} />
      </div>
    </RailRow>
  );
}

/**
 * AC4 — done, pending and overdue are told apart by the rail dot and the card's
 * weight alone. Finished steps recede; the overdue one is the only lifted card.
 */
function TimelineCard({ entry }: { entry: TimelineEntry }) {
  const { node, settled, overdue, isGoal, turnaroundDays } = entry;
  return (
    <div
      className={`rounded-2xl border p-3.5 ${
        overdue
          ? "border-clay bg-card shadow-lift"
          : settled
            ? "border-line bg-card-mut"
            : "border-line bg-card shadow-soft"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[14.5px] font-semibold ${settled ? "text-ink-2" : "text-ink"}`}>
          {node.label}
        </span>
        {overdue && (
          <span className="rounded-full bg-clay px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-white">
            Overdue
          </span>
        )}
        {isGoal && !overdue && (
          <span className="rounded-full bg-sage-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-sage-deep">
            Goal
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">
        {node.dept || "Department not identified"}
        {node.status !== "unknown" ? ` · ${node.status}` : ""}
      </div>
      {overdue && (
        <div className="mt-2 rounded-xl bg-clay-soft px-3 py-2 text-[12px] leading-relaxed text-clay-ink">
          {overdue.phrase}
          {overdue.detail ? ` · ${overdue.detail}` : ""}
        </div>
      )}
      {/* AC7 — a slow turnaround is worth seeing, in gold rather than clay, so
          it never competes with the actual bottleneck. */}
      {turnaroundDays !== null && (
        <div className="mt-1.5 text-[11.5px] text-gold">
          Took {describeSpan(turnaroundDays)} from request to result
        </div>
      )}
    </div>
  );
}

/** Where the pathway is heading — the end of the rail, not a step with holes in it. */
function DestinationRow({ entry }: { entry: TimelineEntry }) {
  return (
    <div className="flex gap-3">
      <div className="w-[54px] flex-none pt-5 text-right text-[10.5px] font-bold uppercase tracking-[0.05em] text-sage">
        Goal
      </div>
      <div className="relative w-3 flex-none">
        <span className="absolute left-1/2 top-0 h-[26px] w-px -translate-x-1/2 bg-line-2" />
        <span className="absolute left-1/2 top-[20px] h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-sage bg-card ring-4 ring-canvas" />
      </div>
      <div className="min-w-0 flex-1 pb-2 pt-3">
        <div className="rounded-2xl border border-sage-soft bg-sage-soft/50 p-3.5">
          <div className="font-display text-[17px] font-semibold leading-tight text-ink">
            {entry.node.label}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-2">
            {entry.node.dept || "Department not identified"} · not started yet
          </div>
        </div>
      </div>
    </div>
  );
}

/** The three-column skeleton every timeline row shares, so the rail never jogs. */
function RailRow({
  gutter,
  dot,
  children,
}: {
  gutter: ReactNode;
  dot?: "done" | "pending" | "overdue";
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-[54px] flex-none pt-3.5 text-right">{gutter}</div>
      <div className="relative w-3 flex-none">
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-line-2" />
        {dot && (
          <span
            className={`absolute left-1/2 top-[18px] h-3 w-3 -translate-x-1/2 rounded-full ring-4 ring-canvas ${
              dot === "overdue"
                ? "bg-clay"
                : dot === "done"
                  ? "bg-sage"
                  : "border-2 border-line-2 bg-card"
            }`}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Off-chain items only — compact, and never carrying stall or goal treatment. */
function NodeCard({ node }: { node: GraphNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-3 shadow-soft">
      <div className="text-[13px] font-semibold text-ink">{node.label}</div>
      <div className="mt-1 text-[11.5px] text-ink-3">
        {node.dept || "Department not identified"} · {node.kind}
        {node.ordered_date ? ` · ordered ${formatDate(node.ordered_date)}` : ""}
        {node.report_date ? ` · reported ${formatDate(node.report_date)}` : ""}
      </div>
    </div>
  );
}

/** AC4 — nodes off the path to the goal are collapsed, not listed at equal weight. */
function OtherItems({ nodes }: { nodes: GraphNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <details className="mt-4 overflow-hidden rounded-2xl border border-line bg-card shadow-soft">
      <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-ink hover:bg-black/[0.02]">
        Other items mentioned{" "}
        <span className="font-normal text-ink-3">({nodes.length}) — not on the path to your goal</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-4 pb-4 pt-3">
        {nodes.map((node) => (
          <NodeCard key={node.id} node={node} />
        ))}
      </div>
    </details>
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

/** Letters read fine, but nothing datable came out of them — distinct from both
    the pre-upload empty state and a healthy pathway with no stall. */
function NoStepsState() {
  return <div className="mt-6 rounded-2xl border border-dashed border-line-2 bg-card-mut p-7 text-center"><div className="font-display text-[18px] font-semibold text-ink">No pathway steps in these letters</div><p className="mx-auto mt-2 max-w-[36ch] text-[13px] leading-relaxed text-ink-2">We read your letters but couldn&apos;t find any referrals, tests or appointments to place on a timeline. Adding the letter that names your referral or next appointment usually fixes this.</p></div>;
}

function LoadingState() {
  return <div className="mt-2 flex flex-col gap-3" aria-busy="true"><div className="h-[150px] animate-pulse rounded-2xl bg-black/[0.04]" />{[0, 1, 2].map((i) => <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-black/[0.03]" />)}<p className="px-1 pt-1 text-[12.5px] text-ink-3">Joining dates across your letters…</p></div>;
}

/** The same failure, shown above a pathway that was already built. */
function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-2xl border border-clay-soft bg-[#fff7f4] px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-clay">Last letter not read</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-clay-ink">
        {message} The pathway below is from the letters we did read.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return <div className="mt-6 rounded-2xl border border-clay-soft bg-[#fff7f4] p-6 text-center"><div className="font-display text-[16px] font-semibold text-clay">We couldn&apos;t build the pathway</div><p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] leading-relaxed text-clay-ink">{message}</p></div>;
}
