import { providerRegistry, stream, type Provider } from '@prestyj/ai'
import { z } from 'zod'
import type { ShotAnalysis, ShotType } from '../../shared/types'
import { createGoogleProviderEntry, GEMINI_FLASH_MODEL, GOOGLE_PROVIDER } from './google-provider'

if (!providerRegistry.has(GOOGLE_PROVIDER)) providerRegistry.register(GOOGLE_PROVIDER, createGoogleProviderEntry())

type VisionProvider = Provider | typeof GOOGLE_PROVIDER

export interface VisionFrame {
  t: number
  dataUrl: string
}

export interface VisionFallbackOptions {
  frames: VisionFrame[]
  apiKey?: string
  provider?: VisionProvider
  model?: string
  signal?: AbortSignal
}

const shotTypeSchema = z.enum(['talking-head', 'full-body', 'selfie', 'lower-third', 'wide'])

const visionShotSchema = z.object({
  t: z.number(),
  shotType: shotTypeSchema,
  faceConfidence: z.number().min(0).max(1),
  framingChange: z.boolean()
})

const visionResponseSchema = z.object({
  shots: z.array(visionShotSchema)
})

function stripDataUrl(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',')
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Vision response did not contain JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export async function classifyShotsWithVision(options: VisionFallbackOptions): Promise<ShotAnalysis[]> {
  const startedAt = Date.now()
  const result = stream({
    provider: (options.provider ?? GOOGLE_PROVIDER) as Provider,
    model: options.model ?? GEMINI_FLASH_MODEL,
    apiKey: options.apiKey,
    signal: options.signal,
    maxTokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Classify each video frame into one shotType: talking-head, full-body, selfie, lower-third, or wide. Return only JSON shaped as {"shots":[{"t":number,"shotType":string,"faceConfidence":0-1,"framingChange":boolean}]}.'
          },
          ...options.frames.map((frame) => ({
            type: 'image' as const,
            mediaType: 'image/png',
            data: stripDataUrl(frame.dataUrl)
          }))
        ]
      }
    ]
  })

  const response = await result
  const text = typeof response.message.content === 'string'
    ? response.message.content
    : response.message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
  const parsed = visionResponseSchema.parse(parseJsonObject(text))
  console.info('vision_shot_classification', {
    provider: options.provider ?? GOOGLE_PROVIDER,
    model: options.model ?? GEMINI_FLASH_MODEL,
    frames: options.frames.length,
    ok: true,
    elapsedMs: Date.now() - startedAt
  })

  return parsed.shots.map((shot): ShotAnalysis => ({
    t: shot.t,
    shotType: shot.shotType as ShotType,
    faceConfidence: shot.faceConfidence,
    framingChange: shot.framingChange
  }))
}
