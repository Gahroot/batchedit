import { execFile } from 'child_process'
import { promisify } from 'util'
import { getResolvedFfmpegPath } from '../ffmpeg'

const execFileAsync = promisify(execFile)

export interface FaceDetectionBox {
  x: number
  y: number
  w: number
  h: number
  confidence: number
}

const FACEDETECT_REGEX = /x:(?<x>\d+)\s+y:(?<y>\d+)\s+w:(?<w>\d+)\s+h:(?<h>\d+)/g

export async function detectFacesInFrame(framePath: string, signal?: AbortSignal): Promise<FaceDetectionBox[]> {
  const ffmpegPath = getResolvedFfmpegPath()
  if (!ffmpegPath) return []

  const startedAt = Date.now()
  try {
    const result = await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', framePath, '-vf', 'facedetect', '-f', 'null', '-'],
      { signal, timeout: 30_000, maxBuffer: 1024 * 1024 * 4 }
    )
    const output = `${result.stdout}\n${result.stderr}`
    const boxes = parseFaceDetectionOutput(output)
    console.info('facedetect_frame', { framePath, ok: true, faces: boxes.length, elapsedMs: Date.now() - startedAt })
    return boxes
  } catch (error) {
    const output = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    const boxes = parseFaceDetectionOutput(output)
    if (boxes.length > 0) {
      console.info('facedetect_frame', { framePath, ok: true, faces: boxes.length, elapsedMs: Date.now() - startedAt })
      return boxes
    }
    console.info('facedetect_frame', {
      framePath,
      ok: false,
      faces: 0,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

export function parseFaceDetectionOutput(output: string): FaceDetectionBox[] {
  const boxes: FaceDetectionBox[] = []
  for (const match of output.matchAll(FACEDETECT_REGEX)) {
    const groups = match.groups
    if (!groups) continue
    boxes.push({
      x: Number(groups.x),
      y: Number(groups.y),
      w: Number(groups.w),
      h: Number(groups.h),
      confidence: 1
    })
  }
  return boxes
}
