import { z } from 'zod'
import { getElementPlacement, getSafeZone, CANVAS_HEIGHT, CANVAS_WIDTH } from '../../safe-zones'
import type { Platform as SafeZonePlatform, SafeZoneRect } from '../../safe-zones'
import type { FaceBox, Platform, ShotAnalysis, TemplateLayout } from '../../../shared/types'
import type { BatchEditAgentTool } from './types'
import { stringifyToolResult } from './types'

const faceBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const shotAnalysisSchema = z.object({
  t: z.number(),
  shotType: z.enum(['talking-head', 'full-body', 'selfie', 'lower-third', 'wide']),
  faceBox: faceBoxSchema.optional(),
  faceConfidence: z.number(),
  framingChange: z.boolean()
})

const pickTemplateSchema = z.object({
  shots: z.array(shotAnalysisSchema).min(1),
  platform: z.enum(['tiktok', 'reels', 'shorts', 'universal'])
})

function normalizedToPixelFaceBox(faceBox: FaceBox): SafeZoneRect {
  return {
    x: faceBox.x * CANVAS_WIDTH,
    y: faceBox.y * CANVAS_HEIGHT,
    width: faceBox.width * CANVAS_WIDTH,
    height: faceBox.height * CANVAS_HEIGHT
  }
}

function unionFaceBoxes(shots: ShotAnalysis[]): SafeZoneRect | null {
  const boxes = shots.flatMap((shot) => shot.faceBox ? [normalizedToPixelFaceBox(shot.faceBox)] : [])
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function centerPercent(rect: SafeZoneRect): { x: number; y: number } {
  return {
    x: Math.round(((rect.x + rect.width / 2) / CANVAS_WIDTH) * 100),
    y: Math.round(((rect.y + rect.height / 2) / CANVAS_HEIGHT) * 100)
  }
}

function dominantShotType(shots: ShotAnalysis[]): ShotAnalysis['shotType'] {
  const counts = new Map<ShotAnalysis['shotType'], number>()
  for (const shot of shots) counts.set(shot.shotType, (counts.get(shot.shotType) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'wide'
}

function captionPresetFor(shots: ShotAnalysis[], platform: Platform): string {
  const shotType = dominantShotType(shots)
  if (shotType === 'selfie' && platform === 'tiktok') return 'tiktok-glow'
  if (shotType === 'talking-head' && platform === 'universal') return 'hormozi-bold'
  if (shotType === 'lower-third') return 'bold-clean'
  if (shotType === 'full-body') return 'reels-clean'
  return 'classic-karaoke'
}

export function pickTemplateLayout(shots: ShotAnalysis[], platform: Platform): { template: TemplateLayout; captionPreset: string; reasoning: string } {
  const safeZone = getSafeZone(platform as SafeZonePlatform)
  const defaultCaption = getElementPlacement(platform as SafeZonePlatform, 'caption')
  const defaultTitle = getElementPlacement(platform as SafeZonePlatform, 'hook_text')
  const defaultMedia = getElementPlacement(platform as SafeZonePlatform, 'middle')
  const faceUnion = unionFaceBoxes(shots)
  const captionRect = faceUnion
    ? {
        x: safeZone.x + safeZone.width * 0.1,
        y: Math.min(safeZone.y + safeZone.height - 120, faceUnion.y + faceUnion.height + CANVAS_HEIGHT * 0.04),
        width: safeZone.width * 0.8,
        height: 110
      }
    : defaultCaption
  const captionInside = captionRect.y >= safeZone.y && captionRect.y + captionRect.height <= safeZone.y + safeZone.height
  const finalCaption = captionInside ? captionRect : defaultCaption
  const layout: TemplateLayout = {
    titleText: centerPercent(defaultTitle),
    subtitles: centerPercent(finalCaption),
    media: centerPercent(faceUnion ? defaultMedia : defaultMedia)
  }
  return {
    template: layout,
    captionPreset: captionPresetFor(shots, platform),
    reasoning: faceUnion ? 'Placed captions below detected face union within platform safe zone.' : 'No reliable face box; used platform defaults.'
  }
}

export function createPickTemplateTool(): BatchEditAgentTool {
  return {
    name: 'pickTemplate',
    description: 'Pick a deterministic template layout and caption preset from shot analysis and platform safe zones.',
    parameters: pickTemplateSchema,
    execute(args) {
      return stringifyToolResult(pickTemplateLayout(args.shots, args.platform))
    }
  }
}
