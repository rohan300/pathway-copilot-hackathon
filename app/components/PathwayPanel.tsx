import type { StateMachineResult } from "@/lib/pipeline/types";
import type { DocRecord, Milestone } from "@/lib/view";
import { formatDate } from "@/lib/view";

interface Props {
  milestones: Milestone[];
  state: StateMachineResult | null;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  onLoadSample: () => void;
}

/**
 * LEFT column — "Where things stand". The emphasised surface: a plain-English
 * reassurance card leads, then the five pathway milestones, each an expandable
 * <details> that reveals the full extracted detail behind it. Four states:
 * loading, empty, error, populated.
 */
export default function PathwayPanel({
  milestones,
  state,
  loading,
  error,
  hasData,
  onLoadSample,
}: Props) {
  return (
    <section className="flex min-h-0 flex-col">
      <PanelHead kicker="Your pathway" title="Where things stand" />

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {error ? (
          <ErrorState message={error} />
        ) : loading ? (
          <LoadingState />
        ) : !hasData ? (
          <EmptyState onLoadSample={onLoadSample} />
        ) : (
          <>
            {state && <StatusCard state={state} />}
            <p className="mb-3 mt-1 px-1 text-[12.5px] text-ink-2">
              Tap any step to see the detail behind it.
            </p>
            <div className="flex flex-col gap-3">
              {milestones.map((m) => (
                <MilestoneCard key={m.stage} m={m} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PanelHead({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-3.5 px-1">
      <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-sage">
        {kicker}
      </div>
      <div className="mt-0.5 font-display text-[22px] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </div>
    </div>
  );
}

function StatusCard({ state }: { state: StateMachineResult }) {
  const overdue = state.overdue;
  const stageLabel = LABELS[state.current_stage] ?? state.current_stage;
  return (
    <div
      className={`mb-4 rounded-2xl border p-5 shadow-card ${
        overdue
          ? "border-clay-soft bg-gradient-to-b from-[#fff7f4] to-card"
          : "border-line bg-card"
      }`}
    >
      <div
        className={`font-display text-[27px] font-semibold tracking-[-0.02em] ${
          overdue ? "text-clay" : "text-sage-deep"
        }`}
      >
        Day {state.total_days_elapsed} · <span className="text-ink">{stageLabel}</span>
      </div>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
        You&apos;ve been at this step for {state.days_in_stage} day
        {state.days_in_stage === 1 ? "" : "s"}.{" "}
        {overdue
          ? "That's longer than it usually takes."
          : "This is within the usual wait."}
      </div>
      {state.blocker && (
        <div className="mt-3.5 rounded-xl bg-clay-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-clay-ink">
          <span className="font-semibold text-clay">What&apos;s holding it up:</span>{" "}
          {state.blocker}
        </div>
      )}
      {state.benchmark_comparison && (
        <div className="mt-2.5 px-0.5 text-[12px] text-ink-3">
          {state.benchmark_comparison}
        </div>
      )}
    </div>
  );
}

function MilestoneCard({ m }: { m: Milestone }) {
  const lead = m.docs[0];
  const open = m.status !== "upcoming"; // complete + current expanded by default
  return (
    <details
      open={open}
      className={`group overflow-hidden rounded-2xl border ${
        m.status === "current"
          ? "border-clay bg-card shadow-lift"
          : m.status === "upcoming"
            ? "border-dashed border-line-2 bg-card-mut"
            : "border-line bg-card shadow-soft"
      }`}
    >
      <summary className="cursor-pointer px-4 py-3.5 transition-colors hover:bg-black/[0.02]">
        <div className="flex items-center gap-2.5">
          <Bubble status={m.status} />
          <span className="text-[15px] font-semibold text-ink">{m.label}</span>
          <StatusPill status={m.status} overdue={m.overdue} />
          <span className="ml-auto text-ink-3 transition-transform group-open:rotate-180">
            ⌄
          </span>
        </div>
        {lead && (
          <>
            <div className="mt-2.5 text-[12px] text-ink-3">
              {formatDate(lead.date)}
              {lead.clinician ? ` · ${lead.clinician}` : ""}
              {m.status === "current" && ` · ${m.docs.length ? "" : ""}${daysLine(m)}`}
            </div>
            <div className="mt-0.5 text-[13.5px] leading-snug text-ink">
              {leadLine(lead)}
            </div>
          </>
        )}
      </summary>

      <div
        className={`border-t px-4 pb-4 pt-0.5 ${
          m.status === "current" ? "border-clay-soft" : "border-line"
        }`}
      >
        {m.status === "current" && m.overdue && (
          <div className="mt-3 rounded-xl bg-clay-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-clay-ink">
            <span className="font-semibold text-clay">This is where things are stuck.</span>{" "}
            The usual wait here is about {m.expectedDays} days
            {typeof m.expectedDays === "number" ? "" : ""}. {daysLine(m)}.
          </div>
        )}

        {m.docs.map((doc) => (
          <DocDetail key={doc.id} doc={doc} />
        ))}

        {m.docs.length === 0 && (
          <div className="mt-3">
            <p className="text-[13px] leading-relaxed text-ink-2">{m.about}</p>
            {m.expectedDays !== null && (
              <div className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-ink-3">
                  Usual wait
                </span>
                <span className="text-[13px] text-ink">
                  about {m.expectedDays} days
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function DocDetail({ doc }: { doc: DocRecord }) {
  const low = doc.confidence < 0.6;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
        {doc.clinician && (
          <>
            <DK>Clinician</DK>
            <DV>{doc.clinician}</DV>
          </>
        )}
        <DK>Letter type</DK>
        <DV>{DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}</DV>
        {doc.drugs_mentioned.length > 0 && (
          <>
            <DK>Medication</DK>
            <DV>{doc.drugs_mentioned.join(", ")}</DV>
          </>
        )}
      </div>

      {doc.actions_stated.length > 0 && (
        <Chips label="What the letter said to do" items={doc.actions_stated} />
      )}
      {doc.tests_ordered.length > 0 && (
        <Chips label="Tests ordered" items={doc.tests_ordered} />
      )}

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-3">
        from {doc.source} ·{" "}
        <span className={low ? "font-semibold text-gold" : undefined}>
          confidence {doc.confidence.toFixed(2)}
          {low ? " (low — worth double-checking)" : " (high)"}
        </span>
      </div>
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.03em] text-ink-3">
        {label}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <span
            key={i}
            className="rounded-full bg-sage-soft px-2.5 py-1 text-[11.5px] font-medium text-sage-deep"
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

const DK = ({ children }: { children: React.ReactNode }) => (
  <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.03em] text-ink-3">
    {children}
  </span>
);
const DV = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[13px] leading-snug text-ink">{children}</span>
);

function Bubble({ status }: { status: Milestone["status"] }) {
  const base = "grid h-6.5 w-6.5 flex-none place-items-center rounded-full text-[13px]";
  if (status === "complete")
    return <span className={`${base} bg-sage text-white`}>✓</span>;
  if (status === "current")
    return <span className={`${base} bg-clay text-white`}>!</span>;
  return <span className={`${base} bg-line-2 text-ink-3`}>·</span>;
}

function StatusPill({
  status,
  overdue,
}: {
  status: Milestone["status"];
  overdue: boolean;
}) {
  const base =
    "rounded-full px-2.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em]";
  if (overdue) return <span className={`${base} bg-clay text-white`}>Overdue</span>;
  if (status === "complete")
    return <span className={`${base} bg-sage-soft text-sage-deep`}>Done</span>;
  if (status === "current")
    return <span className={`${base} bg-sage-soft text-sage-deep`}>In progress</span>;
  return <span className={`${base} bg-line text-ink-3`}>Not yet</span>;
}

function daysLine(m: Milestone): string {
  return `${m.expectedDays ? `waiting past the usual ${m.expectedDays}` : "waiting"} days`;
}

function leadLine(doc: DocRecord): string {
  if (doc.actions_stated[0]) return doc.actions_stated[0];
  if (doc.drugs_mentioned.length)
    return `Mentions ${doc.drugs_mentioned.join(", ")}.`;
  return DOC_TYPE_LABELS[doc.doc_type] ?? "Letter on file.";
}

/* ---- non-populated states ---- */

function EmptyState({ onLoadSample }: { onLoadSample: () => void }) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-2 bg-card-mut p-7 text-center">
      <div className="font-display text-[18px] font-semibold text-ink">
        Let&apos;s reconstruct your pathway
      </div>
      <p className="mx-auto mt-2 max-w-[34ch] text-[13px] leading-relaxed text-ink-2">
        Add your NHS letters (a PDF or a photo) and, if you have it, your Fitbit
        export. Nothing is saved. Not sure? Start with a worked example.
      </p>
      <button
        type="button"
        onClick={onLoadSample}
        className="mt-4 rounded-full bg-sage px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(91,138,114,0.28)] transition-colors hover:bg-sage-deep"
      >
        Load sample pathway
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-2 flex flex-col gap-3" aria-busy="true">
      <div className="h-[104px] animate-pulse rounded-2xl bg-black/[0.04]" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-black/[0.03]" />
      ))}
      <p className="px-1 pt-1 text-[12.5px] text-ink-3">Reading your letters…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-clay-soft bg-[#fff7f4] p-6 text-center">
      <div className="font-display text-[16px] font-semibold text-clay">
        We couldn&apos;t read the pathway
      </div>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] leading-relaxed text-clay-ink">
        {message}
      </p>
    </div>
  );
}

const LABELS: Record<string, string> = {
  referral: "Referral",
  screening: "Screening",
  funding: "Funding",
  homecare: "Homecare setup",
  first_dose: "First dose",
};

const DOC_TYPE_LABELS: Record<string, string> = {
  referral: "Referral letter",
  clinic_letter: "Clinic letter",
  test_result: "Test result",
  funding: "Funding letter",
  homecare: "Homecare letter",
  other: "Letter",
};
