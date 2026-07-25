# BUILD PROMPT — "Critical Path" (pivot of the Pathway Copilot repo)

## Context
Repo root: /Users/rohan/Documents/Development/ibd-pathway-copilot
Stack: Next.js 15 (App Router) + TypeScript + Tailwind. The repo is a working
hackathon app "Pathway Copilot" that must be pivoted into "Critical Path."

PIVOT IN ONE SENTENCE: replace a linear 5-stage "state machine" that outputs one current stage, with a CROSS-DEPARTMENT DEPENDENCY GRAPH that identifies the stalled node blocking downstream progress and produces OUTBOUND actions — chase the owning department, or route around the bottleneck via a covered private step.

Motivating fixture (build everything around this): a jak inhibitor approval (Gastroenterology) is blocked awaiting pulmonary clearance (Respiratory), which only exists because of an incidental finding on a TB-screening chest X-ray, which spawned CT -> bronchoscopy -> repeat CT. 8 nodes, 2 specialties, ~4 months, no
treatment. No single department owns the chain. That is the whole point.

Target demo: real letters in -> dependency graph out -> stall identified with
dates -> escalation drafted to the owning department (+ optional private escape
hatch for the one bottleneck node).

## Provider — DO NOT CHANGE THIS
Keep the existing Runware LLM layer in lib/provider.ts EXACTLY as-is. It works.
- Base URL https://api.runware.ai/v1, key RUNWARE_API_KEY, model
  openai-gpt-5-4-mini (already working — do not change the slug).
- Runware is OpenAI-compatible via the `openai` SDK.
- QUIRKS to respect: response_format {type:'json_object'} works on the OpenAI
  model but Gemini models 400 on it — stay on the OpenAI model. Do NOT send
  max_tokens (gpt-5 rejects it). Keep parseJsonLoose() for robust JSON parsing.
- HARD CONSTRAINT (keep from old design): the LLM ONLY extracts JSON from
  documents and drafts prose. It NEVER decides what is stalled or what is
  covered. All graph/stall/coverage logic is deterministic TypeScript. This is a
  demo-reliability requirement.

## What EXISTS — keep vs discard (already audited, do not re-explore)
KEEP AS-IS:
- lib/provider.ts (Runware client + parseJsonLoose)
- lib/pdf.ts (PDF text extraction; it imports pdf-parse via its inner module
  `pdf-parse/lib/pdf-parse.js` deliberately — do NOT "fix" that import)
- app/api/extract/route.ts multipart/PDF/image handling (output type changes only)
- The drafter voice constraints in lib/pipeline/drafter.ts: polite/specific/
  factual/firm, exactly ONE requested action + ONE requested date, ADMINISTRATIVE
  not medical, NEVER a clinical claim. Keep its LLM-or-template + try/catch
  error-degrade structure.
- app/components/DraftPanel.tsx (target selector + rendered draft) and
  app/components/AppHeader.tsx (upload controls).

DISCARD:
- lib/pipeline/stateMachine.ts runStateMachine() — it is a fold-to-one-scalar
  reducer, structurally unable to represent a graph. KEEP ONLY its helpers
  parseDate(), daysBetween(), todayISO(), and the EXPECTED_MAX_DAYS concept.
- lib/view.ts buildMilestones() + the 5-stage linear ladder.
- app/components/PathwayPanel.tsx (linear milestone UI).
- Leave lib/pipeline/vitals.ts + VitalsPanel.tsx dormant (orthogonal; don't build
  on them, don't delete them).

## THE SHARED CONTRACT — build this FIRST, before splitting work
Define in lib/pipeline/types.ts. Everything else depends on it, so lock it first.

Replace the `Extraction` interface with a per-letter schema (extractor stays
PER-LETTER and STATELESS — do not make one LLM call reason across letters):

```ts
interface Extraction {
  letter_date: string | null;              // never inferred; null if unwritten
  department: string | null;               // e.g. "Gastroenterology","Respiratory"
  clinicians: { name: string; dept: string | null }[];
  investigations: {
    id: string;                            // slug, unique within letter
    name: string;                          // e.g. "CT chest"
    type: string;                          // normalized: "ct"|"mri"|"bronchoscopy"|"consult"|"bloods"|"xray"|"other"
    ordered_date: string | null;
    report_date: string | null;
    status: "ordered"|"booked"|"done"|"reported"|"actioned"|"unknown";
  }[];
  findings: { text: string; on_investigation: string | null; spawned: string | null }[];
  referrals: { from_dept: string|null; to_dept: string|null; reason: string|null; date: string|null }[];
  dependencies: { blocked_item: string; blocking_item: string; stated_status: string|null }[]; // "awaiting X before Y"
  mdt: { date: string|null; outcome: string|null; awaiting: string|null }[];
  confidence: number;                      // 0..1, low flagged not guessed
}
```

Graph + stall output types (consumed by the drafter, the UI, and coverage):

```ts
type EdgeKind = "blocks" | "spawned_by" | "awaiting";
interface GraphNode { id: string; label: string; dept: string|null;
  kind: "investigation"|"referral"|"approval"|"finding"|"mdt";
  invType: string|null;                    // mirrors investigations.type when applicable
  status: string; ordered_date: string|null; report_date: string|null;
  expected_days: number|null; }
interface GraphEdge { from: string; to: string; kind: EdgeKind }
interface PathwayGraph { nodes: GraphNode[]; edges: GraphEdge[] }
interface Stall { stalledNode: GraphNode; chain: GraphNode[]; owningDept: string|null;
  sinceDate: string|null; daysStalled: number; expectedDays: number|null }
```

Coverage types (Workstream D):

```ts
interface Coverage {                       // extracted from a policy doc OR set manually
  plan_type: string|null;                  // e.g. "Bupa Comprehensive (employer)"
  covers_diagnostics: boolean;             // discrete diagnostic steps
  covers_consults: boolean;
  requires_gp_referral: boolean;
  requires_preauth: boolean;
  excludes: string[];                      // free text, e.g. ["chronic disease management","pre-existing"]
  confidence: number;
}
interface PrivateProvider { id: string; name: string; specialty: string;
  invTypes: string[];                      // investigation types they can do, e.g. ["ct","consult"]
  region: string; indicative_wait_days: number; indicative_price_gbp: number; }
interface EscapeHatch { node: GraphNode; coverable: boolean; reason: string;
  providers: PrivateProvider[]; caveats: string[] }
```

## WORKSTREAM A — pipeline & logic (owner: repo author)
A1. Extractor: in lib/pipeline/extractor.ts rewrite SYSTEM_PROMPT to emit the new
    Extraction schema, and rewrite normalize() to coerce/validate it. Keep the LLM
    call, the sampleId short-circuit (extractor.ts:127 returns canned extraction —
    KEEP it for the demo path), and the try/catch degrade-to-low-confidence path.
A2. Graph builder: NEW file lib/pipeline/graph.ts.
    buildGraph(extractions: Extraction[]): PathwayGraph
    - Nodes from investigations / referrals / findings / mdt / a terminal
      "jak inhibitor approval" node.
    - Edges assembled DETERMINISTICALLY by matching names/dates across letters:
      dependencies -> "blocks"/"awaiting"; findings.spawned -> "spawned_by".
    - Per-node-type expected_days SLAs (reuse the EXPECTED_MAX_DAYS idea).
A3. Stall detector: findStall(graph, asOf?): Stall | null
    - Stalled node = a non-terminal node past its expected window with >=1 node
      downstream depending on it. Return node, chain to the blocked goal, owning
      dept, since-date, days stalled. Reuse parseDate/daysBetween.
A4. Drafter: in lib/pipeline/drafter.ts rewrite ONLY factsBlock() to consume
    Stall instead of StateMachineResult. Keep everything else. Draft names the
    department to chase, the specific overdue item + its date, the day count, and
    one action + one date.
A5. Tests: 3-4 unit tests over the fixtures asserting findStall flags the CORRECT
    node with correct dates. Highest-risk logic; test it against B1 fixtures.
A6. API: add POST /api/graph (mirror app/api/state/route.ts) -> { graph, stall }.
    Update lib/client.ts: computeState -> computeGraph.

## WORKSTREAM B — fixtures & web UI (owner: second dev)
B1. Fixtures: rewrite lib/pipeline/samples.ts as the 8-node TB-finding chain — 4-6 letters across Gastroenterology + Respiratory, each with a hand-authored correct extraction under the new schema. These ARE the oracle for A5, so they must be internally consistent (dates, dependencies, spawned links, invType).
Keep the sampleId->canned-extraction mechanism, but ensure at least ONE letter runs live through Runware so the demo isn't provably faked.
B2. UI: replace app/components/PathwayPanel.tsx with a VERTICAL DEPENDENCY-LIST
    view (NOT a force-directed graph): chain top-to-bottom, stalled node highlighted, its two dates + day-count prominent, owning dept shown. Keep DraftPanel + AppHeader. Wire /api/graph via lib/client.ts.

## WORKSTREAM C — WhatsApp channel (OPTIONAL, additive)
Start only after B1+B2 work end-to-end. Must NOT fork the pipeline — it is another
client of the same routes.
C1. Twilio WhatsApp SANDBOX (fast, no Meta template approval). New webhook route
    app/api/whatsapp/route.ts for inbound messages.
C2. Inbound letter (photo/PDF): fetch Twilio MediaUrl0 with the account SID/auth-token -> Buffer -> reuse lib/pdf.ts / base64-image path -> reuse extractLetter(). Same pipeline, different transport.
C3. Session state: persist per phone number in Supabase (tables patients(phone), extractions, graph). A webhook is stateless, so this is REQUIRED so the "yes, chase it" turn remembers the graph. Keep the schema minimal.
C4. Conversational flow (proactive nudge is fine inside Twilio's 24h window after
    the user's last message — the demo user texts first, so this is compliant):
      user sends letter -> bot extracts + replies "added, here's what's open"
      -> bot: "X has been stalled N days, want me to chase Respiratory?"
      -> user: "yes" -> bot returns the drafted escalation text.
C5. STRETCH: ElevenLabs voice note of the escalation as a WhatsApp audio reply.
Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
SUPABASE_URL, SUPABASE_SERVICE_KEY. Add to .env.example.

## WORKSTREAM D — private routing / escape hatch (OPTIONAL, additive)
Start only after the core (A+B) works. This is the "route around the bottleneck"
output and the strongest business-viability story. Positioning rules are load- bearing — read them.
D1. Coverage input, two paths:
    (a) Manual: a small form / field where the user picks a plan_type and toggles covers_diagnostics / covers_consults. Deterministic, always works.
    (b) Reuse the extractor: user uploads a policy doc -> extractLetter with a
        SECOND schema+prompt returning Coverage. Reuse ALL existing extract infra;
        just branch on a `mode: "policy"` flag in the extract input.
D2. Provider directory fixture: NEW file lib/pipeline/providers.ts exporting
    PrivateProvider[] — 3-4 realistic-but-fake clinics keyed by invType + specialty + region. Do NOT pretend it is a real national feed.
D3. Coverage match (deterministic): NEW lib/pipeline/coverage.ts.
    escapeHatch(stall: Stall, coverage: Coverage): EscapeHatch | null
- Trigger ONLY for the single stalled bottleneck node.
- coverable = node.invType is a discrete diagnostic/consult type AND (covers_diagnostics || covers_consults) AND not obviously excluded.
    - CRITICAL REALISM: UK PMI usually EXCLUDES chronic-disease management, so the jak inhibitor/approval node is NEVER offered privately — only a discrete diagnostic bottleneck (ct/mri/bronchoscopy/consult) is. Encode this.
- reason + caveats spell out: covers the diagnostic step, not the chronic treatment; pre-auth/GP referral may be required; coverage is indicative.
D4. Second draft: extend the drafter with a target that produces the private-route message — either a pre-auth request to the insurer OR a note to the NHS team that this step is being obtained privately with the report returned. Reuse the same voice constraints; still ADMINISTRATIVE, still no clinical claim.
D5. UI: an "Escape hatch" card beside the escalation showing the coverable node, the reason, provider options (indicative wait + price), the caveats, and the second draft. FRAMING: options not directions. Never "you should see Dr X." Show the indicative/policy-dependent disclaimer inline.

## CONSTRAINTS
- LLM extracts + drafts only; all graph/stall/coverage logic is deterministic.
- Never emit clinical advice. Escalations AND private suggestions are framed as administrative options; coverage is indicative and policy-dependent.
- Web (in-memory) is the reliable demo; WhatsApp/Supabase/private-routing are additive and independently cuttable.
- `npm run typecheck` must pass clean before "done."

## BUILD ORDER (what blocks what)
0. Together: lock lib/pipeline/types.ts (the shared contract, incl. Coverage).
1. Parallel: A does A1->A2->A3->A4->A5; B does B1 (feeds A5) then B2.
2. Merge: wire /api/graph -> UI, one real end-to-end run (A6 + B2).
3. If ahead: pick ONE of Workstream C or Workstream D (see cut order). Do not attempt to polish both.
4. Freeze features; rehearse the demo twice.

## CUT ORDER IF BEHIND (cut top-first)
1. ElevenLabs voice (C5)
2. WhatsApp + Supabase (Workstream C)   [drop first if judging leans "business viability"]
3. Private routing (Workstream D)       [drop first if judging leans "live-demo flash"]
4. Policy-doc extraction (D1b) -> keep manual coverage toggle (D1a)
5. Graph-viz polish -> keep the vertical list
6. Live extraction of arbitrary uploads -> lean on fixtures, keep ONE live run
NEVER CUT: graph builder + stall detector + one drafted escalation.

## RISKY — flag and guard
- Cross-letter edge assembly (A2) is the hardest, most bug-prone logic — that's why A5 tests it against B1 fixtures. Do it before any UI.
- The sampleId path (extractor.ts:127) bypasses live extraction; keep it for reliability but demonstrate one genuinely-live extraction.
- Runware json_object only works on the OpenAI model, not Gemini — do not switch models. Do not send max_tokens.
- pdf-parse inner-module import in lib/pdf.ts is intentional; don't change it.
- Twilio proactive messages are only free-form within 24h of the user's last message — fine for the demo, don't design a flow that messages cold.
- Workstream D positioning: only ever offer a DISCRETE DIAGNOSTIC node privately, never the chronic treatment; PMI typically excludes chronic care. Getting this wrong is both a credibility miss and an ethics miss. Options, not directions.
