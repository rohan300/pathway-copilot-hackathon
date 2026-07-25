"use client";

import { useRef, useState } from "react";

interface Props {
  onLetters: (files: File[]) => void;
  onCsv: (file: File) => void;
  onLoadSample: () => void;
  busy: boolean;
  letterCount: number;
  hasCsv: boolean;
  hasData: boolean;
}

/**
 * Top bar — product identity, the upload affordances (letters, Fitbit CSV),
 * and a one-tap "sample pathway" loader so the demo runs with no files.
 * Supports click and drag-and-drop. Not navigation: the app is one screen.
 */
export default function AppHeader({
  onLetters,
  onCsv,
  onLoadSample,
  busy,
  letterCount,
  hasCsv,
  hasData,
}: Props) {
  const letterInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const letters = files.filter((f) => !f.name.toLowerCase().endsWith(".csv"));
    const csv = files.find((f) => f.name.toLowerCase().endsWith(".csv"));
    if (letters.length) onLetters(letters);
    if (csv) onCsv(csv);
  }

  return (
    <header
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`flex flex-wrap items-center gap-4 px-6 py-4 transition-colors md:px-8 ${
        dragging ? "bg-sage-soft" : ""
      }`}
    >
      <div className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-sage text-base font-bold text-white shadow-[0_2px_8px_rgba(91,138,114,0.28)]">
        P
      </div>
      <div className="leading-tight">
        <div className="font-display text-[20px] font-semibold tracking-[-0.01em] text-ink">
          Pathway Copilot
        </div>
        <div className="text-[12.5px] text-ink-3">
          {dragging
            ? "Drop your letters or a Fitbit CSV…"
            : "Built from your own letters · nothing is saved"}
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        {hasData && (
          <span className="hidden rounded-full border border-line bg-card px-3 py-1.5 text-[12px] text-ink-3 sm:inline">
            {letterCount} letter{letterCount === 1 ? "" : "s"}
            {hasCsv ? " · Fitbit added" : ""}
          </span>
        )}
        <button
          type="button"
          onClick={onLoadSample}
          disabled={busy}
          className="rounded-full px-3.5 py-2 text-[13px] font-semibold text-sage-deep transition-colors hover:bg-sage-soft disabled:opacity-50"
        >
          {hasData ? "Reload sample" : "Load sample pathway"}
        </button>
        <button
          type="button"
          onClick={() => letterInput.current?.click()}
          disabled={busy}
          className="rounded-full border border-line-2 bg-card px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-sage hover:text-sage-deep disabled:opacity-50"
        >
          + Add a letter
        </button>
        <button
          type="button"
          onClick={() => csvInput.current?.click()}
          disabled={busy}
          className="rounded-full bg-sage px-4 py-2 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(91,138,114,0.28)] transition-colors hover:bg-sage-deep disabled:opacity-50"
        >
          ↑ Fitbit CSV
        </button>
      </div>

      <input
        ref={letterInput}
        type="file"
        accept=".pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onLetters(files);
          e.target.value = "";
        }}
      />
      <input
        ref={csvInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onCsv(file);
          e.target.value = "";
        }}
      />
    </header>
  );
}
