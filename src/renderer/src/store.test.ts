import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStore, RESOLUTIONS, type Clip, type BucketType } from './store'
import {
  LARGE_WHISPER_MODEL,
  WASM_DEFAULT_WHISPER_MODEL,
  WEBGPU_DEFAULT_WHISPER_MODEL,
  WHISPER_DEVICE
} from './lib/whisper-config'

// Mock uuid to return predictable IDs
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-1234')
}))

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    path: '/path/to/clip.mp4',
    name: 'clip.mp4',
    duration: 5.0,
    ...overrides
  }
}

const saveProjectFile = vi.fn<
  (projectData: string, activeProjectPath: string | null) => Promise<string | null>
>()
const loadProjectFile = vi.fn<() => Promise<{ path: string; data: string } | null>>()
const pathsExist = vi.fn<(paths: string[]) => Promise<{ missing: string[] }>>()

describe('Zustand store', () => {
  beforeEach(() => {
    saveProjectFile.mockReset().mockResolvedValue(null)
    loadProjectFile.mockReset().mockResolvedValue(null)
    pathsExist.mockReset().mockResolvedValue({ missing: [] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveProject: saveProjectFile, loadProject: loadProjectFile, pathsExist }
    })
    useStore.getState().reset()
  })

  // -------------------------------------------------------------------------
  // getTotalCombinations
  // -------------------------------------------------------------------------
  describe('getTotalCombinations', () => {
    it('returns 0 when all buckets are empty', () => {
      expect(useStore.getState().getTotalCombinations()).toBe(0)
    })

    it('returns 0 when one bucket is empty (hooks empty)', () => {
      useStore.getState().addClips('meat', [makeClip({ id: 'm1' })])
      useStore.getState().addClips('cta', [makeClip({ id: 'c1' })])

      expect(useStore.getState().getTotalCombinations()).toBe(0)
    })

    it('returns 0 when one bucket is empty (meats empty)', () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'h1' })])
      useStore.getState().addClips('cta', [makeClip({ id: 'c1' })])

      expect(useStore.getState().getTotalCombinations()).toBe(0)
    })

    it('returns 0 when one bucket is empty (ctas empty)', () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'h1' })])
      useStore.getState().addClips('meat', [makeClip({ id: 'm1' })])

      expect(useStore.getState().getTotalCombinations()).toBe(0)
    })

    it('returns 1 for 1x1x1', () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'h1' })])
      useStore.getState().addClips('meat', [makeClip({ id: 'm1' })])
      useStore.getState().addClips('cta', [makeClip({ id: 'c1' })])

      expect(useStore.getState().getTotalCombinations()).toBe(1)
    })

    it('returns 24 for 2x3x4', () => {
      useStore
        .getState()
        .addClips('hook', [makeClip({ id: 'h1' }), makeClip({ id: 'h2' })])
      useStore
        .getState()
        .addClips('meat', [
          makeClip({ id: 'm1' }),
          makeClip({ id: 'm2' }),
          makeClip({ id: 'm3' })
        ])
      useStore
        .getState()
        .addClips('cta', [
          makeClip({ id: 'c1' }),
          makeClip({ id: 'c2' }),
          makeClip({ id: 'c3' }),
          makeClip({ id: 'c4' })
        ])

      expect(useStore.getState().getTotalCombinations()).toBe(24)
    })
  })

  // -------------------------------------------------------------------------
  // addClips
  // -------------------------------------------------------------------------
  describe('addClips', () => {
    it('appends clips to hook bucket', () => {
      const clip = makeClip({ id: 'h1' })
      useStore.getState().addClips('hook', [clip])

      expect(useStore.getState().hooks).toHaveLength(1)
      expect(useStore.getState().hooks[0]).toEqual(clip)
    })

    it('appends clips to meat bucket', () => {
      const clip = makeClip({ id: 'm1' })
      useStore.getState().addClips('meat', [clip])

      expect(useStore.getState().meats).toHaveLength(1)
      expect(useStore.getState().meats[0]).toEqual(clip)
    })

    it('appends clips to cta bucket', () => {
      const clip = makeClip({ id: 'c1' })
      useStore.getState().addClips('cta', [clip])

      expect(useStore.getState().ctas).toHaveLength(1)
      expect(useStore.getState().ctas[0]).toEqual(clip)
    })

    it('appends to existing clips, not replaces', () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'h1' })])
      useStore.getState().addClips('hook', [makeClip({ id: 'h2' })])

      expect(useStore.getState().hooks).toHaveLength(2)
      expect(useStore.getState().hooks[0].id).toBe('h1')
      expect(useStore.getState().hooks[1].id).toBe('h2')
    })

    it('appends multiple clips at once', () => {
      useStore
        .getState()
        .addClips('meat', [makeClip({ id: 'm1' }), makeClip({ id: 'm2' })])

      expect(useStore.getState().meats).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // removeClip
  // -------------------------------------------------------------------------
  describe('removeClip', () => {
    it('removes the specified clip by ID', () => {
      useStore
        .getState()
        .addClips('hook', [makeClip({ id: 'h1' }), makeClip({ id: 'h2' })])
      useStore.getState().removeClip('hook', 'h1')

      expect(useStore.getState().hooks).toHaveLength(1)
      expect(useStore.getState().hooks[0].id).toBe('h2')
    })

    it('leaves other clips unchanged after removal', () => {
      useStore
        .getState()
        .addClips('meat', [
          makeClip({ id: 'm1', name: 'first.mp4' }),
          makeClip({ id: 'm2', name: 'second.mp4' }),
          makeClip({ id: 'm3', name: 'third.mp4' })
        ])
      useStore.getState().removeClip('meat', 'm2')

      expect(useStore.getState().meats).toHaveLength(2)
      expect(useStore.getState().meats[0].id).toBe('m1')
      expect(useStore.getState().meats[1].id).toBe('m3')
    })

    it('does nothing when clip ID is not found', () => {
      useStore.getState().addClips('cta', [makeClip({ id: 'c1' })])
      useStore.getState().removeClip('cta', 'nonexistent')

      expect(useStore.getState().ctas).toHaveLength(1)
    })

    it('removes from the correct bucket only', () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'shared-id' })])
      useStore.getState().addClips('meat', [makeClip({ id: 'shared-id' })])
      useStore.getState().removeClip('hook', 'shared-id')

      expect(useStore.getState().hooks).toHaveLength(0)
      expect(useStore.getState().meats).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // reorderClips
  // -------------------------------------------------------------------------
  describe('reorderClips', () => {
    it('replaces bucket contents with new order', () => {
      const clip1 = makeClip({ id: 'h1', name: 'first.mp4' })
      const clip2 = makeClip({ id: 'h2', name: 'second.mp4' })
      useStore.getState().addClips('hook', [clip1, clip2])

      // Reorder: swap them
      useStore.getState().reorderClips('hook', [clip2, clip1])

      expect(useStore.getState().hooks[0].id).toBe('h2')
      expect(useStore.getState().hooks[1].id).toBe('h1')
    })

    it('can set bucket to empty array', () => {
      useStore.getState().addClips('meat', [makeClip({ id: 'm1' })])
      useStore.getState().reorderClips('meat', [])

      expect(useStore.getState().meats).toHaveLength(0)
    })

    it('replaces contents completely', () => {
      useStore
        .getState()
        .addClips('cta', [makeClip({ id: 'c1' }), makeClip({ id: 'c2' })])

      const newClip = makeClip({ id: 'c3' })
      useStore.getState().reorderClips('cta', [newClip])

      expect(useStore.getState().ctas).toHaveLength(1)
      expect(useStore.getState().ctas[0].id).toBe('c3')
    })
  })

  // -------------------------------------------------------------------------
  // setResolution / setOutputDirectory
  // -------------------------------------------------------------------------
  describe('setResolution', () => {
    it('updates the resolution in settings', () => {
      const newRes = { width: 1920, height: 1080, label: '16:9 Landscape' }
      useStore.getState().setResolution(newRes)

      expect(useStore.getState().settings.resolution).toEqual(newRes)
    })

    it('preserves other settings when changing resolution', () => {
      useStore.getState().setOutputDirectory('/my/output')
      useStore
        .getState()
        .setResolution({ width: 1080, height: 1080, label: '1:1 Square' })

      expect(useStore.getState().settings.outputDirectory).toBe('/my/output')
    })
  })

  describe('setOutputDirectory', () => {
    it('updates the output directory in settings', () => {
      useStore.getState().setOutputDirectory('/new/output/dir')

      expect(useStore.getState().settings.outputDirectory).toBe('/new/output/dir')
    })

    it('preserves resolution when changing output directory', () => {
      const initialRes = useStore.getState().settings.resolution
      useStore.getState().setOutputDirectory('/new/dir')

      expect(useStore.getState().settings.resolution).toEqual(initialRes)
    })
  })

  // -------------------------------------------------------------------------
  // setHookText
  // -------------------------------------------------------------------------
  describe('setHookText', () => {
    it('sets text overlay for a specific clip ID', () => {
      useStore.getState().setHookText('clip-1', 'Buy Now!')

      expect(useStore.getState().hookTexts['clip-1']).toBe('Buy Now!')
    })

    it('can set text for multiple clips independently', () => {
      useStore.getState().setHookText('clip-1', 'Text A')
      useStore.getState().setHookText('clip-2', 'Text B')

      expect(useStore.getState().hookTexts['clip-1']).toBe('Text A')
      expect(useStore.getState().hookTexts['clip-2']).toBe('Text B')
    })

    it('overwrites previous text for the same clip ID', () => {
      useStore.getState().setHookText('clip-1', 'Old')
      useStore.getState().setHookText('clip-1', 'New')

      expect(useStore.getState().hookTexts['clip-1']).toBe('New')
    })
  })

  // -------------------------------------------------------------------------
  // addError / clearErrors
  // -------------------------------------------------------------------------
  describe('addError', () => {
    it('adds an entry with auto-generated id and timestamp', () => {
      const now = 1700000000000
      vi.spyOn(Date, 'now').mockReturnValue(now)

      useStore
        .getState()
        .addError({ source: 'caption', clipName: 'test.mp4', message: 'Failed' })

      const errors = useStore.getState().errorLog
      expect(errors).toHaveLength(1)
      expect(errors[0].id).toBe('mock-uuid-1234')
      expect(errors[0].timestamp).toBe(now)
      expect(errors[0].source).toBe('caption')
      expect(errors[0].clipName).toBe('test.mp4')
      expect(errors[0].message).toBe('Failed')

      vi.restoreAllMocks()
    })

    it('appends multiple errors', () => {
      useStore
        .getState()
        .addError({ source: 'caption', clipName: 'a.mp4', message: 'Error A' })
      useStore
        .getState()
        .addError({ source: 'render', clipName: 'b.mp4', message: 'Error B' })

      expect(useStore.getState().errorLog).toHaveLength(2)
    })
  })

  describe('clearErrors', () => {
    it('empties the error log', () => {
      useStore
        .getState()
        .addError({ source: 'caption', clipName: 'test.mp4', message: 'Fail' })
      useStore.getState().clearErrors()

      expect(useStore.getState().errorLog).toHaveLength(0)
    })

    it('does nothing when already empty', () => {
      useStore.getState().clearErrors()

      expect(useStore.getState().errorLog).toHaveLength(0)
    })
  })


  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------
  describe('reset', () => {
    it('returns all buckets and state to initial values', () => {
      // Populate everything
      useStore.getState().addClips('hook', [makeClip({ id: 'h1' })])
      useStore.getState().addClips('meat', [makeClip({ id: 'm1' })])
      useStore.getState().addClips('cta', [makeClip({ id: 'c1' })])
      useStore.getState().setHookText('h1', 'text')
      useStore.getState().setIsRendering(true)
      useStore
        .getState()
        .setRenderProgress([{ jobId: '1', percent: 50, status: 'rendering' }])
      useStore
        .getState()
        .addError({ source: 'render', clipName: 'test.mp4', message: 'err' })

      useStore.getState().reset()

      const state = useStore.getState()
      expect(state.hooks).toHaveLength(0)
      expect(state.meats).toHaveLength(0)
      expect(state.ctas).toHaveLength(0)
      expect(state.hookTexts).toEqual({})
      expect(state.renderProgress).toHaveLength(0)
      expect(state.isRendering).toBe(false)
      expect(state.errorLog).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // setRenderProgress / setIsRendering
  // -------------------------------------------------------------------------
  describe('setRenderProgress', () => {
    it('updates render progress array', () => {
      const progress = [
        { jobId: 'j1', percent: 50, status: 'rendering' as const },
        { jobId: 'j2', percent: 0, status: 'queued' as const }
      ]
      useStore.getState().setRenderProgress(progress)

      expect(useStore.getState().renderProgress).toEqual(progress)
    })

    it('can set to empty array', () => {
      useStore
        .getState()
        .setRenderProgress([{ jobId: 'j1', percent: 100, status: 'done' }])
      useStore.getState().setRenderProgress([])

      expect(useStore.getState().renderProgress).toHaveLength(0)
    })
  })

  describe('setIsRendering', () => {
    it('sets isRendering to true', () => {
      useStore.getState().setIsRendering(true)

      expect(useStore.getState().isRendering).toBe(true)
    })

    it('sets isRendering to false', () => {
      useStore.getState().setIsRendering(true)
      useStore.getState().setIsRendering(false)

      expect(useStore.getState().isRendering).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // setCaptionProgress
  // -------------------------------------------------------------------------
  describe('setCaptionProgress', () => {
    it('sets caption progress', () => {
      const progress = {
        stage: 'transcribing' as const,
        currentClip: 'video.mp4',
        completedClips: 1,
        totalClips: 3
      }
      useStore.getState().setCaptionProgress(progress)

      expect(useStore.getState().captionProgress).toEqual(progress)
    })

    it('can be set to null', () => {
      useStore.getState().setCaptionProgress({
        stage: 'done',
        currentClip: '',
        completedClips: 3,
        totalClips: 3
      })
      useStore.getState().setCaptionProgress(null)

      expect(useStore.getState().captionProgress).toBeNull()
    })
  })

  describe('project dirty state', () => {
    it('tracks imports, trims, and configuration changes across confirmed saves', async () => {
      const projectPath = '/tmp/campaign.batchedit'
      saveProjectFile.mockResolvedValue(projectPath)

      useStore.getState().addClips('hook', [makeClip()])
      expect(useStore.getState()).toMatchObject({ activeProjectPath: null, isDirty: true })

      await expect(useStore.getState().saveProject()).resolves.toBe(projectPath)
      expect(saveProjectFile).toHaveBeenLastCalledWith(expect.any(String), null)
      expect(useStore.getState()).toMatchObject({ activeProjectPath: projectPath, isDirty: false })

      useStore.getState().updateClipPath('hook', 'clip-1', '/path/to/trimmed.mp4', 3.5)
      expect(useStore.getState().isDirty).toBe(true)

      await expect(useStore.getState().saveProject()).resolves.toBe(projectPath)
      expect(saveProjectFile).toHaveBeenLastCalledWith(expect.any(String), projectPath)
      expect(useStore.getState().isDirty).toBe(false)

      useStore.getState().setResolution(RESOLUTIONS['1:1'])
      expect(useStore.getState().isDirty).toBe(true)
    })

    it('stays dirty when save is cancelled or project I/O fails', async () => {
      useStore.getState().addClips('hook', [makeClip()])
      await expect(useStore.getState().saveProject()).resolves.toBeNull()
      expect(useStore.getState()).toMatchObject({ activeProjectPath: null, isDirty: true })

      saveProjectFile.mockRejectedValueOnce(new Error('disk full'))
      await expect(useStore.getState().saveProject()).rejects.toThrow('disk full')
      expect(useStore.getState()).toMatchObject({ activeProjectPath: null, isDirty: true })
    })

    it('keeps newer edits dirty when they occur during a confirmed save', async () => {
      const projectPath = '/tmp/campaign.batchedit'
      let confirmSave: (path: string | null) => void = () => {
        throw new Error('Save resolver was not initialized')
      }
      saveProjectFile.mockImplementation(() => new Promise((resolve) => {
        confirmSave = resolve
      }))
      useStore.getState().addClips('hook', [makeClip()])

      const pendingSave = useStore.getState().saveProject()
      useStore.getState().setHookText('clip-1', 'Newer edit')
      confirmSave(projectPath)

      await expect(pendingSave).resolves.toBe(projectPath)
      expect(useStore.getState()).toMatchObject({ activeProjectPath: projectPath, isDirty: true })
    })

    it('sets the active path and clears dirty state only after a confirmed load', async () => {
      useStore.getState().addClips('hook', [makeClip({ id: 'old' })])
      loadProjectFile.mockResolvedValue({
        path: '/tmp/loaded.batchedit',
        data: JSON.stringify({
          version: 1, hooks: [makeClip({ id: 'loaded' })], meats: [], ctas: [], hookTexts: {}
        })
      })

      await expect(useStore.getState().loadProject()).resolves.toEqual({ ok: true, missingCount: 0 })
      expect(useStore.getState()).toMatchObject({ activeProjectPath: '/tmp/loaded.batchedit', isDirty: false })
      expect(useStore.getState().hooks.map((clip) => clip.id)).toEqual(['loaded'])
    })

    it('keeps app-managed generated media paths active after save and reload', async () => {
      const generatedPath =
        '/Users/test/Library/Application Support/BatchEdit/media/smart-split/run-1/Hook_1.mp4'
      const projectPath = '/Users/test/Documents/campaign.batchedit'
      let savedProjectData = ''
      saveProjectFile.mockImplementation(async (projectData) => {
        savedProjectData = projectData
        return projectPath
      })
      useStore.getState().addClips('hook', [makeClip({ path: generatedPath })])

      await useStore.getState().saveProject()
      useStore.getState().reset()
      loadProjectFile.mockResolvedValue({ path: projectPath, data: savedProjectData })

      await expect(useStore.getState().loadProject()).resolves.toEqual({ ok: true, missingCount: 0 })
      expect(pathsExist).toHaveBeenCalledWith([generatedPath])
      expect(useStore.getState().hooks[0]).toMatchObject({
        id: 'clip-1',
        path: generatedPath,
        missing: false
      })
    })

    it('checks clip and image-overlay dependencies when loading a project', async () => {
      const clipPath = '/media/missing-clip.mp4'
      const meatOverlayPath = '/media/missing-proof.png'
      const ctaOverlayPath = '/media/existing-proof.png'
      pathsExist.mockResolvedValue({ missing: [clipPath, meatOverlayPath] })
      loadProjectFile.mockResolvedValue({
        path: '/projects/campaign.batchedit',
        data: JSON.stringify({
          version: 1,
          hooks: [makeClip({ path: clipPath })],
          meats: [],
          ctas: [],
          hookTexts: {},
          mediaOverlays: { meat: meatOverlayPath, cta: ctaOverlayPath }
        })
      })

      await expect(useStore.getState().loadProject()).resolves.toEqual({ ok: true, missingCount: 2 })
      expect(pathsExist).toHaveBeenCalledWith([clipPath, ctaOverlayPath, meatOverlayPath].sort())
      expect(useStore.getState().hooks[0]?.missing).toBe(true)
      expect(useStore.getState().missingMediaOverlays).toEqual({ meat: true, cta: false })
    })

    it('relinks in place without losing project metadata or overlay association', () => {
      const transcript = [
        { text: 'keep', start: 0.25, end: 0.6 },
        { text: 'timing', start: 0.65, end: 1.2 }
      ]
      const targetClip = makeClip({
        id: 'target',
        path: '/missing/original.mp4',
        name: 'Original name',
        duration: 4,
        thumbnail: 'old-thumbnail',
        transcript,
        missing: true
      })
      useStore.setState({
        hooks: [makeClip({ id: 'before' }), targetClip, makeClip({ id: 'after' })],
        hookTexts: { target: 'Preserved hook text' },
        mediaOverlays: { meat: '/missing/proof.png', cta: '/media/cta.png' },
        missingMediaOverlays: { meat: true, cta: false },
        isDirty: false
      })

      useStore
        .getState()
        .updateClipPath('hook', 'target', '/replacement/relinked.mp4', 7.25, 'new-thumbnail')
      useStore.getState().setMediaOverlay('meat', '/replacement/proof.png')

      const state = useStore.getState()
      expect(state.hooks.map((clip) => clip.id)).toEqual(['before', 'target', 'after'])
      expect(state.hooks[1]).toEqual({
        ...targetClip,
        path: '/replacement/relinked.mp4',
        duration: 7.25,
        thumbnail: 'new-thumbnail',
        missing: false
      })
      expect(state.hooks[1]?.transcript).toEqual(transcript)
      expect(state.hookTexts.target).toBe('Preserved hook text')
      expect(state.mediaOverlays).toEqual({
        meat: '/replacement/proof.png',
        cta: '/media/cta.png'
      })
      expect(state.missingMediaOverlays).toEqual({ meat: false, cta: false })
      expect(state.isDirty).toBe(true)
    })

    it('does not mark runtime-only progress or user preferences dirty', () => {
      useStore.getState().setRenderProgress([{ jobId: 'job-1', percent: 10, status: 'rendering' }])
      useStore.getState().setCaptionProgress({
        stage: 'transcribing', currentClip: 'clip.mp4', completedClips: 0, totalClips: 1
      })
      useStore.getState().setGeminiApiKey('local-key')
      expect(useStore.getState().isDirty).toBe(false)
    })
  })

  describe('Whisper capability defaults', () => {
    beforeEach(() => {
      useStore.setState({
        whisperDevice: 'detecting',
        whisperModel: WASM_DEFAULT_WHISPER_MODEL,
        preferredWhisperModel: null
      })
    })

    it('selects Whisper Base after WASM capability detection', () => {
      useStore.getState().initializeWhisperDevice(WHISPER_DEVICE.WASM)

      expect(useStore.getState()).toMatchObject({
        whisperDevice: WHISPER_DEVICE.WASM,
        whisperModel: WASM_DEFAULT_WHISPER_MODEL
      })
    })

    it('selects the balanced WebGPU default without opting into Large', () => {
      useStore.getState().initializeWhisperDevice(WHISPER_DEVICE.WEBGPU)

      expect(useStore.getState().whisperModel).toBe(WEBGPU_DEFAULT_WHISPER_MODEL)
      expect(useStore.getState().whisperModel).not.toBe(LARGE_WHISPER_MODEL)
    })

    it('honors an explicit Large preference only when WebGPU is available', () => {
      useStore.setState({ preferredWhisperModel: LARGE_WHISPER_MODEL })

      useStore.getState().initializeWhisperDevice(WHISPER_DEVICE.WASM)
      expect(useStore.getState().whisperModel).toBe(WASM_DEFAULT_WHISPER_MODEL)

      useStore.getState().initializeWhisperDevice(WHISPER_DEVICE.WEBGPU)
      expect(useStore.getState().whisperModel).toBe(LARGE_WHISPER_MODEL)
    })
  })

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('has default 9:16 resolution', () => {
      const res = useStore.getState().settings.resolution
      expect(res.width).toBe(1080)
      expect(res.height).toBe(1920)
    })

    it('has no active project and no unsaved changes', () => {
      expect(useStore.getState()).toMatchObject({
        activeProjectPath: null,
        isDirty: false,
        settings: { outputDirectory: null }
      })
    })

    it('is not rendering initially', () => {
      expect(useStore.getState().isRendering).toBe(false)
    })

    it('has empty error log initially', () => {
      expect(useStore.getState().errorLog).toHaveLength(0)
    })
  })
})
