# Agent Pipeline Fixes: Transcript Flow + Output Directory

## Problem

The AI agent can ingest a video, transcribe it, detect markers, split it, add clips to buckets, analyze shots, pick a template, and request human review — but the final rendered output fails or is missing captions due to two broken data flows.

### Bug 1 — No transcript data reaches the renderer store

`transcribeClip` intentionally withholds word-level transcript from the LLM (to avoid blowing stream timeouts). But `addClipToBucket` never reads the transcript cache, so clips are added to buckets with `transcript: undefined`. The render bridge builds `clipWordChunks` from `combo.hook.transcript ?? []` — always empty — so no `captionData` is attached to render jobs. **Result: rendered videos have no captions.**

### Bug 2 — No output directory

The agent has no tool to set `settings.outputDirectory` (defaults to `null`). The system prompt never instructs it to. When `startRenderJob` fires, `buildAgentRenderJobs` throws *"Choose an output folder before starting agent render."* **Result: render fails immediately after human approval.**

## Fix 1: Attach transcript from cache in `addClipToBucket`

**File: `src/main/agent/tools/store-actions.ts`**

- Import `readTranscriptCache` from `../transcript-cache`
- In the `addClipToBucket` execute function, before sending the store action, call `readTranscriptCache(args.clip.path)` and attach `.words` to the clip's `transcript` field if the cache has a hit
- This is safe because boundary QA re-transcribes every split clip, so the cache always has an entry for the final clip path

```ts
// Inside addClipToBucket execute:
import { readTranscriptCache } from '../transcript-cache'

execute(args) {
  const id = uuidv4()
  let clip = { ...args.clip, id }
  // Attach transcript from cache so renderer captions work
  const cached = await readTranscriptCache(args.clip.path)
  if (cached?.words) clip = { ...clip, transcript: cached.words }
  sendStoreAction(ctx, 'addClipToBucket', { ...args, clip })
  return stringifyToolResult({ id })
}
```

Note: the execute function needs to become `async` (it currently is sync). The `executionMode: 'sequential'` already ensures ordering.

## Fix 2: Add `setOutputDirectory` agent tool + renderer bridge handler

### 2a. Renderer bridge — `src/renderer/src/hooks/useAgentStoreBridge.ts`

Add a `readSetOutputDirectoryPayload` function and a `'setOutputDirectory'` case to `applyAgentAction`:

```ts
function readSetOutputDirectoryPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  if (typeof payload.directory !== 'string' || !payload.directory) return null
  return payload.directory
}

// In applyAgentAction switch:
case 'setOutputDirectory': {
  const dir = readSetOutputDirectoryPayload(action.payload)
  if (dir) state.setOutputDirectory(dir)
  return
}
```

### 2b. Agent tool — `src/main/agent/tools/store-actions.ts`

Add a `setOutputDirectory` tool:

```ts
const setOutputDirectorySchema = z.object({
  directory: z.string().min(1)
})

// In createStoreActionTools, add:
{
  name: 'setOutputDirectory',
  description: 'Set the render output directory.',
  parameters: setOutputDirectorySchema,
  executionMode: 'sequential',
  execute(args) {
    sendStoreAction(ctx, 'setOutputDirectory', { directory: args.directory })
    return stringifyToolResult({ ok: true })
  }
}
```

### 2c. System prompt — `src/main/agent/system-prompt.ts`

Add output directory step before validation. The agent should use the same directory as the source file's parent, or a `batchedit-output` subdirectory:

Update workflow step 6 to:

```
6. setOutputDirectory — use the parent directory of the source file
7. validateRenderPlan → if warnings, logProgress; if catastrophic, requestHumanReview
8. requestHumanReview { reason: "ready_to_render" } — DO NOT call startRenderJob without explicit approval
9. After approval: startRenderJob → poll getRenderStatus until done
10. logProgress { phase: "complete" }
```

## Files Modified

| File | Change |
|------|--------|
| `src/main/agent/tools/store-actions.ts` | Add transcript cache read in `addClipToBucket`; add `setOutputDirectory` tool |
| `src/renderer/src/hooks/useAgentStoreBridge.ts` | Add `setOutputDirectory` case + payload reader |
| `src/main/agent/system-prompt.ts` | Add `setOutputDirectory` step to workflow |

## Verification

1. `npm run typecheck` — passes
2. `npm run lint` — passes
3. `npm test` — all 238 tests pass
4. `npm run test:main` — all 79 tests pass
