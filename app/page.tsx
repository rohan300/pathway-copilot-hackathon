"use client";

import { useEffect, useState } from "react";
import type {
  DraftResult,
  DraftTarget,
  StateMachineResult,
  VitalsResult,
} from "@/lib/pipeline/types";
import {
  computeState,
  draftEscalation,
  extractSample,
  extractUpload,
  fetchSamples,
  joinVitals,
} from "@/lib/client";
import {
  buildMilestones,
  parseCsvSeries,
  pathwayStartDate,
  type CsvPoint,
  type DocRecord,
} from "@/lib/view";
import AppHeader from "./components/AppHeader";
import PathwayPanel from "./components/PathwayPanel";
import VitalsPanel from "./components/VitalsPanel";
import DraftPanel from "./components/DraftPanel";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * The whole Pathway Copilot screen — one page, single demo path. Orchestrates
 * the pipeline (extract → state machine → vitals → draft) and holds all state
 * in memory. Nothing is persisted. Layout and voice follow the picked
 * "Companion" mockup; data is the real GLD-4 pipeline.
 */
export default function Home() {
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [state, setState] = useState<StateMachineResult | null>(null);
  const [vitals, setVitals] = useState<VitalsResult | null>(null);
  const [series, setSeries] = useState<CsvPoint[]>([]);
  const [csvText, setCsvText] = useState<string>("");
  const [startDate, setStartDate] = useState<string | null>(null);

  const [target, setTarget] = useState<DraftTarget>("advice_line");
  const [draft, setDraft] = useState<DraftResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [vitalsBusy, setVitalsBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const hasData = docs.length > 0;
  const milestones = buildMilestones(docs, state);

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
      const nextDocs: DocRecord[] = extractions.map((e, i) => ({
        ...e,
        id: samples.letters[i].id,
        source: `${samples.letters[i].title}.pdf`,
      }));
      const nextState = await computeState(extractions);
      const nextVitals = await joinVitals(samples.fitbitCsv, samples.startDate);

      setDocs(nextDocs);
      setState(nextState);
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
      const nextState = await computeState(nextDocs);

      setDocs(nextDocs);
      setState(nextState);
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

  // Draft (re)generates whenever the state, vitals, or chosen target changes.
  useEffect(() => {
    if (!state) {
      setDraft(null);
      return;
    }
    let alive = true;
    setDrafting(true);
    setDraftError(null);
    draftEscalation({ state, vitals, target })
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
  }, [state, vitals, target]);

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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-6 pb-6 md:px-8 lg:grid-cols-3">
        <PathwayPanel
          milestones={milestones}
          state={state}
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
        <DraftPanel
          draft={draft}
          target={target}
          onSelectTarget={setTarget}
          loading={drafting}
          error={draftError}
          hasState={Boolean(state)}
        />
      </div>
    </main>
  );
}
