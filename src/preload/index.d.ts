import { ElectronAPI } from '@electron-toolkit/preload'
import type { SourceFileSignaturesResult, TrimLeadingSilenceResult } from '../shared/types'

type Platform = 'tiktok' | 'reels' | 'shorts' | 'universal'
type BucketType = 'hook' | 'meat' | 'cta'
type QaStatus = 'clean' | 'auto_fixed' | 'flagged'
type ProjectCloseAction = 'save' | 'discard' | 'cancel'

interface BoundaryQaReport {
  clips: ClipQaResult[]
  cleanCount: number
  autoFixedCount: number
  flaggedCount: number
}

interface QaLeak {
  marker: string
  matchedTokens: string[]
  confidence: number
  suggestedTrimMs: number
}

interface ClipQaResult {
  label: string
  bucket: BucketType
  path: string
  originalPath: string
  sourcePath: string
  sourceStart: number
  sourceEnd: number
  duration: number
  status: QaStatus
  recutCount: number
  confidence: number
  leadingLeak: QaLeak | null
  trailingLeak: QaLeak | null
}

type ElementType = 'caption' | 'hook_text' | 'upper_third' | 'middle' | 'lower_third' | 'progress_bar' | 'logo' | 'comment_overlay' | 'full_frame'

interface SafeZoneRect {
  x: number
  y: number
  width: number
  height: number
}

interface PlatformDeadZones {
  top: number
  bottom: number
  left: number
  right: number
}

interface PlatformSafeZone {
  name: string
  safeRect: SafeZoneRect
  deadZones: PlatformDeadZones
  engagementButtonColumn: SafeZoneRect
}

interface VideoMetadata {
  duration: number
  width: number
  height: number
  codec: string
  fps: number
  audioCodec: string
}

interface CaptionEntry {
  text: string
  start: number
  end: number
}

interface RenderJob {
  id: string
  hookPath: string
  meatPath: string
  ctaPath: string
  outputPath: string
  textOverlay?: string
  hookDurationSec?: number
  captionsAssPath?: string
  autoResize?: boolean
  resolution: { width: number; height: number }
  titlePosition?: { x: number; y: number }
  mediaOverlays?: { meat?: string; cta?: string }
  mediaOverlayPosition?: { x: number; y: number }
  meatDurationSec?: number
  targetPlatform?: string
  captionData?: {
    clipWordChunks: Record<string, Array<{ text: string; start: number; end: number }>>
    captionStyle?: CaptionStyleOptions
    captionPosition?: { x: number; y: number }
    captionOffsetMs?: number
  }
}

type RenderProgressStatus =
  | 'queued'
  | 'normalizing'
  | 'concatenating'
  | 'overlaying'
  | 'rendering'
  | 'done'
  | 'error'
  | 'canceled'

interface RenderProgress {
  jobId: string
  percent: number
  status: RenderProgressStatus
  error?: string
}

interface CaptionStyleOptions {
  fontName: string
  fontFile: string
  fontSize: number
  primaryColor: string
  highlightColor: string
  outlineColor: string
  backColor: string
  outline: number
  shadow: number
  borderStyle: number
  wordsPerLine: number
  animation: 'karaoke-fill' | 'word-pop' | 'fade-in' | 'glow'
}


interface Api {
  openFiles: () => Promise<string[]>
  openImages: () => Promise<string[]>
  openDirectory: () => Promise<string | null>
  getDefaultOutputDirectory: () => Promise<string | null>
  showItemInFolder: (fullPath: string) => Promise<void>
  openPath: (fullPath: string) => Promise<string>
  getFFmpegReadiness: () => Promise<{ ready: boolean; issues: string[] }>
  getMetadata: (filePath: string) => Promise<VideoMetadata>
  extractAudio: (videoPath: string) => Promise<string>
  generateAss: (
    captions: CaptionEntry[],
    resolution: { width: number; height: number }
  ) => Promise<string>
  getThumbnail: (videoPath: string) => Promise<string>
  getPathForFile: (file: File) => string
  readAudioBuffer: (wavPath: string) => Promise<ArrayBuffer>
  releaseTempFile: (filePath: string) => Promise<void>
  generateCombinedAss: (data: {
    segments: Array<{
      wordChunks: Array<{ text: string; start: number; end: number }>
      offsetMs: number
      durationMs?: number
    }>
    resolution: { width: number; height: number }
    captionStyle?: CaptionStyleOptions
    captionPosition?: { x: number; y: number }
  }) => Promise<string>
  splitVideo(
    videoPath: string,
    segments: Array<{ label: string; bucket: string; startTime: number; endTime: number }>,
    outputDir: string | null
  ): Promise<Array<{ label: string; bucket: string; outputPath: string }>>
  onSplitProgress: (callback: (progress: { completed: number; total: number }) => void) => () => void
  trimVideoReencode: (videoPath: string, outputDir: string | null, startTime: number, endTime: number) => Promise<string>
  detectLeadingSilence: (videoPath: string) => Promise<number>
  trimLeadingSilence: (videoPath: string, outputDir?: string) => Promise<TrimLeadingSilenceResult>
  generateHookText: (apiKey: string, transcript: string) => Promise<string>
  saveProject: (projectData: string, activeProjectPath: string | null) => Promise<string | null>
  loadProject: () => Promise<{ path: string; data: string } | null>
  onProjectCloseRequested: (callback: () => void) => () => void
  chooseProjectCloseAction: (isDirty: boolean) => Promise<ProjectCloseAction>
  completeProjectClose: (shouldClose: boolean) => Promise<void>
  pathsExist: (paths: string[]) => Promise<{ missing: string[] }>
  getSourceFileSignatures: (paths: string[]) => Promise<SourceFileSignaturesResult>
  getSafeZone: (platform: Platform) => Promise<SafeZoneRect>
  getDeadZones: (platform: Platform) => Promise<PlatformDeadZones>
  getElementPlacement: (platform: Platform, element: ElementType) => Promise<SafeZoneRect>
  clampToSafeZone: (rect: SafeZoneRect, platform: Platform) => Promise<SafeZoneRect>
  isInsideSafeZone: (rect: SafeZoneRect, platform: Platform) => Promise<boolean>
  toAssMargins: (rect: SafeZoneRect) => Promise<{ MarginL: number; MarginR: number; MarginV: number }>
  getAllPlatforms: () => Promise<Record<Platform, PlatformSafeZone>>
  createRenderBatchDirectory: (outputDirectory: string) => Promise<string>
  renderBatch: (jobs: RenderJob[]) => Promise<RenderProgress[]>
  cancelRender: (batchId?: string) => Promise<boolean>
  onRenderProgress: (callback: (progress: RenderProgress[]) => void) => () => void
  qa: {
    runBoundaryQA: (params: {
      sourcePath: string
      clips: Array<{
        label: string
        bucket: BucketType
        path: string
        sourceStart: number
        sourceEnd: number
        duration: number
      }>
      windowMs?: number
    }) => Promise<BoundaryQaReport>
    recutClip: (params: {
      clipPath: string
      sourcePath: string
      sourceStart: number
      sourceEnd: number
      bucket: BucketType
      label: string
      startDeltaMs: number
      endDeltaMs: number
      model?: string
    }) => Promise<ClipQaResult>
  }
  qaBridge: {
    onTranscribeRequest: (cb: (req: { id: string; payload: { path: string; model?: string } }) => void) => () => void
    onTranscribeCancel: (cb: (req: { id: string }) => void) => () => void
    replyTranscribe: (id: string, result: { words: Array<{ text: string; start: number; end: number }>; full?: string; speechIntervals?: Array<{ start: number; end: number }> }) => void
    replyTranscribeError: (id: string, error: string) => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
