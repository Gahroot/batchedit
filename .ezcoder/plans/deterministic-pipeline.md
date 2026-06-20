# Plan: Deterministic Split+QA Pipeline

## Context

The agent runs a full LLM-driven 10-step pipeline (Gemini Flash, up to 80 turns) for what is essentially a deterministic workflow: upload → transcribe → detect markers → split → verify boundaries → push to buckets → render. The LLM mostly follows a fixed recipe from the system prompt. The real value the user wants from the agent is **boundary QA** — verifying split clip edges don't contain marker contamination.

The `ClipSplitter` dialog already handles upload → transcribe → detect markers → review → split → push to buckets. It's missing only the boundary QA step. The boundary QA code (`boundary-qa.ts`, `verify.ts`, `splits.ts`) is fully deterministic but coupled to `ToolContextState` (agent-specific context).

**Goal:** Wire boundary QA into the ClipSplitter as a deterministic IPC pipeline, so the user flow becomes: upload → transcribe → detect → split → **auto-QA** → approve/recut → push to buckets. No LLM needed for the core flow.

## Architecture

### Current flow
```
ClipSplitter (deterministic): upload → transcribe → detect → review markers → split → push to buckets
Agent (LLM): ingest → transcribe → detect → split+QA → add to buckets → template → render
```

### Target flow
```
ClipSplitter (deterministic): upload → transcribe → detect → review markers → split → boundary QA → recut flagged → push to buckets
Agent (optional): same as before, for power users
```

## Changes

### 1. Extract standalone QA module (`src/main/qa-pipeline.ts`)

Decouple boundary QA from `ToolContextState`. Create a pure orchestration function that:
- Takes: `win` (BrowserWindow), `sourcePath`, `clips[]`, options
- Uses `callRenderer` for transcription (reuses existing `renderer-rpc.ts` + `agent:transcribe` channel)
- Uses `verifyClipBoundaryState` for leak detection
- Uses `recutSourceClip` for auto-recuts
- Returns: `BoundaryQaReport` (same type as agent uses)

The key insight: `verifyClipBoundaryState` and `recutSourceClip` only need FFmpeg (main process) and Whisper (renderer). The allowlist checks are agent-specific security that we skip for the user-initiated flow.

Extract the core logic from `boundary-qa.ts` `qaSingleClip` into a function that accepts a `transcribe(path)` callback instead of `ToolContextState`.

### 2. Add IPC handlers (`src/main/qa-ipc.ts`)

Two new handlers:
- `qa:runBoundaryQA` — runs the full QA loop across all split clips, returns `BoundaryQaReport`
- `qa:recutClip` — applies a manual nudge (±delta ms) to a single clip, re-verifies, returns updated `ClipQaResult`

These reuse the extracted QA module and the existing renderer RPC for transcription.

### 3. Register QA IPC in main process entry (`src/main/index.ts`)

Call `setupQaIpc(win)` alongside the existing `setupAgent(win)`.

### 4. Expose QA API in preload (`src/preload/index.ts` + `index.d.ts`)

Add to the `api` object:
```ts
qa: {
  runBoundaryQA: (params: {
    sourcePath: string
    clips: Array<{ label: string; bucket: string; path: string; sourceStart: number; sourceEnd: number; duration: number }>
    windowMs?: number
  }) => Promise<BoundaryQaReport>
  recutClip: (params: {
    clipPath: string; sourcePath: string; sourceStart: number; sourceEnd: number
    bucket: string; label: string; startDeltaMs: number; endDeltaMs: number
  }) => Promise<ClipQaResult>
}
```

### 5. Add QA step to ClipSplitter (`src/renderer/src/components/ClipSplitter.tsx`)

Extend the stepper from 5 to 6 steps: Upload → Transcribe → Review → Split → **QA** → Done.

After splitting completes:
1. Call `window.api.qa.runBoundaryQA(...)` with the split clip paths
2. Display QA results inline in the dialog (reuse the `QaRow` pattern from `QaPanel.tsx`)
3. Show per-clip status: clean ✓ / auto-fixed ⚠ / flagged ✗
4. For flagged clips: show nudge buttons (Start +100ms / End −100ms) and an Approve button
5. Nudge calls `window.api.qa.recutClip(...)` and updates the result
6. "Push to Buckets" only pushes clips that are clean, auto-fixed, or manually approved

State additions:
- `qaResults: ClipQaResult[]` — QA results from the IPC call
- `approvedClips: Set<string>` — clips the user manually approved
- `qaBusy: boolean` — loading state during QA

### 6. Reuse QaPanel UI pattern

Extract the `QaRow` component from `QaPanel.tsx` into a shared component (or inline the pattern in ClipSplitter). The existing QaRow already has:
- Status icon (ShieldCheck / Wrench / AlertTriangle)
- Leak summary text
- Nudge buttons (Start +100, End −100)
- Approve button

## Files to modify

| File | Change |
|---|---|
| `src/main/qa-pipeline.ts` | **New.** Standalone QA orchestration, decoupled from ToolContextState |
| `src/main/qa-ipc.ts` | **New.** IPC handlers `qa:runBoundaryQA` and `qa:recutClip` |
| `src/main/index.ts` | Register `setupQaIpc(win)` |
| `src/preload/index.ts` | Add `qa.runBoundaryQA` and `qa.recutClip` to API |
| `src/preload/index.d.ts` | Type the new `qa` API surface |
| `src/renderer/src/components/ClipSplitter.tsx` | Add QA step after split, show results, wire nudge/approve |
| `src/renderer/src/components/QaPanel.tsx` | Extract `QaRow` to shared component (or import from here) |

## Files NOT modified

- `src/main/agent/` — no changes; agent keeps working as before
- `src/main/agent/boundary-qa.ts` — no changes; agent still uses its own copy
- `src/renderer/src/components/AgentPanel.tsx` — no changes
- `src/renderer/src/store.ts` — no changes (QA state lives in ClipSplitter local state)

## Risks

1. **Transcription RPC race:** The QA step re-transcribes split clips via the same `agent:transcribe` channel. If the agent is running simultaneously, requests could interleave. Mitigation: the QA IPC handler uses its own `callRenderer` instance with unique IDs; the renderer bridge already handles concurrent requests via the ID-based reply system.

2. **Whisper model loading:** QA re-transcription requires the Whisper model. If the model isn't loaded yet (first use), there's a cold-start delay. Mitigation: the renderer bridge calls `loadModel()` idempotently before each transcription.

3. **Large clip counts:** A source with many markers (10+ clips) means 10+ re-transcriptions during QA. Each takes ~10-30s depending on clip length and model. Mitigation: clips are short (split from a larger recording), and the transcript cache avoids re-transcribing if the same path was already transcribed.

## Verification

1. **Typecheck:** `npm run typecheck` — ensure new IPC types align
2. **Lint:** `npm run lint` — Biome passes
3. **Tests:** `npm test` — existing tests pass
4. **Manual flow:**
   - Open ClipSplitter → upload a source recording with spoken markers
   - Verify transcription + marker detection works as before
   - After split, verify QA step runs automatically
   - Verify clean clips show ✓, auto-fixed show ⚠, flagged show ✗
   - Test nudge buttons on a flagged clip
   - Test "Push to Buckets" with mixed QA states
   - Verify agent still works independently via AgentPanel

## Steps

1. Create `src/main/qa-pipeline.ts` — extract `qaSingleClip` loop from `boundary-qa.ts` into a standalone function that accepts a `transcribeClip` callback and a `win` reference for events, removing the `ToolContextState` dependency
2. Create `src/main/qa-ipc.ts` — two IPC handlers (`qa:runBoundaryQA`, `qa:recutClip`) that wire the QA pipeline to the renderer's Whisper bridge via `callRenderer`
3. Register `setupQaIpc(win)` in `src/main/index.ts`
4. Add `qa` API surface to `src/preload/index.ts` and `src/preload/index.d.ts`
5. Extend `ClipSplitter.tsx` with a QA step: after splitting, call `qa:runBoundaryQA`, display results with status/nudge/approve UI, gate "Push to Buckets" on QA completion
6. Verify: `npm run typecheck && npm run lint && npm test`
