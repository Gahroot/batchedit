import { mkdir } from 'fs/promises'
import { basename, extname, join } from 'path'
import { z } from 'zod'
import { getVideoMetadata, trimVideo, trimVideoReencode } from '../../ffmpeg'
import type { BucketType } from '../../../shared/types'
import { runBoundaryQA } from '../boundary-qa'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const segmentSchema = z.object({
  bucket: z.enum(['hook', 'meat', 'cta']),
  label: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive()
})

const splitClipSchema = z.object({
  sourcePath: z.string(),
  segments: z.array(segmentSchema).min(1),
  outDir: z.string()
})

const recutClipSchema = z.object({
  clipPath: z.string(),
  sourcePath: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().positive()
})

export interface SplitClipResult {
  label: string
  bucket: BucketType
  path: string
  duration: number
  sourceStart: number
  sourceEnd: number
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

function outputPathForSegment(sourcePath: string, outDir: string, label: string, index: number): string {
  const extension = extname(sourcePath) || '.mp4'
  const base = safeFileName(label) || `clip-${index + 1}`
  return join(outDir, `${String(index + 1).padStart(2, '0')}-${base}${extension}`)
}

export async function splitSourceClip(
  sourcePath: string,
  segments: Array<{ bucket: BucketType; label: string; start: number; end: number }>,
  outDir: string,
  ctx?: ToolContextState
): Promise<SplitClipResult[]> {
  await mkdir(outDir, { recursive: true })
  const clips: SplitClipResult[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const outputPath = outputPathForSegment(sourcePath, outDir, segment.label, index)
    const startedAt = Date.now()
    await trimVideo(sourcePath, outputPath, segment.start, segment.end)
    const metadata = await getVideoMetadata(outputPath)
    ctx?.clipAllowlist.add(outputPath)
    console.info('agent_split_clip', {
      sourcePath,
      outputPath,
      start: segment.start,
      end: segment.end,
      ok: true,
      elapsedMs: Date.now() - startedAt
    })
    clips.push({
      label: segment.label,
      bucket: segment.bucket,
      path: outputPath,
      duration: metadata.duration,
      sourceStart: segment.start,
      sourceEnd: segment.end
    })
  }
  return clips
}

export async function recutSourceClip(
  clipPath: string,
  sourcePath: string,
  startMs: number,
  endMs: number,
  ctx?: ToolContextState
): Promise<{ outputPath: string; duration: number }> {
  const extension = extname(clipPath) || '.mp4'
  const outputPath = join(
    join(clipPath, '..'),
    `${basename(clipPath, extension)}-recut-${Math.round(startMs)}-${Math.round(endMs)}${extension}`
  )
  const startedAt = Date.now()
  await trimVideoReencode(sourcePath, outputPath, startMs / 1000, endMs / 1000)
  const metadata = await getVideoMetadata(outputPath)
  ctx?.clipAllowlist.add(outputPath)
  console.info('agent_recut_clip', { clipPath, sourcePath, outputPath, startMs, endMs, ok: true, elapsedMs: Date.now() - startedAt })
  return { outputPath, duration: metadata.duration }
}

export function createSplitClipTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'splitClip',
    description: 'Split a source video into labeled bucket clips using existing FFmpeg trimming.',
    parameters: splitClipSchema,
    executionMode: 'sequential',
    async execute(args, toolContext) {
      if (!ctx.sourceAllowlist.has(args.sourcePath)) throw new Error('sourcePath was not returned by ingestSource')
      const clips = await splitSourceClip(args.sourcePath, args.segments, args.outDir, ctx)
      // Boundary QA is mandatory: every split is verified and auto-recut here
      // before the agent ever sees the clips, so contamination never reaches
      // the buckets silently.
      const report = await runBoundaryQA(
        ctx,
        args.sourcePath,
        clips,
        // Whisper model is left to the renderer's configured default.
        {},
        toolContext.signal
      )
      return stringifyToolResult({
        clips: report.clips,
        qa: {
          cleanCount: report.cleanCount,
          autoFixedCount: report.autoFixedCount,
          flaggedCount: report.flaggedCount
        }
      })
    }
  }
}

export function createRecutClipTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'recutClip',
    description: 'Re-encode a clip from its original source using adjusted millisecond boundaries.',
    parameters: recutClipSchema,
    executionMode: 'sequential',
    async execute(args) {
      if (!ctx.clipAllowlist.has(args.clipPath)) throw new Error('clipPath was not returned by splitClip or recutClip')
      if (!ctx.sourceAllowlist.has(args.sourcePath)) throw new Error('sourcePath was not returned by ingestSource')
      const result = await recutSourceClip(args.clipPath, args.sourcePath, args.startMs, args.endMs, ctx)
      return stringifyToolResult(result)
    }
  }
}
