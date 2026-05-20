import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import { getResolvedFfmpegPath, getVideoMetadata } from '../../ffmpeg'
import type { BatchEditAgentTool } from './types'
import { stringifyToolResult } from './types'

const execFileAsync = promisify(execFile)

const extractFramesSchema = z.object({
  path: z.string(),
  timestamps: z.array(z.number().nonnegative()).min(1)
})

export interface ExtractedFrame {
  t: number
  dataUrl: string
  width: number
  height: number
  path: string
}

export async function extractFramesFromVideo(
  path: string,
  timestamps: number[],
  signal?: AbortSignal
): Promise<ExtractedFrame[]> {
  const ffmpegPath = getResolvedFfmpegPath()
  if (!ffmpegPath) throw new Error('FFmpeg is not available')
  const metadata = await getVideoMetadata(path)
  const directory = await mkdtemp(join(tmpdir(), 'batchedit-agent-frames-'))
  const frames: ExtractedFrame[] = []

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]
    const outPath = join(directory, `frame-${index}.png`)
    const startedAt = Date.now()
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-y', '-ss', String(timestamp), '-i', path, '-frames:v', '1', outPath],
      { signal, timeout: 30_000, maxBuffer: 1024 * 1024 * 4 }
    )
    const data = await readFile(outPath)
    console.info('agent_extract_frame', { path, timestamp, ok: true, elapsedMs: Date.now() - startedAt })
    frames.push({
      t: timestamp,
      dataUrl: `data:image/png;base64,${data.toString('base64')}`,
      width: metadata.width,
      height: metadata.height,
      path: outPath
    })
  }

  return frames
}

export function createExtractFramesTool(): BatchEditAgentTool {
  return {
    name: 'extractFrames',
    description: 'Extract PNG video frames at requested timestamps and return base64 data URLs.',
    parameters: extractFramesSchema,
    async execute(args, toolContext) {
      const frames = await extractFramesFromVideo(args.path, args.timestamps, toolContext.signal)
      return stringifyToolResult({
        frames: frames.map(({ path: _path, ...frame }) => frame)
      })
    }
  }
}
