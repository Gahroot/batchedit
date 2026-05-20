export type BucketType = 'hook' | 'meat' | 'cta'

export type Platform = 'tiktok' | 'reels' | 'shorts' | 'universal'

export interface WordChunk {
  text: string
  start: number
  end: number
}

export interface SpeechInterval {
  start: number
  end: number
}

export interface DetectedMarker {
  id: string
  label: string
  bucket: BucketType
  startTime: number
  endTime: number
  markerChunkIndices: number[]
}

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export type ShotType = 'talking-head' | 'full-body' | 'selfie' | 'lower-third' | 'wide'

export interface ShotAnalysis {
  t: number
  shotType: ShotType
  faceBox?: FaceBox
  faceConfidence: number
  framingChange: boolean
}

export interface Leak {
  marker: string
  matchedTokens: string[]
  confidence: number
  suggestedTrimMs: number
}

export interface TemplateLayout {
  titleText: { x: number; y: number }
  subtitles: { x: number; y: number }
  media: { x: number; y: number }
}
