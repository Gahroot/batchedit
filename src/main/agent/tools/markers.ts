import { z } from 'zod'
import { detectMarkers } from '../../../shared/marker-detection'
import type { BucketType, DetectedMarker, WordChunk } from '../../../shared/types'
import type { BatchEditAgentTool } from './types'
import { stringifyToolResult } from './types'

const wordChunkSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number()
})

const detectedMarkerSchema = z.object({
  id: z.string(),
  label: z.string(),
  bucket: z.enum(['hook', 'meat', 'cta']),
  startTime: z.number(),
  endTime: z.number(),
  markerChunkIndices: z.array(z.number())
})

const detectMarkersSchema = z.object({
  words: z.array(wordChunkSchema),
  fullDuration: z.number().optional(),
  speechIntervals: z.array(z.object({ start: z.number(), end: z.number() })).optional()
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
    description: 'Detect Hook, Meat, and CTA marker phrases from word-level transcript chunks.',
    parameters: detectMarkersSchema,
    execute(args) {
      const fullDuration = args.fullDuration ?? args.words.at(-1)?.end ?? 0
      const markers = detectMarkers(args.words as WordChunk[], fullDuration, args.speechIntervals ?? [])
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
