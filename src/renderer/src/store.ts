import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'

export interface Clip {
  id: string
  path: string
  name: string
  duration: number
  thumbnail?: string
}

export type BucketType = 'hook' | 'meat' | 'cta'

export interface ProjectSettings {
  resolution: { width: number; height: number; label: string }
  outputDirectory: string | null
}

export interface RenderProgress {
  jobId: string
  percent: number
  status: 'queued' | 'rendering' | 'done' | 'error'
  error?: string
}

export interface CaptionProgress {
  stage: 'idle' | 'loading-model' | 'transcribing' | 'generating-ass' | 'done'
  currentClip: string
  completedClips: number
  totalClips: number
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

  // Caption state
  captionProgress: CaptionProgress | null
  setCaptionProgress: (progress: CaptionProgress | null) => void

  // Actions
  addClips: (bucket: BucketType, clips: Clip[]) => void
  removeClip: (bucket: BucketType, clipId: string) => void
  reorderClips: (bucket: BucketType, clips: Clip[]) => void
  setHookText: (clipId: string, text: string) => void
  setResolution: (resolution: ProjectSettings['resolution']) => void
  setOutputDirectory: (dir: string) => void
  setRenderProgress: (progress: RenderProgress[]) => void
  setIsRendering: (rendering: boolean) => void
  getTotalCombinations: () => number
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
  captionProgress: null,

  setCaptionProgress: (progress) => set({ captionProgress: progress }),

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

  reset: () =>
    set({
      hooks: [],
      meats: [],
      ctas: [],
      hookTexts: {},
      renderProgress: [],
      isRendering: false
    })
}))
