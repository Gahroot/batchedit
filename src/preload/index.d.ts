import { ElectronAPI } from '@electron-toolkit/preload'

type Platform = 'tiktok' | 'reels' | 'shorts' | 'universal'
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
  trimVideoReencode: (videoPath: string, outputDir: string | null, startTime: number, endTime: number) => Promise<string>
  detectLeadingSilence: (videoPath: string) => Promise<number>
  trimLeadingSilence: (videoPath: string, outputDir?: string) => Promise<{ outputPath: string; trimmedSeconds: number }>
  generateHookText: (apiKey: string, transcript: string) => Promise<string>
  saveProject: (projectData: string) => Promise<string | null>
  loadProject: () => Promise<string | null>
  getSafeZone: (platform: Platform) => Promise<SafeZoneRect>
  getDeadZones: (platform: Platform) => Promise<PlatformDeadZones>
  getElementPlacement: (platform: Platform, element: ElementType) => Promise<SafeZoneRect>
  clampToSafeZone: (rect: SafeZoneRect, platform: Platform) => Promise<SafeZoneRect>
  isInsideSafeZone: (rect: SafeZoneRect, platform: Platform) => Promise<boolean>
  toAssMargins: (rect: SafeZoneRect) => Promise<{ MarginL: number; MarginR: number; MarginV: number }>
  getAllPlatforms: () => Promise<Record<Platform, PlatformSafeZone>>
  renderBatch: (jobs: RenderJob[]) => Promise<RenderProgress[]>
  cancelRender: (batchId?: string) => Promise<boolean>
  onRenderProgress: (callback: (progress: RenderProgress[]) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
