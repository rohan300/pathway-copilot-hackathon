"use client";

import { useEffect, useState } from "react";
import type {
  Coverage,
  DraftResult,
  DraftTarget,
  EscapeHatch,
  Extraction,
  NoStallReason,
  PathwayGraph,
  Stall,
  VitalsResult,
} from "@/lib/pipeline/types";
import {
  computeGraph,
  draftEscalation,
  extractSample,
  extractUpload,
  fetchSamples,
  joinVitals,
} from "@/lib/client";
import {
  parseCsvSeries,
  pathwayStartDate,
  type CsvPoint,
} from "@/lib/view";
import AppHeader from "./components/AppHeader";
import CoverageControl, { NO_COVER, hasCover } from "./components/CoverageControl";
import PathwayPanel from "./components/PathwayPanel";
import VitalsPanel from "./components/VitalsPanel";
import DraftPanel from "./components/DraftPanel";
import EscapeHatchPanel, { type PrivateTarget } from "./components/EscapeHatchPanel";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Only send coverage once it actually covers something, so the default
 * (no cover declared) leaves the graph request exactly as it was before D.
 */
function coverageForRequest(c: Coverage): Coverage | null {
  return hasCover(c) ? c : null;
}

/**
 * The whole Critical Path screen — one page, single demo path. Orchestrates
 * the pipeline (extract → graph → stall → draft) and holds all state
 * in memory. Nothing is persisted. Layout and voice follow the picked
 * "Companion" mockup; data is the real GLD-4 pipeline.
 */
export default function Home() {
  const [docs, setDocs] = useState<Array<Extraction & { id: string; source: string }>>([]);
  const [graph, setGraph] = useState<PathwayGraph | null>(null);
  const [stall, setStall] = useState<Stall | null>(null);
  // Only read when `stall` is null — the API's own account of why nothing is
  // overdue, so the panel never falls back to reporting a bare node count.
  const [noStallReason, setNoStallReason] = useState<NoStallReason | null>(null);
  // Declared client-side only, never persisted, and defaulted to no cover so
  // the escalation-only path is what shows first.
  const [coverage, setCoverage] = useState<Coverage>(NO_COVER);
  const [escapeHatch, setEscapeHatch] = useState<EscapeHatch | null>(null);
  const [vitals, setVitals] = useState<VitalsResult | null>(null);
  const [series, setSeries] = useState<CsvPoint[]>([]);
  const [csvText, setCsvText] = useState<string>("");
  const [startDate, setStartDate] = useState<string | null>(null);

  const [target, setTarget] = useState<DraftTarget>("advice_line");
  const [draft, setDraft] = useState<DraftResult | null>(null);

  // The private-route draft is separate state: the escape hatch is the
  // alternative shown beside the escalation, never a replacement for it, so
  // both drafts exist at once.
  const [hatchTarget, setHatchTarget] = useState<PrivateTarget>("insurer_preauth");
  const [hatchDraft, setHatchDraft] = useState<DraftResult | null>(null);
  const [hatchDrafting, setHatchDrafting] = useState(false);
  const [hatchError, setHatchError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [vitalsBusy, setVitalsBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const hasData = docs.length > 0;
  /** Load the bundled sample pathway end-to-end (no upload needed). */
  async function loadSample() {
    setBusy(true);
    setVitalsBusy(true);
    setError(null);
    setVitalsError(null);
    try {
      const samples = await fetchSamples();
      const extractions = await Promise.all(
        samples.letters.map((l) => extractSample(l.id)),
      );
      const nextDocs: Array<Extraction & { id: string; source: string }> = extractions.map((e, i) => ({
        ...e,
        id: samples.letters[i].id,
        source: `${samples.letters[i].title}.pdf`,
      }));
      const nextResult = await computeGraph(extractions, undefined, coverageForRequest(coverage));
      const nextVitals = await joinVitals(samples.fitbitCsv, samples.startDate);

      setDocs(nextDocs);
      setGraph(nextResult.graph);
      setStall(nextResult.stall);
      setNoStallReason(nextResult.noStallReason);
      setEscapeHatch(nextResult.escapeHatch);
      setStartDate(samples.startDate);
      setCsvText(samples.fitbitCsv);
      setSeries(parseCsvSeries(samples.fitbitCsv));
      setVitals(nextVitals);
    } catch (e) {
      setError(errMsg(e, "Something went wrong loading the sample pathway."));
    } finally {
      setBusy(false);
      setVitalsBusy(false);
    }
  }

  /** Add one or more real NHS letters and recompute the pathway. */
  async function addLetters(files: File[]) {
    setBusy(true);
    setError(null);
    try {
      const added = await Promise.all(
        files.map(async (f) => ({
          ...(await extractUpload({ file: f })),
          id:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${f.name}-${Date.now()}`,
          source: f.name,
        })),
      );
      const nextDocs = [...docs, ...added];
      const start = pathwayStartDate(nextDocs) ?? startDate;
      const nextResult = await computeGraph(nextDocs, undefined, coverageForRequest(coverage));

      setDocs(nextDocs);
      setGraph(nextResult.graph);
      setStall(nextResult.stall);
      setNoStallReason(nextResult.noStallReason);
      setEscapeHatch(nextResult.escapeHatch);
      setStartDate(start);

      // Re-join vitals against the (possibly new) pathway start.
      if (csvText && start) {
        setVitals(await joinVitals(csvText, start));
      }
    } catch (e) {
      setError(errMsg(e, "We couldn't read that letter. Try a clearer photo or PDF."));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Declare (or clear) private cover. Client-side only — nothing is persisted.
   * With letters already loaded the graph is recomputed so the escape hatch
   * tracks the declaration immediately; the graph and stall themselves are
   * unaffected by coverage, only the hatch alongside them.
   */
  async function changeCoverage(next: Coverage) {
    setCoverage(next);
    if (docs.length === 0) {
      setEscapeHatch(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextResult = await computeGraph(docs, undefined, coverageForRequest(next));
      setGraph(nextResult.graph);
      setStall(nextResult.stall);
      setNoStallReason(nextResult.noStallReason);
      setEscapeHatch(nextResult.escapeHatch);
    } catch (e) {
      setEscapeHatch(null);
      setError(errMsg(e, "We couldn't check that cover against your pathway."));
    } finally {
      setBusy(false);
    }
  }

  /** Add a Fitbit CSV and join it against the pathway start date. */
  async function addCsv(file: File) {
    const start = startDate ?? pathwayStartDate(docs);
    if (!start) {
      setVitalsError(
        "Add your letters first so we know when your pathway started.",
      );
      return;
    }
    setVitalsBusy(true);
    setVitalsError(null);
    try {
      const text = await file.text();
      const nextVitals = await joinVitals(text, start);
      setCsvText(text);
      setSeries(parseCsvSeries(text));
      setVitals(nextVitals);
    } catch (e) {
      setVitalsError(errMsg(e, "We couldn't read that Fitbit CSV."));
    } finally {
      setVitalsBusy(false);
    }
  }

  // Draft (re)generates whenever the stall, vitals, or chosen target changes.
  useEffect(() => {
    if (!stall) {
      setDraft(null);
      return;
    }
    let alive = true;
    setDrafting(true);
    setDraftError(null);
    draftEscalation({ stall, vitals, target })
      .then((d) => {
        if (alive) setDraft(d);
      })
      .catch((e) => {
        if (alive) setDraftError(errMsg(e, "We couldn't draft the message."));
      })
      .finally(() => {
        if (alive) setDrafting(false);
      });
    return () => {
      alive = false;
    };
  }, [stall, vitals, target]);

  // The private-route draft only exists while there is a coverable hatch —
  // clear it the moment the cover, or the stalled step, stops qualifying.
  useEffect(() => {
    if (!stall || !escapeHatch || !escapeHatch.coverable) {
      setHatchDraft(null);
      setHatchError(null);
      return;
    }
    let alive = true;
    setHatchDrafting(true);
    setHatchError(null);
    draftEscalation({ stall, vitals, target: hatchTarget, escapeHatch })
      .then((d) => {
        if (alive) setHatchDraft(d);
      })
      .catch((e) => {
        if (alive) setHatchError(errMsg(e, "We couldn't draft the private-route message."));
      })
      .finally(() => {
        if (alive) setHatchDrafting(false);
      });
    return () => {
      alive = false;
    };
  }, [stall, vitals, escapeHatch, hatchTarget]);

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <AppHeader
        onLetters={addLetters}
        onCsv={addCsv}
        onLoadSample={loadSample}
        busy={busy}
        letterCount={docs.length}
        hasCsv={Boolean(vitals)}
        hasData={hasData}
      />

      <CoverageControl
        coverage={coverage}
        onChange={changeCoverage}
        escapeHatch={escapeHatch}
        busy={busy}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-6 pb-6 md:px-8 lg:grid-cols-3">
        <PathwayPanel
          graph={graph}
          stall={stall}
          noStallReason={noStallReason}
          loading={busy && !hasData}
          error={error}
          hasData={hasData}
          onLoadSample={loadSample}
        />
        <VitalsPanel
          vitals={vitals}
          series={series}
          loading={vitalsBusy && !vitals}
          error={vitalsError}
          hasPathway={hasData}
        />
        {/* RIGHT column — the escalation is the primary action and keeps the
            column; the escape hatch sits under it as the secondary alternative
            and collapses away entirely when there is nothing coverable. */}
        <div className="flex min-h-0 flex-col gap-4">
          <DraftPanel
            draft={draft}
            target={target}
            onSelectTarget={setTarget}
            loading={drafting}
            error={draftError}
            hasState={Boolean(stall)}
          />
          <EscapeHatchPanel
            hatch={escapeHatch}
            draft={hatchDraft}
            target={hatchTarget}
            onSelectTarget={setHatchTarget}
            loading={hatchDrafting}
            error={hatchError}
          />
        </div>
      </div>
    </main>
  );
}
