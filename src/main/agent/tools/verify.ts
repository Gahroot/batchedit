import { z } from 'zod'
import { detectMarkers } from '../../../shared/marker-detection'
import type { Leak, WordChunk } from '../../../shared/types'
import { getVideoMetadata } from '../../ffmpeg'
import { transcribeClipWithRenderer } from './transcribe'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const wordChunkSchema = z.object({ text: z.string(), start: z.number(), end: z.number() })

const verifyClipBoundariesSchema = z.object({
  clipPath: z.string(),
  expectedSection: z.enum(['hook', 'meat', 'cta']),
  parentWords: z.array(wordChunkSchema).optional(),
  windowMs: z.number().positive().optional(),
  model: z.string().optional()
})

const verifySrtAlignmentSchema = z.object({
  clipPath: z.string(),
  srtPath: z.string().optional(),
  parentWords: z.array(wordChunkSchema).optional(),
  model: z.string().optional()
})

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function leakFromWindow(words: WordChunk[], side: 'leading' | 'trailing', duration: number): Leak | null {
  if (words.length === 0) return null
  const shifted = words.map((word) => ({ ...word, start: Math.max(0, word.start), end: Math.max(0, word.end) }))
  const markers = detectMarkers(shifted, duration)
  const marker = markers[0]
  if (!marker) return null
  const markerWords = marker.markerChunkIndices.map((index) => shifted[index]).filter((word): word is WordChunk => Boolean(word))
  const matchedTokens = markerWords.map((word) => word.text)
  const boundaryDistance = side === 'leading' ? marker.endTime : Math.max(0, duration - marker.startTime)
  const confidence = Math.max(0.2, Math.min(1, 1 - boundaryDistance / Math.max(duration, 1)))
  return {
    marker: marker.label,
    matchedTokens,
    confidence,
    suggestedTrimMs: side === 'leading'
      ? Math.ceil(marker.endTime * 1000 + 80)
      : Math.ceil((duration - marker.startTime) * 1000 + 80)
  }
}

export async function verifyClipBoundaryState(
  ctx: ToolContextState,
  clipPath: string,
  expectedSection: 'hook' | 'meat' | 'cta',
  parentWords: WordChunk[] | undefined,
  windowMs: number,
  model: string | undefined,
  signal?: AbortSignal
): Promise<{
  clean: boolean
  leadingLeak: Leak | null
  trailingLeak: Leak | null
  transcript: WordChunk[]
  confidence: number
}> {
  const metadata = await getVideoMetadata(clipPath)
  const duration = metadata.duration
  const transcript = parentWords ?? (await transcribeClipWithRenderer(ctx, clipPath, model, signal)).words
  const windowSec = windowMs / 1000
  const leading = transcript.filter((word) => word.start < windowSec)
  const trailing = transcript.filter((word) => word.end > Math.max(0, duration - windowSec))
  const leadingLeak = leakFromWindow(leading, 'leading', duration)
  const trailingLeak = leakFromWindow(trailing, 'trailing', duration)
  const wrongSectionLeak = [leadingLeak, trailingLeak].find((leak) => leak && normalizeToken(leak.marker).startsWith(expectedSection) === false)
  const confidence = wrongSectionLeak ? Math.max(0.1, 1 - wrongSectionLeak.confidence) : leadingLeak || trailingLeak ? 0.75 : 0.95
  return {
    clean: !leadingLeak && !trailingLeak,
    leadingLeak,
    trailingLeak,
    transcript,
    confidence
  }
}

function alignmentMismatches(expectedWords: WordChunk[], freshWords: WordChunk[]): Array<{ expectedWord: string; freshWord: string; position: number }> {
  const mismatches: Array<{ expectedWord: string; freshWord: string; position: number }> = []
  const total = Math.max(expectedWords.length, freshWords.length)
  for (let index = 0; index < total; index += 1) {
    const expected = expectedWords[index]
    const fresh = freshWords[index]
    if (normalizeToken(expected?.text ?? '') !== normalizeToken(fresh?.text ?? '')) {
      mismatches.push({ expectedWord: expected?.text ?? '', freshWord: fresh?.text ?? '', position: index })
    }
  }
  return mismatches
}

export function createVerifyClipBoundariesTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'verifyClipBoundaries',
    description: 'Detect marker contamination at the leading and trailing edges of a split clip.',
    parameters: verifyClipBoundariesSchema,
    async execute(args, toolContext) {
      if (!ctx.clipAllowlist.has(args.clipPath)) throw new Error('clipPath was not returned by splitClip or recutClip')
      const result = await verifyClipBoundaryState(
        ctx,
        args.clipPath,
        args.expectedSection,
        args.parentWords,
        args.windowMs,
        args.model,
        toolContext.signal
      )
      return stringifyToolResult(result)
    }
  }
}

export function createVerifySrtAlignmentTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'verifySrtAlignment',
    description: 'Re-transcribe a split clip and compare token sequence against expected parent transcript words.',
    parameters: verifySrtAlignmentSchema,
    async execute(args, toolContext) {
      if (!ctx.clipAllowlist.has(args.clipPath)) throw new Error('clipPath was not returned by splitClip or recutClip')
      const freshWords = (await transcribeClipWithRenderer(ctx, args.clipPath, args.model, toolContext.signal)).words
      const expectedWords = args.parentWords ?? []
      const mismatches = alignmentMismatches(expectedWords, freshWords)
      const total = Math.max(expectedWords.length, freshWords.length, 1)
      const matchedPairs = expectedWords.slice(0, freshWords.length).filter((word, index) => normalizeToken(word.text) === normalizeToken(freshWords[index]?.text ?? ''))
      const drift = matchedPairs.length === 0 ? 0 : matchedPairs.reduce((sum, word, index) => sum + ((freshWords[index]?.start ?? word.start) - word.start) * 1000, 0) / matchedPairs.length
      return stringifyToolResult({
        aligned: mismatches.length / total < 0.05,
        drift,
        mismatches
      })
    }
  }
}
