import { ElectronAPI } from '@electron-toolkit/preload'

interface VideoMetadata {
  duration: number
  width: number
  height: number
  codec: string
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
}

interface RenderProgress {
  jobId: string
  percent: number
  status: 'queued' | 'rendering' | 'done' | 'error'
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
  renderBatch: (jobs: RenderJob[]) => Promise<RenderProgress[]>
  onRenderProgress: (callback: (progress: RenderProgress[]) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
