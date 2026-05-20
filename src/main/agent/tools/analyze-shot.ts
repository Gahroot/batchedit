import { z } from 'zod'
import type { FaceBox, ShotAnalysis, ShotType } from '../../../shared/types'
import { getVideoMetadata } from '../../ffmpeg'
import { detectFacesInFrame, type FaceDetectionBox } from '../facedetect'
import { classifyShotsWithVision } from '../vision-fallback'
import { extractFramesFromVideo } from './frames'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const analyzeShotSchema = z.object({
  path: z.string(),
  samples: z.number().int().positive().max(10).optional()
})

function sampleTimestamps(duration: number, samples = 3): number[] {
  if (samples <= 1) return [Math.min(1, Math.max(0, duration / 2))]
  if (samples === 3) return [1, duration / 2, Math.max(0, duration - 1)].map((t) => Math.max(0, Math.min(duration, t)))
  return Array.from({ length: samples }, (_, index) => (duration * (index + 1)) / (samples + 1))
}

function toNormalizedFaceBox(box: FaceDetectionBox, width: number, height: number): FaceBox {
  return {
    x: box.x / width,
    y: box.y / height,
    width: box.w / width,
    height: box.h / height
  }
}

export function classifyShotFromFaceBox(faceBox: FaceBox | null): ShotType {
  if (!faceBox) return 'wide'
  const centerY = faceBox.y + faceBox.height / 2
  if (faceBox.height > 0.6) return 'selfie'
  if (faceBox.height > 0.4 && faceBox.y > 0.05) return 'talking-head'
  if (faceBox.height < 0.2) return 'full-body'
  if (centerY > 0.6) return 'lower-third'
  return 'talking-head'
}

function hasFramingChange(shots: ShotAnalysis[]): boolean {
  const first = shots[0]?.shotType
  return shots.some((shot) => shot.shotType !== first)
}

export async function analyzeShotLocal(ctx: ToolContextState, path: string, samples = 3, signal?: AbortSignal): Promise<{ shots: ShotAnalysis[] }> {
  const metadata = await getVideoMetadata(path)
  const frames = await extractFramesFromVideo(path, sampleTimestamps(metadata.duration, samples), signal)
  const shots: ShotAnalysis[] = []

  for (const frame of frames) {
    const boxes = await detectFacesInFrame(frame.path, signal)
    const box = boxes[0]
    if (!box) {
      shots.push({ t: frame.t, shotType: 'wide', faceConfidence: 0, framingChange: false })
      continue
    }
    const faceBox = toNormalizedFaceBox(box, frame.width, frame.height)
    shots.push({
      t: frame.t,
      shotType: classifyShotFromFaceBox(faceBox),
      faceBox,
      faceConfidence: box.confidence,
      framingChange: false
    })
  }

  if (shots.every((shot) => shot.faceConfidence === 0)) {
    const visionShots = await classifyShotsWithVision({
      frames: frames.map((frame) => ({ t: frame.t, dataUrl: frame.dataUrl })),
      apiKey: ctx.apiKey,
      provider: ctx.provider,
      model: ctx.model,
      signal
    })
    return { shots: visionShots.map((shot) => ({ ...shot, framingChange: hasFramingChange(visionShots) })) }
  }

  const framingChange = hasFramingChange(shots)
  return { shots: shots.map((shot) => ({ ...shot, framingChange })) }
}

export function createAnalyzeShotTool(ctx: ToolContextState): BatchEditAgentTool {
  return {
    name: 'analyzeShot',
    description: 'Analyze sampled clip frames with FFmpeg facedetect and vision fallback to classify shot type.',
    parameters: analyzeShotSchema,
    async execute(args, toolContext) {
      if (!ctx.sourceAllowlist.has(args.path) && !ctx.clipAllowlist.has(args.path)) {
        throw new Error('path was not returned by ingestSource, splitClip, or recutClip')
      }
      const result = await analyzeShotLocal(ctx, args.path, args.samples ?? 3, toolContext.signal)
      return stringifyToolResult(result)
    }
  }
}
