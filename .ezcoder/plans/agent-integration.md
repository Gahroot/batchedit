# BatchEdit Agent Integration — End-to-End Plan

Embed an autonomous LLM agent into BatchEdit that takes raw footage and drives the full pipeline (split → verify → bucket → template → captions → render) without human input on the routine steps. Built on `@prestyj/ai` + `@prestyj/agent` from `/Users/groot/ezcoder`. No reinvention of the agent loop, streaming, retry, tool execution, or compaction — that already exists and is published to npm.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                                │
│  ┌────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ Existing   │  │ NEW AgentPanel   │  │ Existing            │  │
│  │ Buckets    │  │ • event log      │  │ Whisper Worker      │  │
│  │ Settings   │  │ • plan preview   │  │ (stays in renderer) │  │
│  │ Render     │  │ • approve/cancel │  │                     │  │
│  └────────────┘  └──────────────────┘  └─────────────────────┘  │
│         ▲                  ▲                       ▲             │
│         │ store mutations  │ events                │ transcribe  │
│         │ (from main)      │ (from main)           │ (from main) │
└─────────┼──────────────────┼───────────────────────┼─────────────┘
          │                  │                       │
          ▼                  │                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Main process — NEW src/main/agent/                              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ AgentService — wraps @prestyj/agent Agent class         │    │
│  │ • holds Agent instance + signal + job ledger            │    │
│  │ • streams events to renderer via webContents.send()     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Tools (Zod-validated)                                   │    │
│  │  • ingestSource, transcribeClip, detectMarkers,         │    │
│  │    proposeSplits, splitClip, verifyClipBoundaries,      │    │
│  │    extractFrames, analyzeShot, pickTemplate,            │    │
│  │    setCaptionStyle, planRenderQueue,                    │    │
│  │    startRenderJob, getRenderStatus,                     │    │
│  │    addClipToBucket, applyStoreAction                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  Existing main code:                                             │
│  ffmpeg.ts · render-pipeline.ts · safe-zones.ts · marker det.    │
└──────────────────────────────────────────────────────────────────┘
```

### Process placement (rationale)

- **Agent runs in main.** It needs ffmpeg, fs, child_process, and durable job state. The renderer would be a hostile environment (sandbox, no fs, GC pressure from large clip arrays).
- **Whisper stays in renderer.** Already working, GPU-accelerated via `@huggingface/transformers` + WebGPU. Rewriting in main with whisper.cpp is a separate project. Main reaches into the renderer for transcription via an inverse-IPC RPC channel (see §3).
- **Marker detection moves to a shared location.** Currently in `src/renderer/src/lib/marker-detection.ts`. Move to `src/shared/marker-detection.ts` (new dir) so both main and renderer import the same code.

---

## 2. Dependencies

Add to `package.json`:

```jsonc
{
  "dependencies": {
    "@prestyj/ai": "^4.3.200",
    "@prestyj/agent": "^4.3.200",
    "zod": "^4.4.3"
  }
}
```

Both packages are pure ESM. `electron-vite` already supports ESM externals; verify `@prestyj/*` are listed in `external` in `electron.vite.config.ts` so they are not bundled (Anthropic SDK + OpenAI SDK both ship CJS internals).

API key sourcing (in order): `ANTHROPIC_API_KEY` env → user-supplied via `geminiApiKey`-style settings field (rename to `aiApiKey`, keep gemini key separate) → OS keychain (out of scope for v1).

---

## 3. Inverse-IPC: main → renderer transcription

The agent needs to call whisper, which lives in the renderer. Pattern:

`src/main/agent/renderer-rpc.ts`:

```ts
// Main side. Tracks pending requests by id.
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function callRenderer<T>(win: BrowserWindow, channel: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const id = uuidv4();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    signal?.addEventListener("abort", () => {
      pending.delete(id);
      win.webContents.send(`${channel}:cancel`, { id });
      reject(new Error("aborted"));
    });
    win.webContents.send(channel, { id, payload });
  });
}

// register ipcMain.on(`${channel}:reply`, …) to resolve from id
```

Renderer side (`src/renderer/src/agent-bridge.tsx`): listens for `agent:transcribe`, runs the existing `useWhisper` pipeline, posts `agent:transcribe:reply` with `{ id, result }`. Mounted once at App root.

This is the only inverse channel needed. Everything else (store mutations) uses the same channel — main sends `agent:applyAction { type, payload }`, renderer applies to Zustand, no reply needed.

---

## 4. Tool surface (the agent's API)

Every tool: Zod-typed args, structured return, side-effect log line. Defined in `src/main/agent/tools/`.

### Discovery / ingestion

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `ingestSource` | `{ paths: string[] }` | `{ sources: [{id, path, duration, fps, hasAudio}] }` | ffprobe metadata for every input clip |
| `extractFrames` | `{ path, timestamps: number[] }` | `{ frames: [{t, dataUrl, width, height}] }` | ffmpeg `-ss` per frame; PNG → base64 |

### Transcription / segmentation

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `transcribeClip` | `{ path, model?: string }` | `{ words: WordChunk[], full: string, srtPath: string }` | Round-trips to renderer whisper. Caches by `sha1(path)+model` in `app.getPath('userData')/transcripts/` |
| `detectMarkers` | `{ words: WordChunk[] }` | `{ markers: DetectedMarker[] }` | Shared `marker-detection.ts`. No file I/O. |
| `proposeSplits` | `{ markers, audioPath, fullDuration }` | `{ splits: [{bucket, label, start, end, confidence}] }` | Snaps boundaries to nearest word-gap using VAD silence intervals. Confidence drops when boundary lands inside a word. |

### Splitting + verification (the meat of this plan)

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `splitClip` | `{ sourcePath, segments[], outDir }` | `{ clips: [{label, bucket, path, duration}] }` | Wraps existing `ffmpeg:splitVideo` IPC. Each segment exports clip + `.srt` of its sliced words. |
| `verifyClipBoundaries` | `{ clipPath, expectedSection: "hook"\|"meat"\|"cta", parentWords?: WordChunk[], windowMs?: number }` | `{ clean: bool, leadingLeak: Leak\|null, trailingLeak: Leak\|null, transcript: WordChunk[], confidence: number }` | **The contamination check.** Either re-transcribes the short clip OR slices parent transcript. Runs `detectMarkers` with a lower threshold over first/last `windowMs` (default 1500). Returns `suggestedTrimMs` per leak. |
| `recutClip` | `{ clipPath, sourcePath, startMs, endMs }` | `{ outputPath, duration }` | Re-runs `trimVideoReencode` with adjusted boundaries. Capped at 2 retries per clip — agent must give up and surface after that. |
| `verifySrtAlignment` | `{ clipPath, srtPath }` | `{ aligned: bool, drift: number, mismatches: [...] }` | Re-transcribes the split clip and diffs against the sliced parent SRT word-by-word (Levenshtein). Catches Whisper boundary corruption that pure timestamp-checking misses. Optional — only run on clips flagged risky by `verifyClipBoundaries`. |

`Leak` shape:
```ts
type Leak = {
  marker: string;            // "hook", "meat 2", etc.
  matchedTokens: string[];   // raw words that triggered
  confidence: number;        // 0–1
  suggestedTrimMs: number;   // signed; positive = trim from this side
}
```

### Template / styling

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `analyzeShot` | `{ path, samples?: number }` | `{ shots: [{t, shotType, faceBox?, faceConfidence, framingChange}] }` | Three frames at 1s/mid/end-1s by default. **Primary path: ffmpeg `facedetect` filter** (OpenCV-backed, local, free). Returns bbox per frame. **Fallback: vision model** (Anthropic `claude-3-5-sonnet` with image content) only when `facedetect` finds nothing across all samples. Classifies into `talking-head` / `full-body` / `selfie` / `lower-third` / `wide` deterministically from bbox height ratio + position. |
| `pickTemplate` | `{ shots: ShotAnalysis[], platform: Platform }` | `{ template: { captionsXY, mediaXY, titleXY }, reasoning }` | Pure deterministic. Inputs face bbox + safe zones → outputs `templateLayout`. Caption Y = `faceBox.bottom + padding`. Media goes to largest safe-zone rectangle not intersecting face. No vision call here. |
| `setCaptionStyle` | `{ preset: keyof CAPTION_PRESETS }` or full `CaptionStyle` | `{ ok: true }` | Dispatches `applyStoreAction({type:"setCaptionStyle", …})`. Agent picks preset from shot analysis (e.g. selfie+TikTok → `tiktok-glow`). |
| `setTemplateLayout` | `TemplateLayout` | `{ ok: true }` | Same. |
| `setTargetPlatform` | `Platform` | `{ ok: true }` | Same. |

### Bucket / store actions

| Tool | Args | Returns |
|---|---|---|
| `addClipToBucket` | `{ bucket, clip: {path, name, duration, thumbnail?, transcript?} }` | `{ id }` |
| `removeClip` | `{ bucket, id }` | `{ ok }` |
| `reorderBucket` | `{ bucket, ids: string[] }` | `{ ok }` |
| `setHookText` | `{ clipId, text }` | `{ ok }` |
| `getStoreSnapshot` | `{}` | `AppState` (read-only) | Lets agent inspect current buckets / settings before deciding next step |

### Render

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `validateRenderPlan` | `{}` | `{ count, totalDurationSec, estDiskGb, warnings: [...] }` | Pure. Reads store snapshot. Catches "4096 permutations / 380GB" before agent calls render. |
| `startRenderJob` | `{ dryRun?: boolean }` | `{ jobId }` | Wraps `renderBatch` IPC. **Requires human approval gate** — see §6. |
| `getRenderStatus` | `{ jobId }` | `{ phase, percent, currentClip, errors[] }` | Reads from `RenderProgress[]` ledger. |
| `getRenderLog` | `{ jobId, since?: number }` | `{ events: [...] }` | Stream of render events since cursor. |
| `cancelRender` | `{ jobId? }` | `{ ok }` | Existing IPC. |

### Reasoning aids

| Tool | Args | Returns |
|---|---|---|
| `logProgress` | `{ phase, message, data? }` | `{ ok }` | Pure logging tool — appears in the AgentPanel timeline. Helps with observability + agent self-narration. |
| `requestHumanReview` | `{ reason, attach: {clipPath?, frames?, transcript?} }` | `{ approved: bool, edits?: {...} }` | Pauses agent, surfaces a modal in renderer, blocks tool result until user acts. Maps to a Promise resolved by an IPC reply. |

---

## 5. Agent system prompt + workflow

System prompt template (in `src/main/agent/system-prompt.ts`):

```
You are the BatchEdit pipeline agent. You take a raw screen-recording of an
ad creator delivering numbered marker phrases ("Hook 1", "Meat 2", "CTA 3")
and produce a fully-prepared render queue.

Workflow:
1. ingestSource → transcribeClip → detectMarkers → proposeSplits
2. For each proposed split: extractFrames (sample 3) → analyzeShot
3. splitClip (commit) → verifyClipBoundaries on every output
   - If leak: recutClip with suggestedTrimMs, re-verify (max 2 retries)
   - If still dirty: requestHumanReview with the offending clip
4. addClipToBucket for each clean clip
5. analyzeShot across all hooks → pickTemplate → setTemplateLayout +
   setCaptionStyle + setTargetPlatform
6. validateRenderPlan → if warnings, logProgress; if catastrophic, requestHumanReview
7. requestHumanReview { reason: "ready_to_render" } — DO NOT call startRenderJob
   without explicit approval
8. After approval: startRenderJob → poll getRenderStatus until done
9. logProgress { phase: "complete" }

Rules:
- Never call startRenderJob without an approved requestHumanReview immediately
  prior in the conversation.
- Never recut a clip more than 2 times.
- Use deterministic tools (pickTemplate, marker detection) before falling
  back to vision (analyzeShot fallback).
- Report contamination findings via logProgress even when auto-fixed.
```

Recommended model: `claude-sonnet-4-5` (vision + tool use; the existing `@prestyj/ai` already supports it). For shot analysis, vision fallback uses the same model.

`maxTurns: 80`, `thinking: "medium"`, `maxToolResultChars: 24000`.

---

## 6. Human-in-the-loop gates

Three points where the agent **must** pause for a human:

1. **Render approval** (always). `requestHumanReview` before `startRenderJob`.
2. **Persistent boundary contamination** (after 2 failed recuts on the same clip). Agent surfaces the clip + transcript; user accepts as-is, edits boundaries manually, or skips.
3. **Template ambiguity** (vision fallback returned low confidence). User picks from suggested templates.

Mechanism: `requestHumanReview` posts an event to renderer, renderer mounts an `AgentReviewModal`, user response goes back to main via `agent:reviewReply` IPC. Main resolves the tool's pending Promise.

Renderer `AgentReviewModal` reuses existing dialog primitives (`@/components/ui/dialog`).

---

## 7. UI surface (renderer)

New file: `src/renderer/src/components/AgentPanel.tsx`. Mounted as a collapsible right rail in `App.tsx` (next to RenderPanel).

Sections:

- **Header**: "Run Agent" button (file picker for raw recording) · provider+model selector · cancel button (calls `agent:cancel`)
- **Event timeline**: scrollable log of `tool_call_start`, `tool_call_end`, `text_delta`, `logProgress` payloads. Same dual-nature `AgentStream` consumed via an EventSource-style hook (`useAgentEvents`).
- **Plan preview** (when agent emits `logProgress { phase: "plan" }`): shows proposed splits with confidence bars, contamination warnings, picked template
- **Review modals**: rendered from `requestHumanReview` events
- **Cost / usage footer**: `totalUsage` from `agent_done` event → tokens + estimated $

State: new slice in `store.ts`:

```ts
agentRunning: boolean
agentEvents: AgentEvent[]                 // capped at 500, ring buffer
agentReviewPrompt: ReviewPrompt | null
appendAgentEvent: (e: AgentEvent) => void
setAgentReviewPrompt: (p: ReviewPrompt | null) => void
respondToReview: (r: ReviewResponse) => void
```

A new hook `useAgentEvents()` subscribes to `window.api.onAgentEvent(cb)` (added to preload) and pushes into the slice.

---

## 8. Preload additions

Append to `src/preload/index.ts` + `src/preload/index.d.ts`:

```ts
// agent control
agent: {
  start: (opts: { sourcePath: string; provider?: string; model?: string; apiKey?: string }) => Promise<{ runId: string }>;
  cancel: (runId: string) => Promise<void>;
  respondToReview: (reviewId: string, response: { approved: boolean; edits?: unknown }) => Promise<void>;
  onEvent: (cb: (evt: AgentUiEvent) => void) => () => void;
}
// inverse-IPC transcription channel (renderer side handles it; preload only forwards)
agentBridge: {
  onTranscribeRequest: (cb: (req: { id: string; payload: { path: string; model?: string } }) => void) => () => void;
  replyTranscribe: (id: string, result: { words: WordChunk[] } | { error: string }) => void;
}
```

`AgentUiEvent` is a renderer-safe view of `AgentEvent` (strip non-clonable fields).

---

## 9. File layout (new files)

```
src/
├── shared/                                  # NEW — code shared main↔renderer
│   ├── marker-detection.ts                  # MOVED from renderer/src/lib/
│   └── types.ts                             # WordChunk, DetectedMarker, etc.
│
├── main/
│   ├── agent/
│   │   ├── service.ts                       # AgentService class
│   │   ├── system-prompt.ts
│   │   ├── renderer-rpc.ts                  # inverse-IPC helpers
│   │   ├── ipc.ts                           # agent:start, agent:cancel, etc.
│   │   ├── transcript-cache.ts              # sha1-keyed persistence
│   │   ├── job-ledger.ts                    # render job tracking for getRenderStatus
│   │   ├── facedetect.ts                    # ffmpeg facedetect wrapper
│   │   ├── vision-fallback.ts               # @prestyj/ai image content call
│   │   └── tools/
│   │       ├── index.ts                     # exports buildTools(ctx): AgentTool[]
│   │       ├── ingest.ts
│   │       ├── transcribe.ts
│   │       ├── markers.ts
│   │       ├── splits.ts
│   │       ├── verify.ts
│   │       ├── frames.ts
│   │       ├── analyze-shot.ts
│   │       ├── pick-template.ts
│   │       ├── store-actions.ts
│   │       ├── render.ts
│   │       └── review.ts
│   └── (existing files unchanged except tiny exports for tools to call)
│
├── preload/
│   └── (additions above)
│
└── renderer/src/
    ├── components/
    │   ├── AgentPanel.tsx                   # NEW
    │   └── AgentReviewModal.tsx             # NEW
    ├── hooks/
    │   ├── useAgentEvents.ts                # NEW
    │   └── useAgentTranscribeBridge.ts      # NEW (services inverse-IPC)
    └── (store.ts: append agent slice)
```

---

## 10. Verification strategies (the bells and whistles, concrete)

### A. Boundary contamination check (`verifyClipBoundaries`)

```
1. Get transcript for the split clip:
   - Cheap path: slice parentWords by [clipStartInParent, clipEndInParent]
   - Strict path: re-transcribe via transcribeClip (only when confidence
     low or verifySrtAlignment requested)

2. Window A = words whose start < windowMs (default 1500ms)
   Window B = words whose end > (duration - windowMs)

3. Run detectMarkers over Window A and Window B independently, with a
   relaxed threshold (lower than the splitter's threshold — false positives
   are cheap, false negatives are expensive)

4. For each hit:
   - In Window A → leadingLeak with suggestedTrimMs = markerEndMs + 80ms
   - In Window B → trailingLeak with suggestedTrimMs = (duration - markerStartMs) + 80ms

5. confidence = product of:
   - distance from boundary (closer = higher)
   - marker phrase match score
   - silence gap presence around the marker
```

### B. SRT alignment double-check (`verifySrtAlignment`)

```
1. Re-transcribe the split clip → freshWords
2. Sliced parent words → expectedWords
3. Token-level Needleman-Wunsch alignment
4. Report:
   - aligned = (mismatches/totalWords < 0.05)
   - drift = mean signed offset between matched word timestamps (ms)
   - mismatches = [{expectedWord, freshWord, position}]
```

Only triggered on clips that `verifyClipBoundaries` marked `confidence < 0.85` — avoids re-transcribing every clip.

### C. Auto-recut policy

```
verifyClipBoundaries → leak detected:
  attempts = 0
  while leak && attempts < 2:
    newStart = clipStart + (leadingLeak?.suggestedTrimMs ?? 0)
    newEnd   = clipEnd   - (trailingLeak?.suggestedTrimMs ?? 0)
    recutClip(newStart, newEnd)
    re-verify
    attempts++
  if still leak: requestHumanReview
```

### D. Shot analysis pipeline

```
analyzeShot(path):
  frames = extractFrames(path, [1.0, duration/2, duration-1.0])
  for each frame:
    bbox = ffmpegFacedetect(framePath)
    if bbox:
      shotType = classify(bbox)  // pure function on height ratio + center
    else:
      shotType = null
  if all shotType === null:
    // vision fallback
    response = aiStream({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [
        { type: "text", text: SHOT_CLASSIFY_PROMPT },
        ...frames.map(f => ({ type: "image", source: { type: "base64", data: f.dataUrl, media_type: "image/png" } }))
      ]}]
    })
    parse JSON response into shots
  return { shots, framingChange: shots not all same shotType }
```

Classification rules (pure):
- bbox.height > 0.4 and bbox.top > 0.05 → `talking-head`
- bbox.height > 0.6 → `selfie`
- bbox.height < 0.2 → `full-body`
- bbox.center.y > 0.6 → `lower-third`
- no face but motion across frames → `wide`

### E. Template selection (`pickTemplate`)

Deterministic. Inputs: shot analysis + target platform's `PLATFORM_SAFE_ZONES`.

```
1. Find face bbox union across samples (or use last bbox if framingChange)
2. captionRect = safeZone clipped to {
     y: faceUnion.bottom + 0.04,   // padding below chin
     height: 0.1,
     x: 0.1, width: 0.8
   }
3. If captionRect overflows safe zone → fall back to platform default
   `getElementPlacement(platform, 'caption')`
4. mediaRect = largest sub-rect of safe zone not intersecting faceUnion
   and not intersecting captionRect (greedy grid scan, 6x10)
5. Map to store TemplateLayout (x/y as percentages, matching existing schema)
6. Pick CaptionStyle:
   - selfie + tiktok → tiktok-glow
   - talking-head + universal → hormozi-bold
   - lower-third → bold-clean
   - full-body → reels-clean
   (table; not LLM call)
```

### F. Fire-and-forget render

```
startRenderJob → registers in JobLedger with id, returns immediately
Agent polls getRenderStatus every ~5s (sleep tool not needed — just
let the agent loop naturally; the tool result includes a "doneness"
field so the agent knows when to stop polling)
getRenderStatus returns { phase, percent, currentClip, errors[], done }
If errors[] non-empty: agent decides retry/skip/surface based on error class
```

---

## 11. Testing

Co-located vitest tests (mirrors existing convention):

- `src/shared/marker-detection.test.ts` — existing, just move
- `src/main/agent/tools/verify.test.ts` — leak detection, recut policy (mock ffmpeg)
- `src/main/agent/tools/pick-template.test.ts` — pure function, table-driven
- `src/main/agent/tools/analyze-shot.test.ts` — classify-from-bbox edge cases
- `src/main/agent/service.test.ts` — mock `@prestyj/agent`, verify tool wiring + event forwarding
- `src/renderer/src/components/AgentPanel.test.ts` — RTL, event timeline rendering
- `src/renderer/src/hooks/useAgentEvents.test.ts`

End-to-end smoke (manual): one 60s sample recording in `resources/test-fixtures/`, agent run produces buckets without intervention. Not in CI (ffmpeg + whisper + LLM call too heavy).

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinates clip paths | Tool validation: `path` arg must be one previously returned by `ingestSource`/`splitClip`. Maintain allowlist in `AgentService`. |
| Whisper bridge deadlock (renderer reload mid-call) | RPC timeout (60s), abort signal forwarded to renderer worker, agent sees error and retries |
| Agent renders without approval | `startRenderJob` tool checks ledger for an `approved` review within last N turns; throws if absent. Belt + suspenders. |
| Token cost runaway | `maxTurns: 80`, `maxToolResultChars: 24000`, transcript cache prevents re-transcribing |
| `facedetect` filter unavailable in bundled ffmpeg | Probe at `setupFFmpeg`; if missing, log warning and always use vision fallback. Document in README. |
| Inverse-IPC race when multiple agents (future) | Out of scope v1 — enforce single concurrent agent run at AgentService level |

---

## 13. Future (post-v1, not in this plan)

- Move whisper to main via whisper.cpp binary — eliminates inverse-IPC
- Multi-agent (multiple recordings in parallel) via `@prestyj/boss` orchestrator
- Persistent agent sessions (`priorMessages`) for resumable runs
- Voice "hey BatchEdit" trigger via `@prestyj/voice` package

---

## Steps

1. Add `@prestyj/ai`, `@prestyj/agent`, `zod` to `package.json`; mark as ESM externals in `electron.vite.config.ts`; run `npm install`.
2. Create `src/shared/` and move `src/renderer/src/lib/marker-detection.ts` → `src/shared/marker-detection.ts`; update both renderer and (new) main imports; verify `npm test` passes.
3. Create `src/shared/types.ts` with `WordChunk`, `DetectedMarker`, `ShotAnalysis`, `Leak`, `TemplateLayout` (re-exported by store); remove duplicates.
4. Create `src/main/agent/renderer-rpc.ts` implementing `callRenderer<T>` with id-based pending map, abort signal forwarding, and `:reply`/`:cancel` channel suffixes.
5. Create `src/main/agent/transcript-cache.ts` (sha1-of-(path+model) → JSON file in `app.getPath('userData')/transcripts/`).
6. Create `src/main/agent/job-ledger.ts` exposing `register(jobId)`, `update(jobId, progress)`, `get(jobId)`, `getLog(jobId, since)` backed by an in-memory map fed from existing render progress events.
7. Create `src/main/agent/facedetect.ts` wrapping ffmpeg `-vf facedetect` over a single frame, parsing stderr bbox output into `{ x, y, w, h, confidence }`.
8. Create `src/main/agent/vision-fallback.ts` calling `@prestyj/ai`'s `stream()` with image content; JSON-mode prompt for shot classification.
9. Create `src/main/agent/tools/ingest.ts` — `ingestSource` tool using existing `getVideoMetadata` from `ffmpeg.ts`.
10. Create `src/main/agent/tools/frames.ts` — `extractFrames` tool shelling out to ffmpeg `-ss N -frames:v 1` per timestamp; return base64 PNGs.
11. Create `src/main/agent/tools/transcribe.ts` — `transcribeClip` calling `callRenderer('agent:transcribe', …)`; check transcript-cache first.
12. Create `src/main/agent/tools/markers.ts` — `detectMarkers` and `proposeSplits` using shared marker-detection.
13. Create `src/main/agent/tools/splits.ts` — `splitClip` and `recutClip` invoking existing `ffmpeg:splitVideo` / `trimVideoReencode` handlers directly (not via ipcMain.invoke; import the underlying functions).
14. Create `src/main/agent/tools/verify.ts` — `verifyClipBoundaries` (window-scan + relaxed marker detection) and `verifySrtAlignment` (Needleman-Wunsch token diff).
15. Create `src/main/agent/tools/analyze-shot.ts` — orchestrate `extractFrames` → `facedetect` → fallback `vision-fallback` → bbox-based classifier.
16. Create `src/main/agent/tools/pick-template.ts` — pure deterministic placement using `safe-zones.ts` helpers + caption-preset lookup table.
17. Create `src/main/agent/tools/store-actions.ts` — `addClipToBucket`, `removeClip`, `reorderBucket`, `setHookText`, `setCaptionStyle`, `setTemplateLayout`, `setTargetPlatform`, `getStoreSnapshot` all dispatching `webContents.send('agent:applyAction', …)` and (for `getStoreSnapshot`) round-tripping via `callRenderer`.
18. Create `src/main/agent/tools/render.ts` — `validateRenderPlan`, `startRenderJob` (with approval-ledger check), `getRenderStatus`, `getRenderLog`, `cancelRender`.
19. Create `src/main/agent/tools/review.ts` — `requestHumanReview` and `logProgress`; review resolves via `agent:reviewReply` IPC.
20. Create `src/main/agent/tools/index.ts` exporting `buildTools(ctx: ToolContext): AgentTool[]` that wires every tool with shared context (BrowserWindow ref, allowlist, approval ledger).
21. Create `src/main/agent/system-prompt.ts` exporting `buildSystemPrompt()` per the prompt in §5.
22. Create `src/main/agent/service.ts` — `AgentService` class: `start(opts)` constructs `Agent` from `@prestyj/agent`, streams events to renderer via `webContents.send('agent:event', …)`, manages run lifecycle, enforces single concurrent run.
23. Create `src/main/agent/ipc.ts` registering `agent:start`, `agent:cancel`, `agent:reviewReply`, `agent:applyAction:reply` handlers.
24. Wire `setupAgent()` call into `src/main/index.ts` after `setupRenderPipeline()`.
25. Update `src/preload/index.ts` to expose `window.api.agent.*` and `window.api.agentBridge.*`; update `src/preload/index.d.ts` with matching types.
26. Append agent slice (`agentRunning`, `agentEvents`, `agentReviewPrompt`, actions) to `src/renderer/src/store.ts`.
27. Create `src/renderer/src/hooks/useAgentEvents.ts` subscribing via `window.api.agent.onEvent` and pushing into store.
28. Create `src/renderer/src/hooks/useAgentTranscribeBridge.ts` — listens on `agentBridge.onTranscribeRequest`, runs existing `useWhisper` transcription, calls `replyTranscribe`.
29. Create `src/renderer/src/components/AgentReviewModal.tsx` using existing Dialog primitives; pulls prompt from store, dispatches `respondToReview`.
30. Create `src/renderer/src/components/AgentPanel.tsx` — collapsible right-rail panel: file picker, Run/Cancel buttons, event timeline, plan preview, usage footer.
31. Mount `<AgentPanel />`, `<AgentReviewModal />`, and the transcribe-bridge hook in `src/renderer/src/App.tsx`.
32. Write tests: `marker-detection.test.ts` (already exists, just verify after move), `verify.test.ts`, `pick-template.test.ts`, `analyze-shot.test.ts`, `service.test.ts`, `useAgentEvents.test.ts`, `AgentPanel.test.ts`.
33. Run full verification: `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm test -- --config vitest.config.main.ts`. Fix all failures.
34. Manual smoke test: place a sample marker-annotated recording in `resources/test-fixtures/sample-raw.mp4`, run `npm run dev`, click "Run Agent", verify buckets populate, template is picked, render approval modal appears, render completes.
