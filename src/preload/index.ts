import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { PROJECT_CLOSE_CHANNELS, type ProjectCloseAction } from '../shared/project-close'
import type { TrimLeadingSilenceResult } from '../shared/types'

const api = {
  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  getDefaultOutputDirectory: () => ipcRenderer.invoke('app:getDefaultOutputDirectory'),

  // Shell
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
  openPath: (fullPath: string) => ipcRenderer.invoke('shell:openPath', fullPath),

  // FFmpeg
  getFFmpegReadiness: () => ipcRenderer.invoke('ffmpeg:getReadiness'),
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
  releaseTempFile: (filePath: string) => ipcRenderer.invoke('ffmpeg:releaseTempFile', filePath),

  splitVideo: (
    videoPath: string,
    segments: Array<{ label: string; bucket: string; startTime: number; endTime: number }>,
    outputDir: string | null
  ) => ipcRenderer.invoke('ffmpeg:splitVideo', videoPath, segments, outputDir),
  onSplitProgress: (callback: (progress: { completed: number; total: number }) => void) => {
    const handler = (_event: IpcRendererEvent, progress: { completed: number; total: number }) => callback(progress)
    ipcRenderer.on('split:progress', handler)
    return () => ipcRenderer.removeListener('split:progress', handler)
  },

  // Re-encoding trim (frame-accurate)
  trimVideoReencode: (videoPath: string, outputDir: string | null, startTime: number, endTime: number) =>
    ipcRenderer.invoke('ffmpeg:trimVideoReencode', videoPath, outputDir, startTime, endTime),

  // Silence trimming
  detectLeadingSilence: (videoPath: string) =>
    ipcRenderer.invoke('ffmpeg:detectLeadingSilence', videoPath),
  trimLeadingSilence: (videoPath: string, outputDir?: string): Promise<TrimLeadingSilenceResult> =>
    ipcRenderer.invoke('ffmpeg:trimLeadingSilence', videoPath, outputDir),

  // AI
  generateHookText: (apiKey: string, transcript: string) =>
    ipcRenderer.invoke('ai:generateHookText', apiKey, transcript),

  // Project save/load and guarded window close
  saveProject: (projectData: string, activeProjectPath: string | null) =>
    ipcRenderer.invoke('project:save', projectData, activeProjectPath),
  loadProject: () => ipcRenderer.invoke('project:load'),
  onProjectCloseRequested: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(PROJECT_CLOSE_CHANNELS.request, handler)
    return () => ipcRenderer.removeListener(PROJECT_CLOSE_CHANNELS.request, handler)
  },
  chooseProjectCloseAction: (isDirty: boolean): Promise<ProjectCloseAction> =>
    ipcRenderer.invoke(PROJECT_CLOSE_CHANNELS.chooseAction, isDirty),
  completeProjectClose: (shouldClose: boolean): Promise<void> =>
    ipcRenderer.invoke(PROJECT_CLOSE_CHANNELS.complete, shouldClose),

  // Filesystem
  pathsExist: (paths: string[]) => ipcRenderer.invoke('fs:pathsExist', paths),

  // Safe zones
  getSafeZone: (platform: string) => ipcRenderer.invoke('safezones:getSafeZone', platform),
  getDeadZones: (platform: string) => ipcRenderer.invoke('safezones:getDeadZones', platform),
  getElementPlacement: (platform: string, element: string) => ipcRenderer.invoke('safezones:getPlacement', platform, element),
  clampToSafeZone: (rect: { x: number; y: number; width: number; height: number }, platform: string) => ipcRenderer.invoke('safezones:clamp', rect, platform),
  isInsideSafeZone: (rect: { x: number; y: number; width: number; height: number }, platform: string) => ipcRenderer.invoke('safezones:isInside', rect, platform),
  toAssMargins: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('safezones:toAssMargins', rect),
  getAllPlatforms: () => ipcRenderer.invoke('safezones:getAllPlatforms'),

  // Rendering
  createRenderBatchDirectory: (outputDirectory: string): Promise<string> =>
    ipcRenderer.invoke('render:createBatchDirectory', outputDirectory),
  renderBatch: (jobs: any[]) => ipcRenderer.invoke('render:batch', jobs),
  cancelRender: (batchId?: string) => ipcRenderer.invoke('render:cancel', batchId),
  onRenderProgress: (callback: (progress: any[]) => void) => {
    const handler = (_event: IpcRendererEvent, progress: any[]) => callback(progress)
    ipcRenderer.on('render:progress', handler)
    return () => ipcRenderer.removeListener('render:progress', handler)
  },

  qa: {
    runBoundaryQA: (params: {
      sourcePath: string
      clips: Array<{
        label: string
        bucket: string
        path: string
        sourceStart: number
        sourceEnd: number
        duration: number
      }>
      windowMs?: number
    }) => ipcRenderer.invoke('qa:runBoundaryQA', params),
    recutClip: (params: {
      clipPath: string
      sourcePath: string
      sourceStart: number
      sourceEnd: number
      bucket: string
      label: string
      startDeltaMs: number
      endDeltaMs: number
      model?: string
    }) => ipcRenderer.invoke('qa:recutClip', params)
  },

  qaBridge: {
    onTranscribeRequest: (callback: (req: { id: string; payload: { path: string; model?: string } }) => void) => {
      const handler = (_event: IpcRendererEvent, req: { id: string; payload: { path: string; model?: string } }) => callback(req)
      ipcRenderer.on('qa:transcribe', handler)
      return () => ipcRenderer.removeListener('qa:transcribe', handler)
    },
    onTranscribeCancel: (callback: (req: { id: string }) => void) => {
      const handler = (_event: IpcRendererEvent, req: { id: string }) => callback(req)
      ipcRenderer.on('qa:transcribe:cancel', handler)
      return () => ipcRenderer.removeListener('qa:transcribe:cancel', handler)
    },
    replyTranscribe: (id: string, result: unknown) => ipcRenderer.send('qa:renderer-rpc:reply', { id, result }),
    replyTranscribeError: (id: string, error: string) => ipcRenderer.send('qa:renderer-rpc:reply', { id, error })
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
