# Critical Path implementation memory

## Working objective

Pivot the app from a five-stage scalar state machine to a deterministic,
cross-department dependency graph. The demo oracle is an IBD pathway where a
Gastroenterology jak-inhibitor approval is waiting on Respiratory clearance,
which was expanded by an incidental TB-screening chest-X-ray finding into a
CT -> bronchoscopy -> repeat-CT chain.

## Initial repository findings

- The repo is the pre-pivot Pathway Copilot implementation: old `Extraction`,
  `runStateMachine`, linear milestone view, and state/draft client contracts.
- `lib/provider.ts` and `lib/pdf.ts` must remain unchanged.
- There is no existing agent memory file; this file is the running record.
- The supplied prompt is currently untracked and is treated as user-provided
  input, not as an implementation file to modify.

## Small-subtask checklist

- [x] Inspect prompt, git state, project structure, and existing conventions.
- [ ] Lock graph/extraction/stall/coverage types.
- [ ] Rewrite per-letter extraction normalization and sample fixtures.
- [ ] Implement deterministic graph construction and stall detection.
- [ ] Rewrite drafter facts/mock around `Stall`.
- [ ] Replace state API/client call with graph API/client call.
- [ ] Replace linear UI with a vertical dependency list.
- [ ] Add focused graph/stall verification.
- [ ] Run typecheck/build and record results.

## Decisions and invariants

- LLM calls only extract document facts or draft administrative prose.
- Graph edges, expected windows, stall selection, and any coverage decisions
  remain deterministic TypeScript.
- Dates are accepted only when explicitly present as ISO dates; missing dates
  remain `null`.
- The terminal goal is the `jak inhibitor approval` node and is never offered
  as a private escape hatch.

## Validation log

No implementation validation has run yet.
