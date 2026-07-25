# Pathway Copilot

Reconstruct your NHS IBD pathway state from your own letters, and draft
evidence-backed, **administrative** escalations that help move you forward.

## The problem

In the UK, IBD (inflammatory bowel disease) patients wait a **median of 76
days** from biologics referral to first dose. The pathway has several stages —
referral, screening, funding, homecare, first dose — and patients often can't
tell where they are stuck or why. They hold the evidence themselves: the NHS
letters they've been sent.

Pathway Copilot reads those letters, reconstructs the current pathway state
with **deterministic logic**, optionally joins objective wearable data
(Fitbit) for context, and drafts a polite, specific, factual escalation the
patient can send to an advice line, PALS, or their clinician.

## Hard constraints

These are non-negotiable and enforced in the architecture:

- **The state machine is deterministic code, not an LLM.** LLMs only (1)
  extract structured JSON from documents and (2) draft prose. They **never**
  decide clinical stage or urgency.
- **No clinical advice in any output.** Escalations are administrative (chasing
  a process), never medical. Wearable vitals are presented as objective context
  only — never interpreted or turned into a clinical claim.
- **All patient data stays in session memory. Nothing is persisted** — no
  database, no auth. Refreshing clears everything.
- **Single demo path, ship over polish.** No features beyond those specified.

## Modules (build order)

The pipeline is built in this fixed order; each stage feeds the next:

1. **Extractor** (LLM) — one NHS letter (PDF/image) → strict JSON: date,
   doc type, stage signal, clinician, actions stated, tests ordered, drugs
   mentioned, confidence. No inference of unwritten dates; low confidence is
   flagged, not guessed.
2. **State machine** (deterministic code) — array of extractor outputs sorted
   by date → current stage, days in stage, total days elapsed, overdue flag,
   blocker, and benchmark comparison. Expected max days per stage: referral 14,
   screening 21, funding 28, homecare 14.
3. **Vitals joiner** (code, no interpretation) — Fitbit CSV (resting HR, sleep
   minutes, HRV, steps) + pathway start date → per-metric deltas vs a 7-day
   baseline and the date of the largest sustained change. Deltas only.
4. **Drafter** (LLM) — state-machine output + vitals deltas + target
   (advice line / PALS / clinician summary) → ready-to-send text. Polite,
   specific, factual, firm; cites exact dates and day counts; names one
   requested action and one requested date. Never a clinical claim.
5. **UI** — three-panel interface to run the pipeline.
6. **Clinician summary** — structured one-pager (cut first if behind schedule).

## Tech stack

Next.js (App Router) · TypeScript · Tailwind CSS · Runware (OpenAI-compatible
LLM API). No database, no auth.

## Getting started

Requires Node 20+ (developed on Node 22).

```bash
npm install
cp .env.example .env   # optional — see below
npm run dev
```

Open http://localhost:3000.

### Runware key (optional)

The two AI touchpoints — the **Extractor** (letter → JSON timeline) and the
**Drafter** (emails / clinician summary) — run through [Runware](https://runware.ai),
which exposes a drop-in OpenAI-compatible endpoint.

The app **runs end-to-end without a key.** When `RUNWARE_API_KEY` is unset, the
extractor and drafter fall back to deterministic mocks, so the full demo path
works offline. To enable live LLM extraction and drafting, set the key in `.env`:

```
RUNWARE_API_KEY=...
RUNWARE_MODEL=openai-gpt-5-4-mini   # optional override; hyphenated model id
```

`RUNWARE_MODEL` defaults to a cheap, fast, JSON-friendly chat model. Runware's
OpenAI-compatible endpoint uses **fully-hyphenated** ids of the form
`provider-model-version` (e.g. `openai-gpt-5-4-mini`) — not a
`provider:model@variant` form. List the exact accepted ids with
`curl https://api.runware.ai/v1/models -H "authorization: Bearer $KEY"`.

> **Note:** Gemini models are not compatible with our `response_format:
> {type:'json_object'}` on Runware (they 400 with "Missing required parameter:
> jsonSchema"), so choose an OpenAI model. Also, `gpt-5` models reject
> `max_tokens` in favour of `max_completion_tokens` — the app sends neither.

Never commit the key — store it in the secrets manager.

**PDF letters.** Uploaded PDFs are handled server-side: text-based PDFs have their
text extracted and sent as text (no vision cost); scanned/image-only PDFs fall
back to the vision-capable model so extraction still works.

**Clinical safety.** The LLM only extracts JSON and drafts prose. The clinical
stage / urgency is decided exclusively by the deterministic state machine
(`lib/pipeline/stateMachine.ts`) — never the model.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check, no emit
- `npm run lint` — Next.js lint

## Development workflow

Work lands on the `sandbox` branch via PRs and reaches `main` only after human
approval. Branch off `sandbox`, open PRs against `sandbox`.
