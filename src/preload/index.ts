import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
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
    }[]
    resolution: { width: number; height: number }
    captionStyle?: { fontName: string; highlightColor: string }
  }) => ipcRenderer.invoke('ffmpeg:generateCombinedAss', data),

  getThumbnail: (videoPath: string) => ipcRenderer.invoke('ffmpeg:thumbnail', videoPath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readAudioBuffer: (wavPath: string) => ipcRenderer.invoke('ffmpeg:readAudioBuffer', wavPath),

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
