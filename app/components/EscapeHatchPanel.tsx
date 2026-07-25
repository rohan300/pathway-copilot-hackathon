"use client";

import { useState } from "react";
import type { DraftResult, EscapeHatch, PrivateProvider } from "@/lib/pipeline/types";

/** The two private-route draft targets — the only ones this card can request. */
export type PrivateTarget = "insurer_preauth" | "nhs_private_notice";

interface Props {
  hatch: EscapeHatch | null;
  draft: DraftResult | null;
  target: PrivateTarget;
  onSelectTarget: (t: PrivateTarget) => void;
  loading: boolean;
  error: string | null;
}

const TABS: { value: PrivateTarget; label: string; to: string }[] = [
  { value: "insurer_preauth", label: "Insurer pre-auth", to: "your insurer" },
  { value: "nhs_private_notice", label: "Note to NHS team", to: "your NHS team" },
];

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

/**
 * The alternative route, shown beside the escalation — deliberately SECONDARY
 * to it. Chasing the NHS department stays the primary action; this card only
 * says that one outstanding step could also be obtained privately.
 *
 * It renders nothing at all unless the deterministic matcher marked this exact
 * step coverable: no empty card, and no "not covered" nag when it didn't (that
 * one-line outcome already lives in the coverage control). Providers are a
 * neutral list, never a recommendation — nothing here tells anyone where to go.
 */
export default function EscapeHatchPanel({
  hatch,
  draft,
  target,
  onSelectTarget,
  loading,
  error,
}: Props) {
  if (!hatch || !hatch.coverable) return null;

  return (
    <section className="flex max-h-[42%] min-h-0 flex-none flex-col overflow-hidden rounded-2xl border border-line-2 bg-card-mut">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line px-4 pt-3.5 pb-3">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink-3">
          Alternative route
        </span>
        <span className="text-[13.5px] font-semibold text-ink">
          One step could be obtained privately
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-line-2 bg-card px-2.5 py-1 text-[11.5px] font-semibold text-ink">
            {hatch.node.label}
          </span>
          <span className="text-[11.5px] text-ink-3">{hatch.node.dept}</span>
        </div>

        <p className="mt-2.5 text-[12.5px] leading-[1.65] text-ink-2">{hatch.reason}</p>

        <Providers providers={hatch.providers} />

        {hatch.caveats.length > 0 && (
          <ul className="mt-3.5 flex flex-col gap-1.5">
            {hatch.caveats.map((c, i) => (
              <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-ink-2">
                <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-line-2" aria-hidden />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Always visible — never behind a tooltip or a disclosure. */}
        <div className="mt-3.5 rounded-xl border border-line-2 bg-card px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
          Cover shown here is indicative and depends on your own policy wording. Pre-authorisation
          or a GP referral may be required before anything is booked. This route covers the one
          outstanding diagnostic step — not the treatment it leads to, and not your ongoing NHS
          care.
        </div>

        <PrivateDraft
          draft={draft}
          target={target}
          onSelectTarget={onSelectTarget}
          loading={loading}
          error={error}
        />
      </div>
    </section>
  );
}

/**
 * Options, not directions: a flat list of providers that list this kind of
 * test, with the indicative wait and price as plain facts. No ranking language,
 * no "best" or "nearest", no booking action.
 */
function Providers({ providers }: { providers: PrivateProvider[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="mt-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
        Places that list this test
      </div>
      <ul className="mt-2 flex flex-col gap-px overflow-hidden rounded-xl bg-line-2">
        {providers.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 bg-card px-3.5 py-2.5">
            <span className="text-[12.5px] font-semibold text-ink">{p.name}</span>
            <span className="text-[11.5px] text-ink-3">
              {p.specialty} · {p.region}
            </span>
            <span className="ml-auto text-[11.5px] text-ink-2">
              approx. {p.indicative_wait_days} day wait ·{" "}
              {gbp.format(p.indicative_price_gbp)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
        A list for information only — these are not recommendations, and waits and prices are
        illustrative rather than quotes.
      </div>
    </div>
  );
}

/**
 * The D4 private-route draft — a pre-auth request to the insurer, or a note
 * telling the NHS team one step is being obtained privately (so the report
 * comes back and the pathway continues).
 */
function PrivateDraft({
  draft,
  target,
  onSelectTarget,
  loading,
  error,
}: {
  draft: DraftResult | null;
  target: PrivateTarget;
  onSelectTarget: (t: PrivateTarget) => void;
  loading: boolean;
  error: string | null;
}) {
  const to = TABS.find((t) => t.value === target)?.to ?? "";

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
        If you take this route
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={t.value === target}
            onClick={() => onSelectTarget(t.value)}
            className={`rounded-full border px-3 py-1.5 text-[11.5px] font-semibold transition-colors ${
              t.value === target
                ? "border-ink-3 bg-card text-ink"
                : "border-line-2 bg-transparent text-ink-3 hover:border-ink-3 hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-2.5 rounded-xl border border-clay-soft bg-[#fff7f4] px-3.5 py-3 text-[11.5px] leading-relaxed text-clay-ink">
          {error}
        </div>
      ) : loading || !draft ? (
        <div className="mt-2.5 flex flex-col gap-2 rounded-xl border border-line-2 bg-card px-3.5 py-3" aria-busy="true">
          {[88, 96, 72].map((w, i) => (
            <div
              key={i}
              className="h-2.5 animate-pulse rounded bg-black/[0.04]"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      ) : (
        <div className="mt-2.5 rounded-xl border border-line-2 bg-card px-3.5 py-3">
          <div className="text-[11px] text-ink-3">
            To — <span className="font-semibold text-ink">{to}</span>
          </div>
          <div className="mt-2 text-[12.5px] leading-[1.7] text-ink whitespace-pre-line">
            {draft.text}
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <CopyButton text={draft.text} />
            <span className="text-[11px] text-ink-3">Edit anything before you send it</span>
            {draft.mocked && <span className="ml-auto text-[11px] text-ink-3">sample draft</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Outlined, not filled — the primary Copy action belongs to the escalation. */
function CopyButton({ text }: { text: string }) {
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
      className="rounded-full border border-line-2 bg-card px-3.5 py-1.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:border-sage hover:text-sage-deep"
    >
      {copied ? "Copied ✓" : "Copy draft"}
    </button>
  );
}
