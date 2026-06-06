import type { BoundaryQaReport, ClipQaResult, QaStatus } from '../../shared/types'
import { recutSourceClip, type SplitClipResult } from './tools/splits'
import type { ToolContextState } from './tools/types'
import { verifyClipBoundaryState } from './tools/verify'

/** Window (ms) at each clip edge scanned for marker contamination. */
const QA_WINDOW_MS = 1500

/** Hard cap on automatic recut attempts before escalating to human review. */
const MAX_AUTO_RECUTS = 2

/** Clips shorter than this after a proposed trim are escalated instead of recut. */
const MIN_CLIP_SEC = 0.5

export interface BoundaryQaOptions {
  /** Whisper model for re-transcription; undefined uses the renderer's configured model. */
  model?: string
  windowMs?: number
  maxRecuts?: number
}

interface ResolvedQaOptions {
  model: string | undefined
  windowMs: number
  maxRecuts: number
}

function emitEvent(ctx: ToolContextState, event: Record<string, unknown>): void {
  ctx.win.webContents.send('agent:event', { runId: ctx.runId, ...event })
}

/**
 * Apply the leak-suggested trims to the current source-relative bounds.
 * Leading leaks pull the start forward; trailing leaks pull the end back.
 */
function nextBounds(
  start: number,
  end: number,
  leadingTrimMs: number | null,
  trailingTrimMs: number | null
): { start: number; end: number } {
  const nextStart = leadingTrimMs !== null ? start + leadingTrimMs / 1000 : start
  const nextEnd = trailingTrimMs !== null ? end - trailingTrimMs / 1000 : end
  return { start: nextStart, end: nextEnd }
}

/**
 * Deterministic, mandatory boundary-QA loop for a single clip.
 * Re-transcribes the clip, detects marker contamination at either edge, and
 * auto-recuts from the original source until the clip is clean or the recut
 * budget is exhausted (then it is flagged for human review).
 */
async function qaSingleClip(
  ctx: ToolContextState,
  sourcePath: string,
  clip: SplitClipResult,
  options: ResolvedQaOptions,
  signal?: AbortSignal
): Promise<ClipQaResult> {
  let path = clip.path
  let start = clip.sourceStart
  let end = clip.sourceEnd
  let duration = clip.duration
  let recutCount = 0

  while (true) {
    const state = await verifyClipBoundaryState(
      ctx,
      path,
      clip.bucket,
      undefined,
      options.windowMs,
      options.model,
      signal
    )

    const base: Omit<ClipQaResult, 'status'> = {
      label: clip.label,
      bucket: clip.bucket,
      path,
      originalPath: clip.path,
      sourcePath,
      sourceStart: start,
      sourceEnd: end,
      duration,
      recutCount,
      confidence: state.confidence,
      leadingLeak: state.leadingLeak,
      trailingLeak: state.trailingLeak
    }

    if (state.clean) {
      const status: QaStatus = recutCount > 0 ? 'auto_fixed' : 'clean'
      return { ...base, status }
    }

    if (recutCount >= options.maxRecuts) {
      return { ...base, status: 'flagged' }
    }

    const bounds = nextBounds(
      start,
      end,
      state.leadingLeak?.suggestedTrimMs ?? null,
      state.trailingLeak?.suggestedTrimMs ?? null
    )

    // A trim that would collapse the clip below the minimum is not safe to
    // apply automatically — escalate the current state instead.
    if (bounds.end - bounds.start < MIN_CLIP_SEC) {
      return { ...base, status: 'flagged' }
    }

    const recut = await recutSourceClip(
      path,
      sourcePath,
      bounds.start * 1000,
      bounds.end * 1000,
      ctx
    )
    path = recut.outputPath
    duration = recut.duration
    start = bounds.start
    end = bounds.end
    recutCount += 1
  }
}

/**
 * Run the mandatory boundary-QA pass across every freshly split clip.
 * Emits `qa_started`, per-clip `qa_clip`, and `qa_complete` agent events so the
 * renderer QA panel can surface only the clips that still need a human.
 */
export async function runBoundaryQA(
  ctx: ToolContextState,
  sourcePath: string,
  clips: SplitClipResult[],
  options: BoundaryQaOptions = {},
  signal?: AbortSignal
): Promise<BoundaryQaReport> {
  // Note: this model is the Whisper transcription model, NOT ctx.model (Gemini).
  // Leaving it undefined makes the renderer fall back to its configured whisperModel.
  const resolved: ResolvedQaOptions = {
    model: options.model,
    windowMs: options.windowMs ?? QA_WINDOW_MS,
    maxRecuts: options.maxRecuts ?? MAX_AUTO_RECUTS
  }

  emitEvent(ctx, { type: 'qa_started', total: clips.length })

  const results: ClipQaResult[] = []
  for (const clip of clips) {
    const startedAt = Date.now()
    const result = await qaSingleClip(ctx, sourcePath, clip, resolved, signal)
    results.push(result)
    console.info('agent_boundary_qa_clip', {
      label: result.label,
      bucket: result.bucket,
      status: result.status,
      recutCount: result.recutCount,
      confidence: result.confidence,
      elapsedMs: Date.now() - startedAt
    })
    emitEvent(ctx, { type: 'qa_clip', clip: result })
  }

  const report: BoundaryQaReport = {
    clips: results,
    cleanCount: results.filter((r) => r.status === 'clean').length,
    autoFixedCount: results.filter((r) => r.status === 'auto_fixed').length,
    flaggedCount: results.filter((r) => r.status === 'flagged').length
  }
  emitEvent(ctx, { type: 'qa_complete', report })
  return report
}

export interface ManualRecutParams {
  clipPath: string
  sourcePath: string
  sourceStart: number
  sourceEnd: number
  bucket: ClipQaResult['bucket']
  label: string
  startDeltaMs: number
  endDeltaMs: number
  model?: string
}

/**
 * Apply a human nudge from the QA panel: recut the clip with adjusted bounds,
 * re-verify, and emit an updated `qa_clip` event. Positive `startDeltaMs` pulls
 * the start later; positive `endDeltaMs` extends the end.
 */
export async function manualRecutClip(
  ctx: ToolContextState,
  params: ManualRecutParams,
  signal?: AbortSignal
): Promise<ClipQaResult> {
  if (!ctx.clipAllowlist.has(params.clipPath)) {
    throw new Error('clipPath was not produced by this agent run')
  }
  if (!ctx.sourceAllowlist.has(params.sourcePath)) {
    throw new Error('sourcePath was not produced by this agent run')
  }
  const start = params.sourceStart + params.startDeltaMs / 1000
  const end = params.sourceEnd + params.endDeltaMs / 1000
  if (end - start < MIN_CLIP_SEC) {
    throw new Error('Nudge would make the clip too short')
  }

  const recut = await recutSourceClip(params.clipPath, params.sourcePath, start * 1000, end * 1000, ctx)
  const state = await verifyClipBoundaryState(
    ctx,
    recut.outputPath,
    params.bucket,
    undefined,
    QA_WINDOW_MS,
    params.model,
    signal
  )

  const result: ClipQaResult = {
    label: params.label,
    bucket: params.bucket,
    path: recut.outputPath,
    originalPath: params.clipPath,
    sourcePath: params.sourcePath,
    sourceStart: start,
    sourceEnd: end,
    duration: recut.duration,
    status: state.clean ? 'auto_fixed' : 'flagged',
    recutCount: 1,
    confidence: state.confidence,
    leadingLeak: state.leadingLeak,
    trailingLeak: state.trailingLeak
  }
  emitEvent(ctx, { type: 'qa_clip', clip: result })
  return result
}
