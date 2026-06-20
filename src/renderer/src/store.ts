import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import { DEFAULT_AGENT_MODEL_ID } from './agent-models'
import type { BucketType, ClipQaResult, Platform, TemplateLayout, WordChunk } from '../../shared/types'

export type { BucketType, ClipQaResult, Platform, TemplateLayout, WordChunk }

export interface Clip {
  id: string
  path: string
  name: string
  duration: number
  thumbnail?: string
  transcript?: WordChunk[]
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
  source: 'caption' | 'render' | 'hooktext'
  clipName: string
  message: string
}

export type AgentEvent = Record<string, unknown> & { type?: string; runId?: string }

function qaKey(clip: ClipQaResult): string {
  return `${clip.bucket}:${clip.label}`
}

function upsertQaClip(clips: ClipQaResult[], next: ClipQaResult): ClipQaResult[] {
  const key = qaKey(next)
  const index = clips.findIndex((c) => qaKey(c) === key)
  if (index === -1) return [...clips, next]
  const copy = clips.slice()
  copy[index] = next
  return copy
}

/** Fold a raw agent event into the QA-clip list (reset/upsert/replace). */
function nextQaClips(clips: ClipQaResult[], event: AgentEvent): ClipQaResult[] {
  if (event.type === 'qa_started') return []
  if (event.type === 'qa_clip' && event.clip) return upsertQaClip(clips, event.clip as ClipQaResult)
  if (event.type === 'qa_complete' && event.report && typeof event.report === 'object') {
    const report = event.report as { clips?: ClipQaResult[] }
    if (Array.isArray(report.clips)) return report.clips
  }
  return clips
}

export interface ReviewPrompt {
  reviewId: string
  reason: string
  attach?: unknown
}

export interface ReviewResponse {
  approved: boolean
  edits?: unknown
}

export type LoadProjectResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'corrupt' }

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
  // Xiaomi MiMo (OpenAI-compatible Token Plan endpoint)
  xiaomiApiKey: string
  setXiaomiApiKey: (key: string) => void
  // Selected agent model id (see AGENT_MODELS)
  agentModelId: string
  setAgentModelId: (id: string) => void
  hookTextProgress: HookTextProgress | null
  setHookTextProgress: (progress: HookTextProgress | null) => void

  // Template layout
  templateLayout: TemplateLayout
  setTemplateLayout: (layout: TemplateLayout) => void

  // Target platform for safe zones
  targetPlatform: Platform
  setTargetPlatform: (platform: Platform) => void

  // Media overlays (proof images for meat/CTA segments)
  mediaOverlays: { meat: string | null; cta: string | null }
  setMediaOverlay: (bucket: 'meat' | 'cta', path: string | null) => void

  // Whisper model
  whisperModel: string
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

  // Agent state
  agentRunning: boolean
  agentEvents: AgentEvent[]
  agentReviewPrompt: ReviewPrompt | null
  /** Live boundary-QA results, keyed by `${bucket}:${label}`, newest path wins. */
  qaClips: ClipQaResult[]
  appendAgentEvent: (event: AgentEvent) => void
  setAgentReviewPrompt: (prompt: ReviewPrompt | null) => void
  respondToReview: (response: ReviewResponse) => void
  applyQaRecut: (clip: ClipQaResult, startDeltaMs: number, endDeltaMs: number) => Promise<void>
  /** Accept a QA clip into its bucket (using its current, possibly recut, path) and clear it from the panel. */
  resolveQaClip: (clip: ClipQaResult) => void

  // Actions
  addClips: (bucket: BucketType, clips: Clip[]) => void
  removeClip: (bucket: BucketType, clipId: string) => void
  reorderClips: (bucket: BucketType, clips: Clip[]) => void
  setHookText: (clipId: string, text: string) => void
  setClipTranscript: (clipId: string, transcript: WordChunk[]) => void
  updateClipTranscriptWord: (clipId: string, wordIndex: number, newText: string) => void
  updateClipPath: (bucket: BucketType, clipId: string, newPath: string, newDuration: number, thumbnail?: string) => void
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

const RESOLUTIONS = {
  '9:16': { width: 1080, height: 1920, label: '9:16 Vertical (1080x1920)' },
  '16:9': { width: 1920, height: 1080, label: '16:9 Landscape (1920x1080)' },
  '1:1': { width: 1080, height: 1080, label: '1:1 Square (1080x1080)' },
  '4:5': { width: 1080, height: 1350, label: '4:5 Portrait (1080x1350)' }
}

export { RESOLUTIONS }

export const useStore = create<AppState>((set, get) => ({
  hooks: [],
  meats: [],
  ctas: [],
  hookTexts: {},
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
  geminiApiKey: localStorage.getItem('batchedit-gemini-key') || '',
  xiaomiApiKey: localStorage.getItem('batchedit-xiaomi-key') || '',
  agentModelId: localStorage.getItem('batchedit-agent-model') || DEFAULT_AGENT_MODEL_ID,
  hookTextProgress: null,
  targetPlatform: 'universal',
  setTargetPlatform: (platform) => set({ targetPlatform: platform }),
  templateLayout: {
    titleText: { x: 50, y: 12 },
    subtitles: { x: 50, y: 65 },
    media: { x: 50, y: 75 }
  },
  mediaOverlays: { meat: null, cta: null },
  whisperModel: localStorage.getItem('batchedit-whisper-model') || 'onnx-community/whisper-large-v3-turbo_timestamped',
  setWhisperModel: (model) => {
    localStorage.setItem('batchedit-whisper-model', model)
    set({ whisperModel: model })
  },
  captionOffsetMs: 0,
  setCaptionOffsetMs: (ms) => set({ captionOffsetMs: ms }),

  autoTrimSilence: false,
  setAutoTrimSilence: (enabled) => set({ autoTrimSilence: enabled }),

  errorLog: [],
  agentRunning: false,
  agentEvents: [],
  agentReviewPrompt: null,
  qaClips: [],

  setMediaOverlay: (bucket, path) =>
    set((state) => ({
      mediaOverlays: { ...state.mediaOverlays, [bucket]: path }
    })),

  setCaptionProgress: (progress) => set({ captionProgress: progress }),

  setCaptionStyle: (style) => set({ captionStyle: style }),

  setGeminiApiKey: (key) => {
    localStorage.setItem('batchedit-gemini-key', key)
    set({ geminiApiKey: key })
  },
  setXiaomiApiKey: (key) => {
    localStorage.setItem('batchedit-xiaomi-key', key)
    set({ xiaomiApiKey: key })
  },
  setAgentModelId: (id) => {
    localStorage.setItem('batchedit-agent-model', id)
    set({ agentModelId: id })
  },
  setHookTextProgress: (progress) => set({ hookTextProgress: progress }),
  setTemplateLayout: (layout) => set({ templateLayout: layout }),

  addError: (entry) =>
    set((state) => ({
      errorLog: [
        ...state.errorLog,
        { ...entry, id: uuidv4(), timestamp: Date.now() }
      ]
    })),

  clearErrors: () => set({ errorLog: [] }),

  appendAgentEvent: (event) =>
    set((state) => {
      const agentEvents = [...state.agentEvents, event].slice(-500)
      const eventType = event.type
      return {
        agentEvents,
        agentRunning: eventType === 'agent_started' ? true : eventType === 'agent_done' || eventType === 'agent_canceled' || eventType === 'error' || eventType === 'agent_failed' ? false : state.agentRunning,
        agentReviewPrompt: eventType === 'review_requested'
          ? { reviewId: String(event.reviewId), reason: String(event.reason), attach: event.attach }
          : state.agentReviewPrompt,
        qaClips: nextQaClips(state.qaClips, event)
      }
    }),

  applyQaRecut: async (clip, startDeltaMs, endDeltaMs) => {
    const updated = await window.api.agent.qaRecut({
      clipPath: clip.path,
      sourcePath: clip.sourcePath,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      bucket: clip.bucket,
      label: clip.label,
      startDeltaMs,
      endDeltaMs
    })
    set((state) => ({ qaClips: upsertQaClip(state.qaClips, updated) }))
  },

  resolveQaClip: (clip) =>
    set((state) => {
      const key = clip.bucket === 'hook' ? 'hooks' : clip.bucket === 'meat' ? 'meats' : 'ctas'
      const accepted: Clip = {
        id: uuidv4(),
        path: clip.path,
        name: clip.label,
        duration: clip.duration
      }
      // Guard against double-adding if this clip path is already in the bucket.
      const already = state[key].some((c) => c.path === clip.path)
      return {
        [key]: already ? state[key] : [...state[key], accepted],
        qaClips: state.qaClips.filter((c) => qaKey(c) !== qaKey(clip))
      }
    }),

  setAgentReviewPrompt: (prompt) => set({ agentReviewPrompt: prompt }),

  respondToReview: (response) => {
    const prompt = get().agentReviewPrompt
    if (!prompt) return
    window.api.agent.respondToReview(prompt.reviewId, response)
    set({ agentReviewPrompt: null })
  },

  addClips: (bucket, clips) =>
    set((state) => ({
      [bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas']: [
        ...state[bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'],
        ...clips
      ]
    })),

  removeClip: (bucket, clipId) =>
    set((state) => {
      const key = bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'
      return { [key]: state[key].filter((c) => c.id !== clipId) }
    }),

  reorderClips: (bucket, clips) =>
    set(() => ({
      [bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas']: clips
    })),

  setHookText: (clipId, text) =>
    set((state) => ({
      hookTexts: { ...state.hookTexts, [clipId]: text }
    })),

  setClipTranscript: (clipId, transcript) =>
    set((state) => {
      const update = (clips: Clip[]) =>
        clips.map((c) => (c.id === clipId ? { ...c, transcript } : c))
      return { hooks: update(state.hooks), meats: update(state.meats), ctas: update(state.ctas) }
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
      return { hooks: update(state.hooks), meats: update(state.meats), ctas: update(state.ctas) }
    }),

  updateClipPath: (bucket, clipId, newPath, newDuration, thumbnail) =>
    set((state) => {
      const key = bucket === 'hook' ? 'hooks' : bucket === 'meat' ? 'meats' : 'ctas'
      return {
        [key]: state[key].map((c) =>
          c.id === clipId
            ? { ...c, path: newPath, duration: newDuration, ...(thumbnail !== undefined && { thumbnail }) }
            : c
        )
      }
    }),

  setResolution: (resolution) =>
    set((state) => ({
      settings: { ...state.settings, resolution }
    })),

  setOutputDirectory: (dir) =>
    set((state) => ({
      settings: { ...state.settings, outputDirectory: dir }
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
    const project = {
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
    }
    return window.api.saveProject(JSON.stringify(project, null, 2))
  },

  loadProject: async () => {
    const data = await window.api.loadProject()
    if (!data) return { ok: false, reason: 'cancelled' }
    try {
      const project = JSON.parse(data)
      set({
        hooks: project.hooks || [],
        meats: project.meats || [],
        ctas: project.ctas || [],
        hookTexts: project.hookTexts || {},
        settings: project.settings || { resolution: RESOLUTIONS['9:16'], outputDirectory: null },
        captionStyle: project.captionStyle || CAPTION_PRESETS['hormozi-bold'],
        templateLayout: project.templateLayout || { titleText: { x: 50, y: 12 }, subtitles: { x: 50, y: 65 }, media: { x: 50, y: 75 } },
        targetPlatform: project.targetPlatform || 'universal',
        mediaOverlays: project.mediaOverlays || { meat: null, cta: null },
        autoTrimSilence: project.autoTrimSilence || false,
        captionOffsetMs: project.captionOffsetMs || 0,
        renderProgress: [],
        isRendering: false,
        errorLog: [],
        agentRunning: false,
        agentEvents: [],
        agentReviewPrompt: null,
        qaClips: []
      })
      return { ok: true }
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
      mediaOverlays: { meat: null, cta: null },
      renderProgress: [],
      isRendering: false,
      errorLog: [],
      agentRunning: false,
      agentEvents: [],
      agentReviewPrompt: null,
      qaClips: []
    })
}))
