import { z } from 'zod'
import { callRenderer } from '../renderer-rpc'
import { readTranscriptCache, writeTranscriptCache } from '../transcript-cache'
import type { SpeechInterval, WordChunk } from '../../../shared/types'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const transcribeClipSchema = z.object({
  path: z.string(),
  model: z.string().optional()
})

const rendererTranscribeResultSchema = z.object({
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
  full: z.string().optional(),
  srtPath: z.string().optional(),
  speechIntervals: z.array(z.object({ start: z.number(), end: z.number() })).optional()
})

export interface TranscribeClipResult {
  words: WordChunk[]
  full: string
  srtPath?: string
  speechIntervals?: SpeechInterval[]
}

// Whisper model load + full transcription + gap re-transcription + VAD on a long
// clip routinely runs for several minutes, far beyond callRenderer's 60s default.
// Cap generously so long sources don't fail with a misleading "tool failure".
const TRANSCRIBE_RPC_TIMEOUT_MS = 30 * 60_000

function fullText(words: WordChunk[]): string {
  return words.map((word) => word.text).join(' ').trim()
}

export async function transcribeClipWithRenderer(
  ctx: ToolContextState,
  path: string,
  model: string | undefined,
  signal?: AbortSignal
): Promise<TranscribeClipResult> {
  const cached = await readTranscriptCache(path, model)
  if (cached) return cached

  const startedAt = Date.now()
  const raw = await callRenderer<unknown>(ctx.win, 'agent:transcribe', { path, model }, signal, TRANSCRIBE_RPC_TIMEOUT_MS)
  const parsed = rendererTranscribeResultSchema.parse(raw)
  const result: TranscribeClipResult = {
    words: parsed.words,
    full: parsed.full ?? fullText(parsed.words),
    ...(parsed.srtPath ? { srtPath: parsed.srtPath } : {}),
    ...(parsed.speechIntervals ? { speechIntervals: parsed.speechIntervals } : {})
  }
  await writeTranscriptCache(path, model, result)
  console.info('agent_transcribe_clip', { path, model, ok: true, elapsedMs: Date.now() - startedAt })
  return result
}

export function createTranscribeClipTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'transcribeClip',
    description: 'Transcribe a clip using the renderer Whisper bridge, with sha1 transcript caching.',
    parameters: transcribeClipSchema,
    async execute(args, toolContext) {
      if (!ctx.sourceAllowlist.has(args.path) && !ctx.clipAllowlist.has(args.path)) {
        throw new Error('Path was not returned by ingestSource or splitClip')
      }
      const result = await transcribeClipWithRenderer(ctx, args.path, args.model, toolContext.signal)
      // Do NOT return the full word-level transcript to the model. It can be
      // hundreds of word objects; some models echo it back verbatim and blow the
      // stream timeout. The full transcript stays cached server-side — pass this
      // clipPath to detectMarkers, which reads the cached words directly.
      return stringifyToolResult({
        clipPath: args.path,
        ...(args.model ? { model: args.model } : {}),
        wordCount: result.words.length,
        durationSec: result.words.at(-1)?.end ?? 0,
        textPreview: result.full.slice(0, 280)
      })
    }
  }
}
