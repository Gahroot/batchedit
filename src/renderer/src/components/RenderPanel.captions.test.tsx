import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from '../store'
import { useStore } from '../store'
import { RenderPanel } from './RenderPanel'

const whisperMocks = vi.hoisted(() => ({
  loadModel: vi.fn(),
  transcribe: vi.fn(),
  cancel: vi.fn(() => true)
}))

vi.mock('@/hooks/useWhisper', () => ({
  useWhisper: () => ({
    loadModel: whisperMocks.loadModel,
    transcribe: whisperMocks.transcribe,
    cancel: whisperMocks.cancel,
    isModelLoading: false,
    isModelReady: false,
    isTranscribing: false,
    isBusy: false,
    loadProgress: 0,
    loadingModel: null,
    loadedModel: null
  })
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))
vi.mock('canvas-confetti', () => ({ default: vi.fn() }))
vi.mock('./CaptionStylePicker', () => ({ CaptionStylePicker: () => null }))
vi.mock('./WhisperModelControl', () => ({ WhisperModelControl: () => null }))
vi.mock('./WhisperStatus', () => ({ WhisperStatus: () => null }))
vi.mock('./ErrorLog', () => ({ ErrorLog: () => null }))
vi.mock('./PermutationMatrix', () => ({ PermutationMatrix: () => null }))
vi.mock('@/components/ui/shimmer-button', () => ({
  ShimmerButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))
vi.mock('@/components/ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>
}))

vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
)

const initialState = useStore.getState()
type SubmittedRenderJob = Parameters<Window['api']['renderBatch']>[0][number]

function clip(id: string, name: string, path: string): Clip {
  return {
    id,
    name,
    path,
    duration: 1,
    thumbnail: '',
    missing: false
  }
}

const hook = clip('hook-1', 'Hook.mp4', '/clips/hook.mp4')
const meatA = clip('meat-1', 'Meat A.mp4', '/clips/meat-a.mp4')
const meatB = clip('meat-2', 'Meat B.mp4', '/clips/meat-b.mp4')
const cta = clip('cta-1', 'CTA.mp4', '/clips/cta.mp4')

const renderBatchMock = vi.fn(async (jobs: SubmittedRenderJob[]) =>
  jobs.map((job) => ({ jobId: job.id, percent: 100, status: 'done' as const }))
)
const createRenderBatchDirectoryMock = vi.fn(async () => '/output/BatchEdit 2026-08-08 120000')
const extractAudioMock = vi.fn(async (path: string) => `${path}.wav`)

function installApi(): void {
  const api = {
    onRenderProgress: vi.fn(() => () => undefined),
    getDefaultOutputDirectory: vi.fn(async () => null),
    openDirectory: vi.fn(async () => null),
    pathsExist: vi.fn(async () => ({ missing: [] })),
    getSourceFileSignatures: vi.fn(async (paths: string[]) => ({
      signatures: paths.map((path) => ({ path, size: 1_000, mtimeMs: 100 })),
      unavailable: []
    })),
    extractAudio: extractAudioMock,
    readAudioBuffer: vi.fn(async (wavPath: string) => {
      const clipCode = wavPath.includes('meat-b') ? 2 : 1
      return new Float32Array([clipCode]).buffer
    }),
    releaseTempFile: vi.fn(async () => undefined),
    createRenderBatchDirectory: createRenderBatchDirectoryMock,
    renderBatch: renderBatchMock,
    cancelRender: vi.fn(async () => true),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => '')
  }
  window.api = api as unknown as Window['api']
}

function enableCaptionsAndRender(): void {
  const autoCaptionSwitch = screen.getAllByRole('switch').at(0)
  if (autoCaptionSwitch === undefined) throw new Error('Auto Captions switch was not rendered')
  fireEvent.click(autoCaptionSwitch)
  fireEvent.click(screen.getByRole('button', { name: /Render \d+ Videos/i }))
}

beforeEach(() => {
  useStore.setState(
    {
      ...initialState,
      hooks: [hook],
      meats: [meatA, meatB],
      ctas: [cta],
      settings: {
        ...initialState.settings,
        outputDirectory: '/output'
      },
      whisperDevice: 'wasm',
      renderProgress: [],
      captionProgress: null,
      errorLog: [],
      isRendering: false
    },
    true
  )
  whisperMocks.loadModel.mockReset().mockResolvedValue(undefined)
  whisperMocks.transcribe.mockReset().mockResolvedValue({
    text: 'hello',
    chunks: [{ text: 'hello', start: 0, end: 0.5 }]
  })
  whisperMocks.cancel.mockClear()
  renderBatchMock.mockClear()
  createRenderBatchDirectoryMock.mockClear()
  extractAudioMock.mockClear()
  installApi()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RenderPanel Auto Captions gate', () => {
  it('blocks render and reports all filenames when the model fails to load', async () => {
    useStore.setState({ meats: [meatA] })
    whisperMocks.loadModel.mockRejectedValueOnce(new Error('model download unavailable'))

    render(<RenderPanel />)
    enableCaptionsAndRender()

    expect(
      await screen.findByRole('heading', { name: 'Auto Captions need attention' })
    ).toBeTruthy()
    expect(
      screen.getByText(
        '0 of 3 required clips transcribed successfully. 3 failed: CTA.mp4, Hook.mp4, Meat A.mp4.'
      )
    ).toBeTruthy()
    expect(screen.getByText(/All 1 output will render without captions\./)).toBeTruthy()
    expect(extractAudioMock).not.toHaveBeenCalled()
    expect(createRenderBatchDirectoryMock).not.toHaveBeenCalled()
    expect(renderBatchMock).not.toHaveBeenCalled()
  })

  it('requires explicit continuation and omits captions only from affected outputs', async () => {
    whisperMocks.transcribe.mockImplementation(async (audio: Float32Array) => {
      if (audio[0] === 2) throw new Error('decoder crashed')
      return { text: 'hello', chunks: [{ text: 'hello', start: 0, end: 0.5 }] }
    })

    render(<RenderPanel />)
    enableCaptionsAndRender()

    expect(
      await screen.findByText(
        '3 of 4 required clips transcribed successfully. 1 failed: Meat B.mp4.'
      )
    ).toBeTruthy()
    expect(
      screen.getByText(/1 of 2 outputs will render without captions; 1 will keep captions\./)
    ).toBeTruthy()
    expect(screen.getByText('Hook_Meat B_CTA_2.mp4')).toBeTruthy()
    expect(renderBatchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without Captions' }))

    await waitFor(() => expect(renderBatchMock).toHaveBeenCalledTimes(1))
    const submittedJobs = renderBatchMock.mock.calls[0]?.[0]
    expect(submittedJobs).toHaveLength(2)
    const captionedJob = submittedJobs?.find((job) => job.outputPath.includes('Meat A'))
    const affectedJob = submittedJobs?.find((job) => job.outputPath.includes('Meat B'))
    expect(captionedJob?.captionData).toBeDefined()
    expect(affectedJob?.captionData).toBeUndefined()
  })

  it('retries only the failed clip and submits every job after retry success', async () => {
    let failedClipAttempts = 0
    whisperMocks.transcribe.mockImplementation(async (audio: Float32Array) => {
      if (audio[0] === 2) {
        failedClipAttempts += 1
        if (failedClipAttempts === 1) throw new Error('temporary decoder failure')
      }
      return { text: 'hello', chunks: [{ text: 'hello', start: 0, end: 0.5 }] }
    })

    render(<RenderPanel />)
    enableCaptionsAndRender()
    expect(await screen.findByText(/1 failed: Meat B\.mp4\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry Failed Clips' }))

    await waitFor(() => expect(renderBatchMock).toHaveBeenCalledTimes(1))
    expect(extractAudioMock).toHaveBeenCalledTimes(5)
    expect(
      extractAudioMock.mock.calls.filter(([path]) => path === '/clips/meat-b.mp4')
    ).toHaveLength(2)
    const submittedJobs = renderBatchMock.mock.calls[0]?.[0] ?? []
    expect(submittedJobs).toHaveLength(2)
    expect(submittedJobs.every((job) => job.captionData !== undefined)).toBe(true)
  })
})
