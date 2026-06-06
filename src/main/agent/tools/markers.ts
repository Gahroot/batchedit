import { z } from 'zod'
import { detectMarkers } from '../../../shared/marker-detection'
import { readTranscriptCache } from '../transcript-cache'
import type { BucketType, DetectedMarker } from '../../../shared/types'
import type { BatchEditAgentTool } from './types'
import { stringifyToolResult } from './types'

const detectedMarkerSchema = z.object({
  id: z.string(),
  label: z.string(),
  bucket: z.enum(['hook', 'meat', 'cta']),
  startTime: z.number(),
  endTime: z.number(),
  markerChunkIndices: z.array(z.number())
})

const detectMarkersSchema = z.object({
  clipPath: z.string(),
  model: z.string().optional(),
  fullDuration: z.number().optional()
})

const proposeSplitsSchema = z.object({
  markers: z.array(detectedMarkerSchema),
  audioPath: z.string().optional(),
  fullDuration: z.number()
})

export interface ProposedSplit {
  bucket: BucketType
  label: string
  start: number
  end: number
  confidence: number
}

function confidenceForMarker(marker: DetectedMarker, fullDuration: number): number {
  const duration = marker.endTime - marker.startTime
  if (duration <= 0) return 0
  if (marker.startTime < 0 || marker.endTime > fullDuration) return 0.4
  if (duration < 0.75) return 0.5
  return 0.9
}

export function proposeSplitsFromMarkers(markers: DetectedMarker[], fullDuration: number): ProposedSplit[] {
  return markers.map((marker) => ({
    bucket: marker.bucket,
    label: marker.label,
    start: Math.max(0, marker.startTime),
    end: Math.min(fullDuration, marker.endTime),
    confidence: confidenceForMarker(marker, fullDuration)
  }))
}

export function createDetectMarkersTool(): BatchEditAgentTool {
  return {
    name: 'detectMarkers',
    description: 'Detect Hook, Meat, and CTA marker phrases from the transcript cached by transcribeClip. Pass the clipPath (and model, if used) returned by transcribeClip.',
    parameters: detectMarkersSchema,
    async execute(args) {
      const cached = await readTranscriptCache(args.clipPath, args.model)
      if (!cached) {
        throw new Error('No cached transcript for clipPath; call transcribeClip first')
      }
      const fullDuration = args.fullDuration ?? cached.words.at(-1)?.end ?? 0
      const markers = detectMarkers(cached.words, fullDuration, cached.speechIntervals ?? [])
      return stringifyToolResult({ markers })
    }
  }
}

export function createProposeSplitsTool(): BatchEditAgentTool {
  return {
    name: 'proposeSplits',
    description: 'Convert detected markers into proposed clip split boundaries with confidence scores.',
    parameters: proposeSplitsSchema,
    execute(args) {
      return stringifyToolResult({ splits: proposeSplitsFromMarkers(args.markers, args.fullDuration) })
    }
  }
}
