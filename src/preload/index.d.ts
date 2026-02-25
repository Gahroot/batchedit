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
}

interface RenderProgress {
  jobId: string
  percent: number
  status: 'queued' | 'rendering' | 'done' | 'error'
  error?: string
}

interface CaptionStyleOptions {
  fontName: string
  highlightColor: string
}

interface Api {
  openFiles: () => Promise<string[]>
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
    }>
    resolution: { width: number; height: number }
    captionStyle?: CaptionStyleOptions
  }) => Promise<string>
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
