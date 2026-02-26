import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // FFmpeg
  getMetadata: (filePath: string) => ipcRenderer.invoke('ffmpeg:getMetadata', filePath),
  extractAudio: (videoPath: string) => ipcRenderer.invoke('ffmpeg:extractAudio', videoPath),
  generateAss: (
    captions: { text: string; start: number; end: number }[],
    resolution: { width: number; height: number }
  ) => ipcRenderer.invoke('ffmpeg:generateAss', captions, resolution),
  generateCombinedAss: (data: {
    segments: {
      wordChunks: { text: string; start: number; end: number }[]
      offsetMs: number
      durationMs?: number
    }[]
    resolution: { width: number; height: number }
    captionStyle?: {
      fontName: string; fontFile: string; fontSize: number
      primaryColor: string; highlightColor: string; outlineColor: string; backColor: string
      outline: number; shadow: number; borderStyle: number; wordsPerLine: number
      animation: 'karaoke-fill' | 'word-pop' | 'fade-in' | 'glow'
    }
    captionPosition?: { x: number; y: number }
  }) => ipcRenderer.invoke('ffmpeg:generateCombinedAss', data),

  getThumbnail: (videoPath: string) => ipcRenderer.invoke('ffmpeg:thumbnail', videoPath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readAudioBuffer: (wavPath: string) => ipcRenderer.invoke('ffmpeg:readAudioBuffer', wavPath),

  splitVideo: (
    videoPath: string,
    segments: Array<{ label: string; bucket: string; startTime: number; endTime: number }>,
    outputDir: string | null
  ) => ipcRenderer.invoke('ffmpeg:splitVideo', videoPath, segments, outputDir),

  // Silence trimming
  detectLeadingSilence: (videoPath: string) =>
    ipcRenderer.invoke('ffmpeg:detectLeadingSilence', videoPath),
  trimLeadingSilence: (videoPath: string, outputDir?: string) =>
    ipcRenderer.invoke('ffmpeg:trimLeadingSilence', videoPath, outputDir),

  // AI
  generateHookText: (apiKey: string, transcript: string) =>
    ipcRenderer.invoke('ai:generateHookText', apiKey, transcript),

  // Rendering
  renderBatch: (jobs: any[]) => ipcRenderer.invoke('render:batch', jobs),
  onRenderProgress: (callback: (progress: any[]) => void) => {
    const handler = (_event: any, progress: any[]) => callback(progress)
    ipcRenderer.on('render:progress', handler)
    return () => ipcRenderer.removeListener('render:progress', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
