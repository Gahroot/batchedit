import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { BucketType, ClipQaResult, Platform, TemplateLayout, WordChunk } from '../../shared/types'
import {
  resolveWhisperModel,
  WASM_DEFAULT_WHISPER_MODEL,
  type WhisperDevice,
  type WhisperDeviceState
} from './lib/whisper-config'

export type { BucketType, ClipQaResult, Platform, TemplateLayout, WordChunk }

export interface Clip {
  id: string
  path: string
  name: string
  duration: number
  thumbnail?: string
  transcript?: WordChunk[]
  /** Set when the source file is missing on disk (moved/renamed since save). */
  missing?: boolean
}

export interface ProjectSettings {
  resolution: { width: number; height: number; label: string }
  outputDirectory: string | null
}

export type RenderProgressStatus =
  | 'queued'
  | 'normalizing'
  | 'concatenating'
  | 'overlaying'
  | 'rendering'
  | 'done'
  | 'error'
  | 'canceled'

export interface RenderProgress {
  jobId: string
  percent: number
  status: RenderProgressStatus
  error?: string
  /** Raw FFmpeg/ffprobe output, kept for bug reports (e.g. behind a Copy affordance). */
  errorDetail?: string
}

export interface Combo {
  id: string
  hook: Clip
  meat: Clip
  cta: Clip
}

export interface CaptionProgress {
  stage: 'idle' | 'loading-model' | 'transcribing' | 'generating-ass' | 'done'
  currentClip: string
  completedClips: number
  totalClips: number
}

export interface HookTextProgress {
  stage: 'loading-model' | 'transcribing' | 'generating'
  currentClip: string
  completedClips: number
  totalClips: number
}

export interface ErrorLogEntry {
  id: string
  timestamp: number
  source: 'caption' | 'render' | 'hooktext' | 'ingest'
  clipName: string
  message: string
  /** Raw technical detail (e.g. FFmpeg stderr) kept for bug reports / Copy. */
  detail?: string
}

export type LoadProjectResult =
  | { ok: true; missingCount: number }
  | { ok: false; reason: 'cancelled' | 'corrupt' }

export type MediaOverlayBucket = 'meat' | 'cta'
export type MediaOverlays = Record<MediaOverlayBucket, string | null>
export type MissingMediaOverlays = Record<MediaOverlayBucket, boolean>

export type CaptionAnimation = 'karaoke-fill' | 'word-pop' | 'fade-in' | 'glow'

export interface CaptionStyle {
  id: string
  label: string
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
  animation: CaptionAnimation
}


export const CAPTION_PRESETS: Record<string, CaptionStyle> = {
  'hormozi-bold': {
    id: 'hormozi-bold', label: 'Hormozi Bold', fontName: 'Montserrat', fontFile: 'Montserrat-Bold.ttf',
    fontSize: 0.07, primaryColor: '#FFFFFF', highlightColor: '#00FF00', outlineColor: '#000000',
    backColor: '#80000000', outline: 4, shadow: 2, borderStyle: 1, wordsPerLine: 2, animation: 'word-pop'
  },
  'tiktok-glow': {
    id: 'tiktok-glow', label: 'TikTok Glow', fontName: 'Poppins', fontFile: 'Poppins-Bold.ttf',
    fontSize: 0.06, primaryColor: '#FFFFFF', highlightColor: '#00FFFF', outlineColor: '#FF00FF',
    backColor: '#00000000', outline: 2, shadow: 0, borderStyle: 1, wordsPerLine: 3, animation: 'glow'
  },
  'reels-clean': {
    id: 'reels-clean', label: 'Reels Clean', fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
    fontSize: 0.04, primaryColor: '#FFFFFF', highlightColor: '#FFFFFF', outlineColor: '#000000',
    backColor: '#C8191919', outline: 0, shadow: 0, borderStyle: 3, wordsPerLine: 6, animation: 'fade-in'
  },
  'classic-karaoke': {
    id: 'classic-karaoke', label: 'Classic Karaoke', fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
    fontSize: 0.05, primaryColor: '#FFFFFF', highlightColor: '#FFFF00', outlineColor: '#000000',
    backColor: '#80000000', outline: 3, shadow: 1, borderStyle: 1, wordsPerLine: 4, animation: 'karaoke-fill'
  },
  'bold-clean': {
    id: 'bold-clean', label: 'Bold Clean', fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
    fontSize: 0.055, primaryColor: '#FFFFFF', highlightColor: '#FFFFFF', outlineColor: '#000000',
    backColor: '#00000000', outline: 0, shadow: 4, borderStyle: 1, wordsPerLine: 2, animation: 'word-pop'
  },
  'soft-highlight': {
    id: 'soft-highlight', label: 'Soft Highlight', fontName: 'Open Sans', fontFile: 'OpenSans-Bold.ttf',
    fontSize: 0.05, primaryColor: '#FFFFFF', highlightColor: '#C4B5FD', outlineColor: '#000000',
    backColor: '#80000000', outline: 2, shadow: 0, borderStyle: 1, wordsPerLine: 4, animation: 'karaoke-fill'
  },
  'streaming-sub': {
    id: 'streaming-sub', label: 'Streaming Sub', fontName: 'Roboto', fontFile: 'Roboto-Bold.ttf',
    fontSize: 0.035, primaryColor: '#FFFFFF', highlightColor: '#FFFFFF', outlineColor: '#000000',
    backColor: '#E0000000', outline: 0, shadow: 0, borderStyle: 3, wordsPerLine: 7, animation: 'fade-in'
  },
  'minimal-fade': {
    id: 'minimal-fade', label: 'Minimal Fade', fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
    fontSize: 0.045, primaryColor: '#FFFFFF', highlightColor: '#FFFFFF', outlineColor: '#000000',
    backColor: '#00000000', outline: 0, shadow: 2, borderStyle: 1, wordsPerLine: 5, animation: 'fade-in'
  },
}

interface AppState {
  // Buckets
  hooks: Clip[]
  meats: Clip[]
  ctas: Clip[]

  // Text overlays for hooks (keyed by clip ID)
  hookTexts: Record<string, string>

  // Project file state
  activeProjectPath: string | null
  isDirty: boolean

  // Project settings
  settings: ProjectSettings

  // Render state
  renderProgress: RenderProgress[]
  isRendering: boolean
  jobIdToComboId: Record<string, string>
  setJobIdToComboId: (map: Record<string, string>) => void

  // Caption state
  captionProgress: CaptionProgress | null
  setCaptionProgress: (progress: CaptionProgress | null) => void

  // Caption style
  captionStyle: CaptionStyle
  setCaptionStyle: (style: CaptionStyle) => void

  // Gemini AI
  geminiApiKey: string
  setGeminiApiKey: (key: string) => void
  hookTextProgress: HookTextProgress | null
  setHookTextProgress: (progress: HookTextProgress | null) => void

  // Template layout
  templateLayout: TemplateLayout
  setTemplateLayout: (layout: TemplateLayout) => void

  // Target platform for safe zones
  targetPlatform: Platform
  setTargetPlatform: (platform: Platform) => void

  // Media overlays (proof images for meat/CTA segments)
  mediaOverlays: MediaOverlays
  missingMediaOverlays: MissingMediaOverlays
  setMediaOverlay: (bucket: MediaOverlayBucket, path: string | null) => void

  // Whisper capability and model preference
  whisperDevice: WhisperDeviceState
  whisperModel: string
  preferredWhisperModel: string | null
  initializeWhisperDevice: (device: WhisperDevice) => void
  setWhisperModel: (model: string) => void

  // Caption offset
  captionOffsetMs: number
  setCaptionOffsetMs: (ms: number) => void

  // Auto trim silence
  autoTrimSilence: boolean
  setAutoTrimSilence: (enabled: boolean) => void

  // Error log
  errorLog: ErrorLogEntry[]
  addError: (entry: Omit<ErrorLogEntry, 'id' | 'timestamp'>) => void
  clearErrors: () => void

  // Actions
  addClips: (bucket: BucketType, clips: Clip[]) => void
  removeClip: (bucket: BucketType, clipId: string) => void
  reorderClips: (bucket: BucketType, clips: Clip[]) => void
  setHookText: (clipId: string, text: string) => void
  setClipTranscript: (clipId: string, transcript: WordChunk[]) => void
  updateClipTranscriptWord: (clipId: string, wordIndex: number, newText: string) => void
  updateClipPath: (bucket: BucketType, clipId: string, newPath: string, newDuration: number, thumbnail?: string) => void
  markClipPathsMissing: (paths: string[]) => void
  setResolution: (resolution: ProjectSettings['resolution']) => void
  setOutputDirectory: (dir: string) => void
  setRenderProgress: (progress: RenderProgress[]) => void
  setIsRendering: (rendering: boolean) => void
  getTotalCombinations: () => number
  getCombos: () => Combo[]
  saveProject: () => Promise<string | null>
  loadProject: () => Promise<LoadProjectResult>
  reset: () => void
}

/** Default positions for template elements, as percentages of the 1080×1920 canvas. */
export const DEFAULT_TEMPLATE_LAYOUT: TemplateLayout = {
  titleText: { x: 50, y: 12 },
  subtitles: { x: 50, y: 65 },
  media: { x: 50, y: 75 }
}

const RESOLUTIONS = {
  '9:16': { width: 1080, height: 1920, label: '9:16 Vertical (1080x1920)' },
  '16:9': { width: 1920, height: 1080, label: '16:9 Landscape (1920x1080)' },
  '1:1': { width: 1080, height: 1080, label: '1:1 Square (1080x1080)' },
  '4:5': { width: 1080, height: 1350, label: '4:5 Portrait (1080x1350)' }
}

export { RESOLUTIONS }

function readLocalSetting(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeLocalSetting(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // Settings still apply for this session when persistent storage is unavailable.
  }
}

const savedWhisperModel = readLocalSetting('batchedit-whisper-model')

function serializeProject(state: AppState): string {
  return JSON.stringify({
    version: 1,
    hooks: state.hooks,
    meats: state.meats,
    ctas: state.ctas,
    hookTexts: state.hookTexts,
    settings: state.settings,
    captionStyle: state.captionStyle,
    templateLayout: state.templateLayout,
    targetPlatform: state.targetPlatform,
    mediaOverlays: state.mediaOverlays,
    autoTrimSilence: state.autoTrimSilence,
    captionOffsetMs: state.captionOffsetMs
  }, null, 2)
}

export const useStore = create<AppState>((set, get) => ({
  hooks: [],
  meats: [],
  ctas: [],
  hookTexts: {},
  activeProjectPath: null,
  isDirty: false,
  settings: {
    resolution: RESOLUTIONS['9:16'],
    outputDirectory: null
  },
  renderProgress: [],
  isRendering: false,
  jobIdToComboId: {},
  setJobIdToComboId: (map) => set({ jobIdToComboId: map }),
  captionProgress: null,
  captionStyle: CAPTION_PRESETS['hormozi-bold'],
  geminiApiKey: readLocalSetting('batchedit-gemini-key') || '',
  hookTextProgress: null,
  targetPlatform: 'universal',
  setTargetPlatform: (platform) => set({ targetPlatform: platform, isDirty: true }),
  templateLayout: DEFAULT_TEMPLATE_LAYOUT,
  mediaOverlays: { meat: null, cta: null },
  missingMediaOverlays: { meat: false, cta: false },
  whisperDevice: 'detecting',
  whisperModel: WASM_DEFAULT_WHISPER_MODEL,
  preferredWhisperModel: savedWhisperModel,
  initializeWhisperDevice: (device) =>
    set((state) => ({
      whisperDevice: device,
      whisperModel: resolveWhisperModel(device, state.preferredWhisperModel)
    })),
  setWhisperModel: (model) => {
    writeLocalSetting('batchedit-whisper-model', model)
    set({ whisperModel: model, preferredWhisperModel: model })
  },
  captionOffsetMs: 0,
  setCaptionOffsetMs: (ms) => set({ captionOffsetMs: ms, isDirty: true }),

  autoTrimSilence: false,
  setAutoTrimSilence: (enabled) => set({ autoTrimSilence: enabled, isDirty: true }),

  errorLog: [],

  setMediaOverlay: (bucket, path) =>
    set((state) => ({
      mediaOverlays: { ...state.mediaOverlays, [bucket]: path },
      missingMediaOverlays: { ...state.missingMediaOverlays, [bucket]: false },
      isDirty: true
    })),

  setCaptionProgress: (progress) => set({ captionProgress: progress }),

  setCaptionStyle: (style) => set({ captionStyle: style, isDirty: true }),

  setGeminiApiKey: (key) => {
    writeLocalSetting('batchedit-gemini-key', key)
    set({ geminiApiKey: key })
  },
  setHookTextProgress: (progress) => set({ hookTextProgress: progress }),
  setTemplateLayout: (layout) => set({ templateLayout: layout, isDirty: true }),

  addError: (entry) =>
    set((state) => ({
      errorLog: [
        ...state.errorLog,
        { ...entry, id: uuidv4(), timestamp: Date.now() }
      ]
    })),

  clearErrors: () => set({ errorLog: [] }),


  addClips: (bucket, clips) =>
    set((state) => ({
      [bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas']: [
        ...state[bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'],
        ...clips
      ],
      isDirty: true
    })),

  removeClip: (bucket, clipId) =>
    set((state) => {
      const key = bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'
      return { [key]: state[key].filter((c) => c.id !== clipId), isDirty: true }
    }),

  reorderClips: (bucket, clips) =>
    set(() => ({
      [bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas']: clips,
      isDirty: true
    })),

  setHookText: (clipId, text) =>
    set((state) => ({
      hookTexts: { ...state.hookTexts, [clipId]: text },
      isDirty: true
    })),

  setClipTranscript: (clipId, transcript) =>
    set((state) => {
      const update = (clips: Clip[]) =>
        clips.map((c) => (c.id === clipId ? { ...c, transcript } : c))
      return { hooks: update(state.hooks), meats: update(state.meats), ctas: update(state.ctas), isDirty: true }
    }),

  updateClipTranscriptWord: (clipId, wordIndex, newText) =>
    set((state) => {
      const update = (clips: Clip[]) =>
        clips.map((c) => {
          if (c.id !== clipId || !c.transcript) return c
          const transcript = c.transcript.map((w, i) =>
            i === wordIndex ? { ...w, text: newText } : w
          )
          return { ...c, transcript }
        })
      return { hooks: update(state.hooks), meats: update(state.meats), ctas: update(state.ctas), isDirty: true }
    }),

  updateClipPath: (bucket, clipId, newPath, newDuration, thumbnail) =>
    set((state) => {
      const key = bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'
      return {
        [key]: state[key].map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                path: newPath,
                duration: newDuration,
                missing: false,
                ...(thumbnail !== undefined && { thumbnail })
              }
            : clip
        ),
        isDirty: true
      }
    }),

  markClipPathsMissing: (paths) =>
    set((state) => {
      const missingPaths = new Set(paths)
      const markMissing = (clips: Clip[]): Clip[] =>
        clips.map((clip) => missingPaths.has(clip.path) ? { ...clip, missing: true } : clip)
      return {
        hooks: markMissing(state.hooks),
        meats: markMissing(state.meats),
        ctas: markMissing(state.ctas)
      }
    }),

  setResolution: (resolution) =>
    set((state) => ({
      settings: { ...state.settings, resolution },
      isDirty: true
    })),

  setOutputDirectory: (dir) =>
    set((state) => ({
      settings: { ...state.settings, outputDirectory: dir },
      isDirty: true
    })),

  setRenderProgress: (progress) => set({ renderProgress: progress }),
  setIsRendering: (rendering) => set({ isRendering: rendering }),

  getTotalCombinations: () => {
    const { hooks, meats, ctas } = get()
    if (hooks.length === 0 || meats.length === 0 || ctas.length === 0) return 0
    return hooks.length * meats.length * ctas.length
  },

  getCombos: () => {
    const { hooks, meats, ctas } = get()
    const combos: Combo[] = []
    for (const hook of hooks) {
      for (const meat of meats) {
        for (const cta of ctas) {
          combos.push({
            id: `${hook.id}__${meat.id}__${cta.id}`,
            hook,
            meat,
            cta
          })
        }
      }
    }
    return combos
  },

  saveProject: async () => {
    const state = get()
    const activeProjectPath = state.activeProjectPath
    const projectData = serializeProject(state)
    const savedPath = await window.api.saveProject(projectData, activeProjectPath)
    if (typeof savedPath !== 'string' || savedPath.length === 0) return null

    const currentState = get()
    if (currentState.activeProjectPath !== activeProjectPath) return null
    set({
      activeProjectPath: savedPath,
      isDirty: serializeProject(currentState) !== projectData
    })
    return savedPath
  },

  loadProject: async () => {
    const loadedFile = await window.api.loadProject()
    if (!loadedFile) return { ok: false, reason: 'cancelled' }
    if (typeof loadedFile.path !== 'string' || typeof loadedFile.data !== 'string') {
      return { ok: false, reason: 'corrupt' }
    }
    try {
      const project = JSON.parse(loadedFile.data)
      const hooks: Clip[] = project.hooks || []
      const meats: Clip[] = project.meats || []
      const ctas: Clip[] = project.ctas || []
      const mediaOverlays: MediaOverlays = {
        meat: typeof project.mediaOverlays?.meat === 'string' ? project.mediaOverlays.meat : null,
        cta: typeof project.mediaOverlays?.cta === 'string' ? project.mediaOverlays.cta : null
      }

      // Check every persisted media dependency before it can reach the render pipeline.
      const clipPaths = [...hooks, ...meats, ...ctas].map((clip) => clip.path)
      const overlayPaths = [mediaOverlays.meat, mediaOverlays.cta].filter(
        (path): path is string => path !== null
      )
      const dependencyPaths = Array.from(new Set([...clipPaths, ...overlayPaths])).sort()
      let missingSet = new Set<string>()
      try {
        const { missing } = await window.api.pathsExist(dependencyPaths)
        missingSet = new Set(missing)
      } catch {
        // If the existence check fails, fall back to loading without flags.
      }
      const markMissing = (clips: Clip[]): Clip[] =>
        clips.map((clip) => ({ ...clip, missing: missingSet.has(clip.path) }))
      const missingMediaOverlays: MissingMediaOverlays = {
        meat: mediaOverlays.meat !== null && missingSet.has(mediaOverlays.meat),
        cta: mediaOverlays.cta !== null && missingSet.has(mediaOverlays.cta)
      }
      const missingClipCount = [...hooks, ...meats, ...ctas].filter((clip) =>
        missingSet.has(clip.path)
      ).length
      const missingOverlayCount = Number(missingMediaOverlays.meat) + Number(missingMediaOverlays.cta)
      const missingCount = missingClipCount + missingOverlayCount

      set({
        hooks: markMissing(hooks),
        meats: markMissing(meats),
        ctas: markMissing(ctas),
        hookTexts: project.hookTexts || {},
        activeProjectPath: loadedFile.path,
        isDirty: false,
        settings: project.settings || { resolution: RESOLUTIONS['9:16'], outputDirectory: null },
        captionStyle: project.captionStyle || CAPTION_PRESETS['hormozi-bold'],
        templateLayout: project.templateLayout || DEFAULT_TEMPLATE_LAYOUT,
        targetPlatform: project.targetPlatform || 'universal',
        mediaOverlays,
        missingMediaOverlays,
        autoTrimSilence: project.autoTrimSilence ?? false,
        captionOffsetMs: project.captionOffsetMs ?? 0,
        renderProgress: [],
        isRendering: false,
        errorLog: []
      })
      return { ok: true, missingCount }
    } catch {
      return { ok: false, reason: 'corrupt' }
    }
  },

  reset: () =>
    set({
      hooks: [],
      meats: [],
      ctas: [],
      hookTexts: {},
      activeProjectPath: null,
      isDirty: false,
      settings: { resolution: RESOLUTIONS['9:16'], outputDirectory: null },
      captionStyle: CAPTION_PRESETS['hormozi-bold'],
      templateLayout: DEFAULT_TEMPLATE_LAYOUT,
      targetPlatform: 'universal',
      mediaOverlays: { meat: null, cta: null },
      missingMediaOverlays: { meat: false, cta: false },
      autoTrimSilence: false,
      captionOffsetMs: 0,
      renderProgress: [],
      isRendering: false,
      jobIdToComboId: {},
      captionProgress: null,
      hookTextProgress: null,
      errorLog: []
    })
}))
