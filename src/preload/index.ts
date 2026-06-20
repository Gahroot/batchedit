import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // Shell
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
  openPath: (fullPath: string) => ipcRenderer.invoke('shell:openPath', fullPath),

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
  releaseTempFile: (filePath: string) => ipcRenderer.invoke('ffmpeg:releaseTempFile', filePath),

  splitVideo: (
    videoPath: string,
    segments: Array<{ label: string; bucket: string; startTime: number; endTime: number }>,
    outputDir: string | null
  ) => ipcRenderer.invoke('ffmpeg:splitVideo', videoPath, segments, outputDir),

  // Re-encoding trim (frame-accurate)
  trimVideoReencode: (videoPath: string, outputDir: string | null, startTime: number, endTime: number) =>
    ipcRenderer.invoke('ffmpeg:trimVideoReencode', videoPath, outputDir, startTime, endTime),

  // Silence trimming
  detectLeadingSilence: (videoPath: string) =>
    ipcRenderer.invoke('ffmpeg:detectLeadingSilence', videoPath),
  trimLeadingSilence: (videoPath: string, outputDir?: string) =>
    ipcRenderer.invoke('ffmpeg:trimLeadingSilence', videoPath, outputDir),

  // AI
  generateHookText: (apiKey: string, transcript: string) =>
    ipcRenderer.invoke('ai:generateHookText', apiKey, transcript),

  // Project save/load
  saveProject: (projectData: string) => ipcRenderer.invoke('project:save', projectData),
  loadProject: () => ipcRenderer.invoke('project:load'),

  // Safe zones
  getSafeZone: (platform: string) => ipcRenderer.invoke('safezones:getSafeZone', platform),
  getDeadZones: (platform: string) => ipcRenderer.invoke('safezones:getDeadZones', platform),
  getElementPlacement: (platform: string, element: string) => ipcRenderer.invoke('safezones:getPlacement', platform, element),
  clampToSafeZone: (rect: { x: number; y: number; width: number; height: number }, platform: string) => ipcRenderer.invoke('safezones:clamp', rect, platform),
  isInsideSafeZone: (rect: { x: number; y: number; width: number; height: number }, platform: string) => ipcRenderer.invoke('safezones:isInside', rect, platform),
  toAssMargins: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('safezones:toAssMargins', rect),
  getAllPlatforms: () => ipcRenderer.invoke('safezones:getAllPlatforms'),

  // Rendering
  renderBatch: (jobs: any[]) => ipcRenderer.invoke('render:batch', jobs),
  cancelRender: (batchId?: string) => ipcRenderer.invoke('render:cancel', batchId),
  onRenderProgress: (callback: (progress: any[]) => void) => {
    const handler = (_event: any, progress: any[]) => callback(progress)
    ipcRenderer.on('render:progress', handler)
    return () => ipcRenderer.removeListener('render:progress', handler)
  },

  agent: {
    start: (opts: { sourcePath: string; provider?: string; model?: string; apiKey?: string }) => ipcRenderer.invoke('agent:start', opts),
    cancel: (runId: string) => ipcRenderer.invoke('agent:cancel', runId),
    respondToReview: (reviewId: string, response: { approved: boolean; edits?: unknown }) => ipcRenderer.invoke('agent:reviewReply', reviewId, response),
    qaRecut: (params: unknown) => ipcRenderer.invoke('agent:qaRecut', params),
    onEvent: (callback: (evt: unknown) => void) => {
      const handler = (_event: any, evt: unknown) => callback(evt)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
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

  agentBridge: {
    onTranscribeRequest: (callback: (req: { id: string; payload: { path: string; model?: string } }) => void) => {
      const handler = (_event: any, req: { id: string; payload: { path: string; model?: string } }) => callback(req)
      ipcRenderer.on('agent:transcribe', handler)
      return () => ipcRenderer.removeListener('agent:transcribe', handler)
    },
    onTranscribeCancel: (callback: (req: { id: string }) => void) => {
      const handler = (_event: any, req: { id: string }) => callback(req)
      ipcRenderer.on('agent:transcribe:cancel', handler)
      return () => ipcRenderer.removeListener('agent:transcribe:cancel', handler)
    },
    replyTranscribe: (id: string, result: unknown) => ipcRenderer.send('agent:renderer-rpc:reply', { id, result }),
    replyTranscribeError: (id: string, error: string) => ipcRenderer.send('agent:renderer-rpc:reply', { id, error }),
    replyStoreSnapshot: (id: string, result: unknown) => ipcRenderer.send('agent:renderer-rpc:reply', { id, result }),
    onStoreSnapshotRequest: (callback: (req: { id: string; payload: unknown }) => void) => {
      const handler = (_event: any, req: { id: string; payload: unknown }) => callback(req)
      ipcRenderer.on('agent:getStoreSnapshot', handler)
      return () => ipcRenderer.removeListener('agent:getStoreSnapshot', handler)
    },
    onApplyAction: (callback: (action: { runId?: string; type: string; payload: unknown }) => void) => {
      const handler = (_event: any, action: { runId?: string; type: string; payload: unknown }) => callback(action)
      ipcRenderer.on('agent:applyAction', handler)
      return () => ipcRenderer.removeListener('agent:applyAction', handler)
    },
    onStartRender: (callback: (request: { jobId: string }) => void) => {
      const handler = (_event: any, request: { jobId: string }) => callback(request)
      ipcRenderer.on('agent:startRender', handler)
      return () => ipcRenderer.removeListener('agent:startRender', handler)
    },
    sendRenderProgress: (progress: unknown) => ipcRenderer.send('agent:renderProgress', progress)
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
