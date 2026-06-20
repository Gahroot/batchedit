import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { detectMarkers } from '../shared/marker-detection'
import type { BucketType, ClipQaResult, Leak, WordChunk } from '../shared/types'
import { getVideoMetadata } from './ffmpeg'
import { callRenderer } from './agent/renderer-rpc'
import { readTranscriptCache, writeTranscriptCache } from './agent/transcript-cache'
import { recutSourceClip } from './agent/tools/splits'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window (ms) at each clip edge scanned for marker contamination. */
const QA_WINDOW_MS = 1500

/** Hard cap on automatic recut attempts before escalating to human review. */
const MAX_AUTO_RECUTS = 2

/** Clips shorter than this after a proposed trim are escalated instead of recut. */
const MIN_CLIP_SEC = 0.5

// Whisper model load + full transcription routinely runs for several minutes.
const TRANSCRIBE_RPC_TIMEOUT_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const rendererTranscribeResultSchema = z.object({
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
  full: z.string().optional(),
  srtPath: z.string().optional(),
  speechIntervals: z.array(z.object({ start: z.number(), end: z.number() })).optional()
})

// ---------------------------------------------------------------------------
// Transcription helper (standalone, no ToolContextState)
// ---------------------------------------------------------------------------

interface TranscribeResult {
  words: WordChunk[]
  full: string
}

async function transcribeClip(
  win: BrowserWindow,
  path: string,
  model: string | undefined,
  signal?: AbortSignal
): Promise<TranscribeResult> {
  const cached = await readTranscriptCache(path, model)
  if (cached) return { words: cached.words, full: cached.full }

  const startedAt = Date.now()
  const raw = await callRenderer<unknown>(win, 'agent:transcribe', { path, model }, signal, TRANSCRIBE_RPC_TIMEOUT_MS)
  const parsed = rendererTranscribeResultSchema.parse(raw)
  const fullText = parsed.words.map((w) => w.text).join(' ').trim()
  const result: TranscribeResult = { words: parsed.words, full: parsed.full ?? fullText }
  await writeTranscriptCache(path, model, {
    words: parsed.words,
    full: result.full,
    ...(parsed.srtPath ? { srtPath: parsed.srtPath } : {}),
    ...(parsed.speechIntervals ? { speechIntervals: parsed.speechIntervals } : {})
  })
  console.info('qa_pipeline_transcribe', { path, model, ok: true, elapsedMs: Date.now() - startedAt })
  return result
}

// ---------------------------------------------------------------------------
// Boundary verification (standalone, no ToolContextState)
// ---------------------------------------------------------------------------

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function leakFromWindow(words: WordChunk[], side: 'leading' | 'trailing', duration: number): Leak | null {
  if (words.length === 0) return null
  const shifted = words.map((word) => ({ ...word, start: Math.max(0, word.start), end: Math.max(0, word.end) }))
  const markers = detectMarkers(shifted, duration)
  const marker = markers[0]
  if (!marker) return null
  const markerWords = marker.markerChunkIndices
    .map((index) => shifted[index])
    .filter((word): word is WordChunk => Boolean(word))
  const matchedTokens = markerWords.map((word) => word.text)
  const boundaryDistance = side === 'leading' ? marker.endTime : Math.max(0, duration - marker.startTime)
  const confidence = Math.max(0.2, Math.min(1, 1 - boundaryDistance / Math.max(duration, 1)))
  return {
    marker: marker.label,
    matchedTokens,
    confidence,
    suggestedTrimMs:
      side === 'leading'
        ? Math.ceil(marker.endTime * 1000 + 80)
        : Math.ceil((duration - marker.startTime) * 1000 + 80)
  }
}

async function verifyClipBoundaries(
  win: BrowserWindow,
  clipPath: string,
  expectedSection: BucketType,
  windowMs: number,
  model: string | undefined,
  signal?: AbortSignal
): Promise<{
  clean: boolean
  leadingLeak: Leak | null
  trailingLeak: Leak | null
  confidence: number
}> {
  const metadata = await getVideoMetadata(clipPath)
  const duration = metadata.duration
  const { words: transcript } = await transcribeClip(win, clipPath, model, signal)
  const windowSec = windowMs / 1000
  const leading = transcript.filter((word) => word.start < windowSec)
  const trailing = transcript.filter((word) => word.end > Math.max(0, duration - windowSec))
  const leadingLeak = leakFromWindow(leading, 'leading', duration)
  const trailingLeak = leakFromWindow(trailing, 'trailing', duration)
  const wrongSectionLeak = [leadingLeak, trailingLeak].find(
    (leak) => leak && normalizeToken(leak.marker).startsWith(expectedSection) === false
  )
  const confidence = wrongSectionLeak
    ? Math.max(0.1, 1 - wrongSectionLeak.confidence)
    : leadingLeak || trailingLeak
      ? 0.75
      : 0.95
  return { clean: !leadingLeak && !trailingLeak, leadingLeak, trailingLeak, confidence }
}

// ---------------------------------------------------------------------------
// QA loop helpers
// ---------------------------------------------------------------------------

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

/** Input shape accepted by the QA pipeline (matches the split clip output). */
export interface QaClipInput {
  label: string
  bucket: BucketType
  path: string
  /** Source-relative start time in seconds. */
  sourceStart: number
  /** Source-relative end time in seconds. */
  sourceEnd: number
  duration: number
}

/**
 * Deterministic boundary-QA loop for a single clip.
 * Re-transcribes the clip, detects marker contamination at either edge, and
 * auto-recuts from the original source until the clip is clean or the recut
 * budget is exhausted (then it is flagged for human review).
 */
async function qaSingleClip(
  win: BrowserWindow,
  sourcePath: string,
  clip: QaClipInput,
  windowMs: number,
  maxRecuts: number,
  model: string | undefined,
  signal?: AbortSignal
): Promise<ClipQaResult> {
  let path = clip.path
  let start = clip.sourceStart
  let end = clip.sourceEnd
  let duration = clip.duration
  let recutCount = 0

  while (true) {
    const state = await verifyClipBoundaries(win, path, clip.bucket, windowMs, model, signal)

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
      const status = recutCount > 0 ? 'auto_fixed' : 'clean'
      return { ...base, status }
    }

    if (recutCount >= maxRecuts) {
      return { ...base, status: 'flagged' }
    }

    const bounds = nextBounds(
      start,
      end,
      state.leadingLeak?.suggestedTrimMs ?? null,
      state.trailingLeak?.suggestedTrimMs ?? null
    )

    if (bounds.end - bounds.start < MIN_CLIP_SEC) {
      return { ...base, status: 'flagged' }
    }

    const recut = await recutSourceClip(path, sourcePath, bounds.start * 1000, bounds.end * 1000)
    path = recut.outputPath
    duration = recut.duration
    start = bounds.start
    end = bounds.end
    recutCount += 1
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BoundaryQaOptions {
  /** Whisper model for re-transcription; undefined uses the renderer's configured model. */
  model?: string
  windowMs?: number
  maxRecuts?: number
}

/**
 * Run the mandatory boundary-QA pass across every freshly split clip.
 * Returns a `BoundaryQaReport` so the caller can surface only the clips that
 * still need human review.
 */
export async function runBoundaryQA(
  win: BrowserWindow,
  sourcePath: string,
  clips: QaClipInput[],
  options: BoundaryQaOptions = {},
  signal?: AbortSignal
): Promise<{ clips: ClipQaResult[]; cleanCount: number; autoFixedCount: number; flaggedCount: number }> {
  const windowMs = options.windowMs ?? QA_WINDOW_MS
  const maxRecuts = options.maxRecuts ?? MAX_AUTO_RECUTS

  const results: ClipQaResult[] = []
  for (const clip of clips) {
    const startedAt = Date.now()
    const result = await qaSingleClip(win, sourcePath, clip, windowMs, maxRecuts, options.model, signal)
    results.push(result)
    console.info('qa_pipeline_clip', {
      label: result.label,
      bucket: result.bucket,
      status: result.status,
      recutCount: result.recutCount,
      confidence: result.confidence,
      elapsedMs: Date.now() - startedAt
    })
  }

  return {
    clips: results,
    cleanCount: results.filter((r) => r.status === 'clean').length,
    autoFixedCount: results.filter((r) => r.status === 'auto_fixed').length,
    flaggedCount: results.filter((r) => r.status === 'flagged').length
  }
}

export interface ManualRecutParams {
  clipPath: string
  sourcePath: string
  sourceStart: number
  sourceEnd: number
  bucket: BucketType
  label: string
  startDeltaMs: number
  endDeltaMs: number
  model?: string
}

/**
 * Apply a human nudge from the QA panel: recut the clip with adjusted bounds,
 * re-verify, and return an updated `ClipQaResult`. Positive `startDeltaMs`
 * pulls the start later; negative `endDeltaMs` pulls the end earlier.
 */
export async function manualRecutClip(
  win: BrowserWindow,
  params: ManualRecutParams,
  signal?: AbortSignal
): Promise<ClipQaResult> {
  const start = params.sourceStart + params.startDeltaMs / 1000
  const end = params.sourceEnd + params.endDeltaMs / 1000
  if (end - start < MIN_CLIP_SEC) {
    throw new Error('Nudge would make the clip too short')
  }

  const recut = await recutSourceClip(params.clipPath, params.sourcePath, start * 1000, end * 1000)
  const state = await verifyClipBoundaries(win, recut.outputPath, params.bucket, QA_WINDOW_MS, params.model, signal)

  return {
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
}
