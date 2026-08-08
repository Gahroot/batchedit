import { basename, extname, join } from 'path'
import { getVideoMetadata, trimVideoReencode } from './ffmpeg'

export async function recutSourceClip(
  clipPath: string,
  sourcePath: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal
): Promise<{ outputPath: string; duration: number }> {
  const extension = extname(clipPath) || '.mp4'
  const outputPath = join(
    clipPath,
    '..',
    `${basename(clipPath, extension)}-recut-${Math.round(startMs)}-${Math.round(endMs)}${extension}`
  )
  const startedAt = Date.now()
  await trimVideoReencode(sourcePath, outputPath, startMs / 1000, endMs / 1000, signal)
  const metadata = await getVideoMetadata(outputPath, signal)
  console.info('qa_recut_clip', {
    clipPath,
    sourcePath,
    outputPath,
    startMs,
    endMs,
    ok: true,
    elapsedMs: Date.now() - startedAt
  })
  return { outputPath, duration: metadata.duration }
}
