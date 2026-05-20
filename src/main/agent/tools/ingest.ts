import { stat } from 'fs/promises'
import { z } from 'zod'
import { getVideoMetadata } from '../../ffmpeg'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const ingestSourceSchema = z.object({
  paths: z.array(z.string()).min(1)
})

export function createIngestSourceTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'ingestSource',
    description: 'Inspect source video files and return duration, fps, and audio availability metadata.',
    parameters: ingestSourceSchema,
    async execute(args, toolContext) {
      const sources = []
      for (const path of args.paths) {
        if (toolContext.signal.aborted) throw new Error('aborted')
        const startedAt = Date.now()
        await stat(path)
        const metadata = await getVideoMetadata(path)
        ctx.sourceAllowlist.add(path)
        const source = {
          id: path,
          path,
          duration: metadata.duration,
          fps: metadata.fps,
          hasAudio: metadata.audioCodec !== 'unknown'
        }
        console.info('agent_ingest_source', { path, ok: true, elapsedMs: Date.now() - startedAt })
        sources.push(source)
      }
      return stringifyToolResult({ sources })
    }
  }
}
