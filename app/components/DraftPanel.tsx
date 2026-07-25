"use client";

import { useState } from "react";
import type { DraftResult, DraftTarget } from "@/lib/pipeline/types";

interface Props {
  draft: DraftResult | null;
  target: DraftTarget;
  onSelectTarget: (t: DraftTarget) => void;
  loading: boolean;
  error: string | null;
  hasState: boolean;
}

const TABS: { value: DraftTarget; label: string; to: string }[] = [
  { value: "advice_line", label: "Advice line", to: "the IBD advice line" },
  { value: "pals", label: "PALS", to: "PALS (Patient Advice & Liaison Service)" },
  { value: "clinician_summary", label: "Clinician summary", to: "your IBD clinician" },
];

/**
 * RIGHT column — "A message you can send". Target selector (advice line / PALS /
 * clinician summary), the drafted prose, plus the questions list for the
 * clinician summary. Administrative escalation only — no clinical advice.
 */
export default function DraftPanel({
  draft,
  target,
  onSelectTarget,
  loading,
  error,
  hasState,
}: Props) {
  const to = TABS.find((t) => t.value === target)?.to ?? "";

  return (
    <section className="flex min-h-0 flex-col">
      <PanelHead kicker="Ready to send" title="A message you can send" />

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {!hasState && !loading && !error ? (
          <EmptyState />
        ) : (
          <>
            <div className="mb-2.5 px-1 text-[12.5px] text-ink-2">Who is this for?</div>
            <div className="mb-4 flex flex-wrap gap-2">
              {TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => onSelectTarget(t.value)}
                  className={`rounded-full border px-3.5 py-2 text-[12.5px] font-semibold transition-colors ${
                    t.value === target
                      ? "border-sage bg-sage text-white"
                      : "border-line-2 bg-card text-ink-2 hover:border-sage hover:text-sage-deep"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {error ? (
              <ErrorState message={error} />
            ) : loading || !draft ? (
              <LoadingState />
            ) : draft.target === "clinician_summary" ? (
              <ClinicianOnePager draft={draft} />
            ) : (
              <Letter draft={draft} to={to} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Letter({ draft, to }: { draft: DraftResult; to: string }) {
  const paragraphs = draft.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-card">
      <div className="mb-3.5 text-[12px] text-ink-3">
        To — <span className="font-semibold text-ink">{to}</span>
      </div>

      <div className="text-[14px] leading-[1.78] text-ink">
        {paragraphs.map((p, i) => (
          <p key={i} className="mb-3 whitespace-pre-line last:mb-0">
            {p}
          </p>
        ))}
      </div>

      <div className="mt-4 rounded-xl bg-sage-soft px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
        This is a note about your appointments and paperwork — not medical advice.
        Please read it over and change anything before you send it.
      </div>

      <div className="mt-4 flex items-center gap-3">
        <CopyButton text={draft.text} />
        <span className="text-[12px] text-ink-3">It&apos;s yours — edit freely</span>
        {draft.mocked && (
          <span className="ml-auto text-[11px] text-ink-3">sample draft</span>
        )}
      </div>
    </div>
  );
}

/** One line of the clinician one-pager: a labelled fact or a prose line. */
type SummaryLine =
  | { kind: "fact"; label: string; value: string }
  | { kind: "prose"; text: string };

/** Drop the drafter's own heading/disclaimer — this card supplies its own. */
function isBoilerplate(line: string): boolean {
  return /^pathway summary\b|no clinical assessment|administrative and reconstructed/i.test(line);
}

/**
 * Parse the drafter's clinician_summary text into structured lines. The mock
 * (and a well-behaved model) emit `• Label: value` rows; anything else falls
 * back to prose so real free-form output still renders cleanly.
 */
function parseSummary(text: string): SummaryLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isBoilerplate(l))
    .map((line): SummaryLine => {
      const fact = line.match(/^[•\-]\s*(.+?):\s*(.+)$/);
      if (fact) return { kind: "fact", label: fact[1].trim(), value: fact[2].trim() };
      return { kind: "prose", text: line };
    });
}

/**
 * The clinician_summary target rendered as a document-grade one-pager: a
 * letterhead, a structured facts sheet, any narrative prose, and the questions
 * promoted into a clear "ask at your appointment" section. Administrative and
 * reconstructed from the patient's own letters — no clinical assessment.
 */
function ClinicianOnePager({ draft }: { draft: DraftResult }) {
  const lines = parseSummary(draft.text);
  const facts = lines.filter((l): l is Extract<SummaryLine, { kind: "fact" }> => l.kind === "fact");
  const prose = lines.filter((l): l is Extract<SummaryLine, { kind: "prose" }> => l.kind === "prose");
  const questions = draft.questions ?? [];

  const copyText = [
    draft.text,
    questions.length ? `\nQuestions to ask at your appointment:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="rounded-2xl border border-line bg-card shadow-card">
      {/* Letterhead */}
      <div className="border-b border-line px-6 pb-4 pt-6">
        <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-sage">
          For your clinician
        </div>
        <div className="mt-1 font-display text-[21px] font-semibold tracking-[-0.01em] text-ink">
          Pathway summary
        </div>
        <div className="mt-1.5 text-[12px] text-ink-3">
          Prepared from your own letters — one page to bring to your appointment.
        </div>
      </div>

      {/* Structured facts sheet */}
      {facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-px bg-line-2 sm:grid-cols-2">
          {facts.map((f, i) => (
            <div key={i} className="bg-card px-6 py-3.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.03em] text-ink-3">
                {f.label}
              </dt>
              <dd className="mt-0.5 text-[13.5px] leading-snug text-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="px-6 py-5">
        {prose.length > 0 && (
          <div className="text-[13px] leading-[1.7] text-ink-2">
            {prose.map((p, i) => (
              <p key={i} className="mb-2 last:mb-0">
                {p.text}
              </p>
            ))}
          </div>
        )}

        {questions.length > 0 && (
          <div className="mt-4 rounded-xl border border-sage-soft bg-sage-soft/60 px-4 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.03em] text-sage-deep">
              Questions to ask at your appointment
            </div>
            <ol className="mt-2.5 flex flex-col gap-2">
              {questions.map((q, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-ink">
                  <span className="mt-px font-semibold text-sage-deep">{i + 1}.</span>
                  <span>{q}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-4 rounded-xl bg-card-mut px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
          This one-pager is administrative — a summary of your appointments and
          paperwork, not a clinical assessment. Edit anything before you share it.
        </div>

        <div className="mt-4 flex items-center gap-3">
          <CopyButton text={copyText} label="Copy one-pager" />
          {draft.mocked && (
            <span className="ml-auto text-[11px] text-ink-3">sample draft</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-full bg-sage px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(91,138,114,0.28)] transition-colors hover:bg-sage-deep"
    >
      {copied ? "Copied ✓" : label}
    </button>
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

function EmptyState() {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-2 bg-card-mut p-7 text-center">
      <div className="font-display text-[17px] font-semibold text-ink">
        Your escalation draft appears here
      </div>
      <p className="mx-auto mt-2 max-w-[32ch] text-[13px] leading-relaxed text-ink-2">
        Once your pathway is loaded, we&apos;ll draft a ready-to-send message —
        for the advice line, PALS, or your clinician.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-card" aria-busy="true">
      <div className="h-3 w-24 animate-pulse rounded bg-black/[0.06]" />
      <div className="mt-4 flex flex-col gap-2.5">
        {[92, 100, 84, 96, 70].map((w, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-black/[0.04]"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-clay-soft bg-[#fff7f4] p-6 text-center">
      <div className="font-display text-[16px] font-semibold text-clay">
        We couldn&apos;t draft the message
      </div>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] leading-relaxed text-clay-ink">
        {message}
      </p>
    </div>
  );
}
