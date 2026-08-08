export type BucketType = 'hook' | 'meat' | 'cta'

export type Platform = 'tiktok' | 'reels' | 'shorts' | 'universal'

export type TrimLeadingSilenceResult =
  | {
      outcome: 'trim-success'
      outputPath: string
      trimmedSeconds: number
    }
  | {
      outcome: 'trim-failure'
      error: string
    }

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

/** Outcome of the mandatory boundary-QA pass for a single split clip. */
export type QaStatus = 'clean' | 'auto_fixed' | 'flagged'

export interface ClipQaResult {
  label: string
  bucket: BucketType
  /** Current clip path (changes after each auto-recut). */
  path: string
  /** Path produced by the original split, before any recut. */
  originalPath: string
  sourcePath: string
  /** Source-relative bounds (seconds) the current clip was cut from. */
  sourceStart: number
  sourceEnd: number
  duration: number
  status: QaStatus
  recutCount: number
  confidence: number
  leadingLeak: Leak | null
  trailingLeak: Leak | null
}

export interface BoundaryQaReport {
  clips: ClipQaResult[]
  cleanCount: number
  autoFixedCount: number
  flaggedCount: number
}

export interface TemplateLayout {
  titleText: { x: number; y: number }
  subtitles: { x: number; y: number }
  media: { x: number; y: number }
}
