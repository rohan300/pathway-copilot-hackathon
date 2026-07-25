"use client";

import type { Coverage, EscapeHatch } from "@/lib/pipeline/types";

interface Props {
  coverage: Coverage;
  onChange: (next: Coverage) => void;
  escapeHatch: EscapeHatch | null;
  busy: boolean;
}

/** The default and the thing we always fall back to: declare nothing. */
export const NO_COVER: Coverage = {
  plan_type: null,
  covers_diagnostics: false,
  covers_consults: false,
  requires_gp_referral: false,
  requires_preauth: false,
  excludes: [],
  confidence: 1,
};

/**
 * UK private medical insurance almost universally excludes ongoing treatment of
 * a chronic condition, which is exactly why the jak inhibitor approval can never
 * be routed privately — only a discrete diagnostic step can. Every plan below
 * carries the exclusion, so the deterministic match has it to work with.
 */
const STANDARD_EXCLUSIONS = ["chronic disease management", "pre-existing conditions"];

/** Named, plausible, and clearly fictionalised — indicative defaults, not a policy quote. */
const PLANS: { label: string; coverage: Coverage }[] = [
  { label: "No private cover", coverage: NO_COVER },
  {
    label: "Bupa Comprehensive (employer)",
    coverage: {
      plan_type: "Bupa Comprehensive (employer)",
      covers_diagnostics: true,
      covers_consults: true,
      requires_gp_referral: true,
      requires_preauth: true,
      excludes: STANDARD_EXCLUSIONS,
      confidence: 1,
    },
  },
  {
    label: "Vitality Core",
    coverage: {
      plan_type: "Vitality Core",
      covers_diagnostics: true,
      covers_consults: true,
      requires_gp_referral: true,
      requires_preauth: true,
      excludes: [...STANDARD_EXCLUSIONS, "out-patient diagnostics above plan limit"],
      confidence: 1,
    },
  },
  {
    label: "AXA Health Personal",
    coverage: {
      plan_type: "AXA Health Personal",
      covers_diagnostics: true,
      covers_consults: true,
      requires_gp_referral: true,
      requires_preauth: false,
      excludes: STANDARD_EXCLUSIONS,
      confidence: 1,
    },
  },
  {
    label: "WPA Diagnostics only",
    coverage: {
      plan_type: "WPA Diagnostics only",
      covers_diagnostics: true,
      covers_consults: false,
      requires_gp_referral: false,
      requires_preauth: true,
      excludes: [...STANDARD_EXCLUSIONS, "consultant appointments"],
      confidence: 1,
    },
  },
];

/** Does this coverage cover anything at all? Drives the summary line. */
export function hasCover(c: Coverage): boolean {
  return c.covers_diagnostics || c.covers_consults;
}

function summarise(c: Coverage): string {
  if (!hasCover(c)) return "No cover set · escalation only";
  const parts = [c.covers_diagnostics && "diagnostics", c.covers_consults && "consultations"].filter(
    Boolean,
  );
  return `${c.plan_type ?? "Cover declared"} · ${parts.join(" + ")}`;
}

/**
 * A small, always-collapsed-by-default strip under the header: pick a plan, then
 * override what it covers. Defaults to no cover so the escalation-only path is
 * what a first-time visitor sees. Nothing here is persisted — it is passed
 * straight to the graph call, where the coverage match stays deterministic.
 */
export default function CoverageControl({ coverage, onChange, escapeHatch, busy }: Props) {
  const covered = hasCover(coverage);

  function selectPlan(label: string) {
    const plan = PLANS.find((p) => p.label === label);
    if (plan) onChange({ ...plan.coverage });
  }

  return (
    <details className="mx-6 mb-4 overflow-hidden rounded-2xl border border-line bg-card shadow-soft md:mx-8">
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3 hover:bg-black/[0.02]">
        <span
          className={`h-2 w-2 flex-none rounded-full ${covered ? "bg-sage" : "bg-line-2"}`}
          aria-hidden
        />
        <span className="text-[13px] font-semibold text-ink">Private cover</span>
        <span className="text-[12.5px] text-ink-3">{summarise(coverage)}</span>
        <span className="ml-auto text-[12px] text-ink-3">Change ▾</span>
      </summary>

      <div className="border-t border-line px-4 pb-4 pt-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
          Your plan
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {PLANS.map((p) => {
            const selected = (coverage.plan_type ?? "No private cover") === p.label;
            return (
              <button
                key={p.label}
                type="button"
                disabled={busy}
                aria-pressed={selected}
                onClick={() => selectPlan(p.label)}
                className={`rounded-full border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-sage bg-sage text-white"
                    : "border-line-2 bg-card text-ink-2 hover:border-sage hover:text-sage-deep"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
          What it covers
        </div>
        <div className="mt-2 flex flex-wrap gap-2.5">
          <Toggle
            label="Diagnostics"
            hint="Scans, scopes and other discrete tests"
            on={coverage.covers_diagnostics}
            busy={busy}
            onToggle={() =>
              onChange({ ...coverage, covers_diagnostics: !coverage.covers_diagnostics })
            }
          />
          <Toggle
            label="Consultations"
            hint="Out-patient consultant appointments"
            on={coverage.covers_consults}
            busy={busy}
            onToggle={() => onChange({ ...coverage, covers_consults: !coverage.covers_consults })}
          />
        </div>

        {(coverage.requires_gp_referral || coverage.requires_preauth) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {coverage.requires_gp_referral && <Chip text="GP referral required" />}
            {coverage.requires_preauth && <Chip text="Pre-authorisation required" />}
          </div>
        )}

        {/* The full escape-hatch card — providers, caveats, second draft — is D5.
            This is only the one-line outcome of the match. escapeHatch() returns
            a result in the not-coverable case too, carrying the reason; showing it
            is what stops the toggles implying a step (e.g. the treatment approval)
            can be routed privately when it never can. */}
        {escapeHatch && (
          <div
            className={`mt-3.5 rounded-xl px-3.5 py-3 text-[12px] leading-relaxed ${
              escapeHatch.coverable ? "bg-sage-soft text-ink-2" : "bg-card-mut text-ink-2"
            }`}
          >
            {escapeHatch.coverable
              ? "One step in your path may be obtainable privately. Options appear alongside your escalation."
              : escapeHatch.reason}
          </div>
        )}

        <div className="mt-3.5 rounded-xl bg-card-mut px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
          Indicative only — cover is policy-dependent and we never check it against your insurer.
          Private cover applies to one-off diagnostic steps, not to ongoing treatment of a
          long-term condition. Nothing here is saved.
        </div>
      </div>
    </details>
  );
}

function Toggle({
  label,
  hint,
  on,
  busy,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={onToggle}
      className={`flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50 ${
        on ? "border-sage bg-sage-soft/60" : "border-line-2 bg-card hover:border-sage"
      }`}
    >
      <span
        className={`relative h-5 w-9 flex-none rounded-full transition-colors ${
          on ? "bg-sage" : "bg-line-2"
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-soft transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
      <span className="leading-tight">
        <span className={`block text-[13px] font-semibold ${on ? "text-sage-deep" : "text-ink"}`}>
          {label}
        </span>
        <span className="block text-[11.5px] text-ink-3">{hint}</span>
      </span>
    </button>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-line-2 bg-card-mut px-3 py-1 text-[11.5px] text-ink-2">
      {text}
    </span>
  );
}
